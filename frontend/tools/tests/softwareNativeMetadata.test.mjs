import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectInstaller } from '../software/InstallerMetadata.js';
import { powerShellPath } from '../DesktopRuntime.js';

const enabled = process.platform === 'win32' && process.env.CHANAKYA_NATIVE_METADATA_TEST === '1';
const msiScript = String.raw`
$ErrorActionPreference='Stop'
$installer=New-Object -ComObject WindowsInstaller.Installer
$database=$installer.GetType().InvokeMember('OpenDatabase','InvokeMethod',$null,$installer,@($env:CHANAKYA_FIXTURE_FILE,3))
$sql='CREATE TABLE '+[char]96+'Property'+[char]96+' ('+[char]96+'Property'+[char]96+' CHAR(72) NOT NULL, '+[char]96+'Value'+[char]96+' CHAR(0) LOCALIZABLE PRIMARY KEY '+[char]96+'Property'+[char]96+')'
$view=$database.GetType().InvokeMember('OpenView','InvokeMethod',$null,$database,@($sql));$view.GetType().InvokeMember('Execute','InvokeMethod',$null,$view,$null)|Out-Null;$view.GetType().InvokeMember('Close','InvokeMethod',$null,$view,$null)|Out-Null
foreach($item in @(@('ProductName','Native Metadata Fixture'),@('ProductVersion','2.1.0'),@('Manufacturer','Fixture Publisher'),@('ProductCode','{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}'),@('ALLUSERS','1'))){
 $sql='INSERT INTO '+[char]96+'Property'+[char]96+' ('+[char]96+'Property'+[char]96+', '+[char]96+'Value'+[char]96+') VALUES (?, ?)'
 $view=$database.GetType().InvokeMember('OpenView','InvokeMethod',$null,$database,@($sql));$record=$installer.GetType().InvokeMember('CreateRecord','InvokeMethod',$null,$installer,@(2))
 $record.GetType().InvokeMember('StringData','SetProperty',$null,$record,@(1,$item[0]))|Out-Null;$record.GetType().InvokeMember('StringData','SetProperty',$null,$record,@(2,$item[1]))|Out-Null
 $view.GetType().InvokeMember('Execute','InvokeMethod',$null,$view,@($record))|Out-Null;$view.GetType().InvokeMember('Close','InvokeMethod',$null,$view,$null)|Out-Null
 [Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)|Out-Null;[Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)|Out-Null
}
$summary=$database.GetType().InvokeMember('SummaryInformation','GetProperty',$null,$database,@(5));$summary.GetType().InvokeMember('Property','SetProperty',$null,$summary,@(7,'x64;1033'))|Out-Null;$summary.GetType().InvokeMember('Persist','InvokeMethod',$null,$summary,$null)|Out-Null
$database.GetType().InvokeMember('Commit','InvokeMethod',$null,$database,$null)|Out-Null
[Runtime.InteropServices.Marshal]::FinalReleaseComObject($summary)|Out-Null;[Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)|Out-Null;[Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)|Out-Null
`;
const archiveScript = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::Open($env:CHANAKYA_FIXTURE_FILE,[IO.Compression.ZipArchiveMode]::Create)
try{
 $entry=$archive.CreateEntry('AppxManifest.xml');$stream=$entry.Open();$writer=[IO.StreamWriter]::new($stream,[Text.UTF8Encoding]::new($false))
 try{$writer.Write($env:CHANAKYA_FIXTURE_XML)}finally{$writer.Dispose()}
}finally{$archive.Dispose()}
`;
function nativeFixture(script, file, xml) {
  const r = spawnSync(powerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: {
      ...process.env,
      PSModulePath: path.join(path.dirname(powerShellPath()), 'Modules'),
      CHANAKYA_FIXTURE_FILE: file,
      CHANAKYA_FIXTURE_XML: xml || '',
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
}
test(
  'native readonly MSI metadata comes from Windows Installer database, not PE VersionInfo',
  { skip: !enabled },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-native-msi-'));
    try {
      const file = path.join(root, 'fixture.msi');
      nativeFixture(msiScript, file);
      const metadata = await inspectInstaller(file, 'msi');
      assert.equal(metadata.productName, 'Native Metadata Fixture');
      assert.equal(metadata.productVersion, '2.1.0');
      assert.equal(metadata.manufacturer, 'Fixture Publisher');
      assert.equal(metadata.packageIdentity, '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}');
      assert.equal(metadata.architecture, 'x64');
      assert.equal(metadata.privileges, 'administrator');
      assert.notEqual(metadata.status, 'Valid');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
test(
  'native readonly MSIX manifest exposes exact identity, architecture, dependencies and restricted capabilities',
  { skip: !enabled },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-native-msix-'));
    try {
      const file = path.join(root, 'fixture.msix');
      nativeFixture(
        archiveScript,
        file,
        '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"><Identity Name="Unknown.MetadataFixture" Publisher="CN=Fixture Publisher" Version="2.1.0.0" ProcessorArchitecture="x64"/><Properties><DisplayName>Native Metadata Fixture</DisplayName></Properties><Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.22631.0"/><PackageDependency Name="Unknown.Framework" Publisher="CN=Fixture Publisher" MinVersion="4.0.0.0"/></Dependencies><Capabilities><rescap:Capability Name="runFullTrust"/></Capabilities></Package>',
      );
      const metadata = await inspectInstaller(file, 'msix');
      assert.equal(metadata.productName, 'Native Metadata Fixture');
      assert.equal(metadata.packageIdentity, 'Unknown.MetadataFixture');
      assert.equal(metadata.productVersion, '2.1.0.0');
      assert.equal(metadata.architecture, 'x64');
      assert.equal(metadata.minimumWindowsVersion, '10.0.19041.0');
      assert.equal(metadata.dependencies[0].name, 'Unknown.Framework');
      assert.deepEqual(metadata.restrictedCapabilities, ['runFullTrust']);
      assert.notEqual(metadata.status, 'Valid');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
