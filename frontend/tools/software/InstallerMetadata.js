import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, checkCancellation } from '../ExecutionContext.js';
import { powerShellPath } from '../DesktopRuntime.js';
import { signerPublisher, softwareFailure } from './TrustPolicy.js';

export const INSTALLER_FORMATS = Object.freeze([
  'exe',
  'msi',
  'msix',
  'appx',
  'msixbundle',
  'appxbundle',
  'iso',
]);
export async function installerHash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    checkCancellation();
    digest.update(chunk);
  }
  return digest.digest('hex');
}

// Fixed, application-owned code. Paths are environment data. XML parsers prohibit DTDs; archives are read, never extracted or executed.
export const METADATA_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$file=$env:CHANAKYA_SOFTWARE_FILE
$format=$env:CHANAKYA_SOFTWARE_FORMAT
$signature=Get-AuthenticodeSignature -LiteralPath $file
$result=[ordered]@{format=$format;status=[string]$signature.Status;signerSubject='';signerThumbprint='';productName='';productVersion='';manufacturer='';packageIdentity='';architecture='unknown';minimumWindowsVersion='';elevation='unknown';dependencies=@();capabilities=@();restrictedCapabilities=@();inspectionIncomplete=$false}
if($signature.SignerCertificate){$result.signerSubject=[string]$signature.SignerCertificate.Subject;$result.signerThumbprint=[string]$signature.SignerCertificate.Thumbprint}
function Read-SafeXml($stream){
  $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$settings.MaxCharactersInDocument=4194304
  $reader=[Xml.XmlReader]::Create($stream,$settings)
  try{$xml=[Xml.XmlDocument]::new();$xml.XmlResolver=$null;$xml.Load($reader);return $xml}finally{$reader.Dispose()}
}
function Read-PackageManifest($archive){
  $entry=$archive.GetEntry('AppxManifest.xml');if(!$entry -or $entry.Length -gt 4194304){throw 'Package manifest is missing or too large'}
  $stream=$entry.Open();try{$xml=Read-SafeXml $stream}finally{$stream.Dispose()}
  $identity=$xml.SelectSingleNode('/*[local-name()="Package"]/*[local-name()="Identity"]')
  if(!$identity){throw 'Package identity missing'}
  $display=$xml.SelectSingleNode('/*[local-name()="Package"]/*[local-name()="Properties"]/*[local-name()="DisplayName"]')
  $name=[string]$identity.Name;if($display -and $display.InnerText -and $display.InnerText -notmatch '^ms-resource:'){$name=$display.InnerText}
  $deps=@($xml.SelectNodes('//*[local-name()="Dependencies"]/*[local-name()="PackageDependency"]')|ForEach-Object{[pscustomobject]@{name=[string]$_.Name;publisher=[string]$_.Publisher;minimumVersion=[string]$_.MinVersion;architecture=[string]$_.ProcessorArchitecture}})
  $families=@($xml.SelectNodes('//*[local-name()="TargetDeviceFamily"]'))
  $caps=@($xml.SelectNodes('//*[local-name()="Capabilities"]/*')|ForEach-Object{[string]$_.Name})
  $restricted=@($xml.SelectNodes('//*[local-name()="Capabilities"]/*')|Where-Object{$_.NamespaceURI -match '/restrictedcapabilities'}|ForEach-Object{[string]$_.Name})
  return [pscustomobject]@{productName=$name;productVersion=[string]$identity.Version;packageIdentity=[string]$identity.Name;manifestPublisher=[string]$identity.Publisher;architecture=[string]$identity.ProcessorArchitecture;dependencies=$deps;capabilities=$caps;restrictedCapabilities=$restricted;minimumWindowsVersion=$(if($families.Count){[string]$families[0].MinVersion}else{''})}
}
if($format -eq 'msi'){
  $installer=$null;$database=$null
  try{
    $installer=New-Object -ComObject WindowsInstaller.Installer
    $database=$installer.GetType().InvokeMember('OpenDatabase','InvokeMethod',$null,$installer,@($file,0))
    function Read-MsiProperty($name){
      $view=$null;$record=$null
      try{
        $view=$database.GetType().InvokeMember('OpenView','InvokeMethod',$null,$database,@(('SELECT '+[char]96+'Value'+[char]96+' FROM '+[char]96+'Property'+[char]96+' WHERE '+[char]96+'Property'+[char]96+" = '"+$name+"'")))
        $view.GetType().InvokeMember('Execute','InvokeMethod',$null,$view,$null)|Out-Null
        $record=$view.GetType().InvokeMember('Fetch','InvokeMethod',$null,$view,$null)
        if($record){return [string]$record.GetType().InvokeMember('StringData','GetProperty',$null,$record,@(1))};return ''
      }finally{if($record){[Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)|Out-Null};if($view){$view.GetType().InvokeMember('Close','InvokeMethod',$null,$view,$null)|Out-Null;[Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)|Out-Null}}
    }
    $result.productName=Read-MsiProperty 'ProductName';$result.productVersion=Read-MsiProperty 'ProductVersion';$result.manufacturer=Read-MsiProperty 'Manufacturer';$result.packageIdentity=Read-MsiProperty 'ProductCode'
    $allUsers=Read-MsiProperty 'ALLUSERS';$result.elevation=$(if($allUsers -eq '1'){'administrator'}else{'unknown'})
    $summary=$database.GetType().InvokeMember('SummaryInformation','GetProperty',$null,$database,@(0))
    try{$template=[string]$summary.GetType().InvokeMember('Property','GetProperty',$null,$summary,@(7));$result.architecture=switch -Regex ($template.Split(';')[0]){'^Intel$'{'x86'};'^x64$'{'x64'};'^Arm64$'{'arm64'};default{'unknown'}}}finally{[Runtime.InteropServices.Marshal]::FinalReleaseComObject($summary)|Out-Null}
  }finally{if($database){[Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)|Out-Null};if($installer){[Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)|Out-Null}}
}elseif($format -in @('appx','msix','appxbundle','msixbundle')){
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive=[IO.Compression.ZipFile]::OpenRead($file)
  try{
    if($format -in @('appx','msix')){
      $manifest=Read-PackageManifest $archive;foreach($key in @('productName','productVersion','packageIdentity','architecture','dependencies','capabilities','restrictedCapabilities','minimumWindowsVersion')){$result[$key]=$manifest.$key};$result.manufacturer=$manifest.manifestPublisher;$result.elevation='user'
    }else{
      $entry=$archive.GetEntry('AppxMetadata/AppxBundleManifest.xml');if(!$entry -or $entry.Length -gt 4194304){throw 'Bundle manifest is missing or too large'}
      $stream=$entry.Open();try{$xml=Read-SafeXml $stream}finally{$stream.Dispose()}
      $identity=$xml.SelectSingleNode('/*[local-name()="Bundle"]/*[local-name()="Identity"]');if(!$identity){throw 'Bundle identity missing'}
      $result.productName=[string]$identity.Name;$result.packageIdentity=[string]$identity.Name;$result.productVersion=[string]$identity.Version;$result.manufacturer=[string]$identity.Publisher;$result.architecture='neutral';$result.elevation='user'
      # Outer manifests do not declare nested restricted capabilities or dependencies. Refuse execution until a capable native inspection adapter supplies them.
      $result.inspectionIncomplete=$true
      $result.bundlePackages=@($xml.SelectNodes('//*[local-name()="Packages"]/*[local-name()="Package"]')|ForEach-Object{[pscustomobject]@{fileName=[string]$_.FileName;architecture=[string]$_.Architecture;version=[string]$_.Version;type=[string]$_.Type}})
    }
  }finally{$archive.Dispose()}
}elseif($format -eq 'exe'){
  $version=(Get-Item -LiteralPath $file).VersionInfo;$result.productName=[string]$version.ProductName;$result.productVersion=[string]$version.ProductVersion;$result.manufacturer=[string]$version.CompanyName
  $stream=[IO.File]::OpenRead($file);$reader=[IO.BinaryReader]::new($stream)
  try{if($reader.ReadUInt16() -ne 0x5A4D){throw 'Invalid PE header'};$stream.Position=0x3c;$offset=$reader.ReadInt32();if($offset -lt 0 -or $offset+6 -gt $stream.Length){throw 'Invalid PE offset'};$stream.Position=$offset;if($reader.ReadUInt32() -ne 0x4550){throw 'Invalid PE signature'};$machine=$reader.ReadUInt16();$result.architecture=switch($machine){332{'x86'};34404{'x64'};43620{'arm64'};default{'unknown'}}}finally{$reader.Dispose()}
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ChanakyaManifest {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string f, IntPtr h, uint flags);
 [DllImport("kernel32.dll", EntryPoint="FindResourceW", SetLastError=true)] static extern IntPtr FindResource(IntPtr h, IntPtr name, IntPtr type);
 [DllImport("kernel32.dll")] static extern IntPtr LoadResource(IntPtr h, IntPtr r);
 [DllImport("kernel32.dll")] static extern uint SizeofResource(IntPtr h, IntPtr r);
 [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr r);
 [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr h);
 public static byte[] Read(string file) { var h=LoadLibraryEx(file,IntPtr.Zero,34); if(h==IntPtr.Zero)return null; try {for(int id=1;id<=3;id++){var r=FindResource(h,new IntPtr(id),new IntPtr(24));if(r==IntPtr.Zero)continue;var n=SizeofResource(h,r);if(n==0 || n>4194304)throw new Exception("Manifest too large");var p=LockResource(LoadResource(h,r));var b=new byte[n];Marshal.Copy(p,b,0,(int)n);return b;}return null;}finally{FreeLibrary(h);} }
}
'@
  $manifest=[ChanakyaManifest]::Read($file)
  if($manifest){$stream=[IO.MemoryStream]::new($manifest);try{$xml=Read-SafeXml $stream;$level=$xml.SelectSingleNode('//*[local-name()="requestedExecutionLevel"]');if($level){$result.elevation=[string]$level.level}}finally{$stream.Dispose()}}
}
$result|ConvertTo-Json -Depth 8 -Compress
`;

export function runMetadataScript(file, format) {
  return new Promise((resolve, reject) => {
    let output = '',
      errors = '',
      timedOut = false;
    const child = spawn(
      powerShellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', METADATA_SCRIPT],
      {
        windowsHide: true,
        env: {
          ...process.env,
          PSModulePath: path.join(path.dirname(powerShellPath()), 'Modules'),
          CHANAKYA_SOFTWARE_FILE: file,
          CHANAKYA_SOFTWARE_FORMAT: format,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60000);
    child.stdout.on('data', (chunk) => {
      if (output.length < 2_000_000) output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (errors.length < 8000) errors += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0)
        return reject(
          softwareFailure(
            'INSTALLER_INSPECTION_FAILED',
            timedOut
              ? 'Installer inspection timed out.'
              : 'Windows could not inspect this installer safely.',
          ),
        );
      try {
        resolve(JSON.parse(output.trim()));
      } catch {
        reject(
          softwareFailure(
            'INSTALLER_INSPECTION_FAILED',
            'Windows returned invalid installer metadata.',
          ),
        );
      }
    });
  });
}

export async function inspectInstaller(
  file,
  format = path.extname(file).slice(1).toLowerCase(),
  { run = runMetadataScript } = {},
) {
  checkCancellation();
  if (!INSTALLER_FORMATS.includes(format) || path.extname(file).slice(1).toLowerCase() !== format)
    throw softwareFailure(
      'UNSUPPORTED_INSTALLER',
      'The installer extension must match a supported declared format.',
    );
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 4)
    throw softwareFailure('INVALID_INSTALLER', 'A regular, nonempty installer file is required.');
  const sha256 = await installerHash(file);
  if (format === 'iso')
    return {
      format,
      size: stat.size,
      sha256,
      status: 'NotApplicable',
      architecture: 'unknown',
      dependencies: [],
      capabilities: [],
    };
  const metadata = await run(file, format);
  const publisher = signerPublisher(metadata.signerSubject || metadata.signer);
  return {
    ...metadata,
    format,
    size: stat.size,
    sha256,
    publisher,
    signature: {
      status: metadata.status,
      signer: metadata.signerSubject || metadata.signer || '',
      publisher,
      thumbprint: metadata.signerThumbprint || '',
    },
    privileges: ['requireAdministrator', 'administrator'].includes(metadata.elevation)
      ? 'administrator'
      : metadata.elevation === 'asInvoker' || metadata.elevation === 'user'
        ? 'user'
        : 'unknown',
    name: metadata.productName,
    version: metadata.productVersion,
    productId: metadata.packageIdentity || metadata.productName,
  };
}

export const INVENTORY_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$items=[Collections.Generic.List[object]]::new()
foreach($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')){
  if(Test-Path -LiteralPath $root){foreach($entry in @(Get-ItemProperty -Path ($root+'\*') -ErrorAction SilentlyContinue)){if($entry.DisplayName -and !$entry.SystemComponent){$items.Add([pscustomobject]@{name=[string]$entry.DisplayName;publisher=[string]$entry.Publisher;version=[string]$entry.DisplayVersion;packageIdentity=[string]$entry.PSChildName;available=$true})}}}
}
foreach($package in @(Get-AppxPackage -ErrorAction Stop)){$items.Add([pscustomobject]@{name=[string]$package.Name;publisher=[string]$package.Publisher;version=[string]$package.Version;packageIdentity=[string]$package.Name;packageFamilyName=[string]$package.PackageFamilyName;architecture=[string]$package.Architecture;available=$true})}
[pscustomobject]@{apps=$items.ToArray()}|ConvertTo-Json -Depth 4 -Compress
`;

/** Independently reads Windows installer/uninstall registration and MSIX deployment state; no fuzzy launcher aliases. */
export function installedSoftwareInventory() {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(
      powerShellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', INVENTORY_SCRIPT],
      {
        windowsHide: true,
        env: { ...process.env, PSModulePath: path.join(path.dirname(powerShellPath()), 'Modules') },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', (chunk) => {
      if (output.length < 4000000) output += chunk.toString('utf8');
    });
    child.stderr.resume();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(
          softwareFailure(
            'INVENTORY_UNAVAILABLE',
            'Windows could not independently inspect installed software.',
          ),
        );
      try {
        const items = JSON.parse(output.trim()).apps;
        if (!Array.isArray(items)) throw new Error();
        resolve(
          items.map((item) => ({
            ...item,
            publisher: /^(?:CN|O)=/.test(item.publisher)
              ? signerPublisher(item.publisher)
              : item.publisher,
          })),
        );
      } catch {
        reject(
          softwareFailure(
            'INVENTORY_UNAVAILABLE',
            'Windows returned invalid installed software inventory.',
          ),
        );
      }
    });
  });
}
