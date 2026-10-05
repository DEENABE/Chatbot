param([Parameter(Mandatory=$true)][ValidateSet('inspect','start','verify')][string]$Operation)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.ServiceProcess
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SpoolerAccess {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr OpenSCManager(string machine,string db,uint access);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr OpenService(IntPtr scm,string name,uint access);
 [DllImport("advapi32.dll")] public static extern bool CloseServiceHandle(IntPtr handle);
}
'@
function Get-SpoolerEvidence {
 $service = New-Object System.ServiceProcess.ServiceController('Spooler','.')
 try {
  $service.Refresh()
  $config = Get-CimInstance -ClassName Win32_Service -Filter "Name='Spooler'"
  if ($null -eq $config) { throw 'SERVICE_NOT_FOUND' }
  $deps = @($service.ServicesDependedOn | Sort-Object ServiceName)
  $depsRunning = $true
  foreach ($dep in $deps) { $dep.Refresh(); if ([int]$dep.Status -ne 4) { $depsRunning=$false }; $dep.Dispose() }
  $depNames = @($service.ServicesDependedOn | ForEach-Object { $_.ServiceName } | Sort-Object)
  $binary = [Environment]::ExpandEnvironmentVariables($config.PathName).Trim('"')
  $expectedBinary = [IO.Path]::Combine([Environment]::GetFolderPath('Windows'),'System32','spoolsv.exe')
  $stock = $binary.Equals($expectedBinary,[StringComparison]::OrdinalIgnoreCase) -and $config.StartName -eq 'LocalSystem'
  $configText = [string]::Join('|',@($config.PathName,$config.StartMode,$config.StartName,($depNames -join ',')))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($configText)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  $scm=[SpoolerAccess]::OpenSCManager($null,$null,1)
  $canStart=$false
  if($scm -ne [IntPtr]::Zero) {
   try { $handle=[SpoolerAccess]::OpenService($scm,'Spooler',0x15); if($handle -ne [IntPtr]::Zero) { $canStart=$true; [void][SpoolerAccess]::CloseServiceHandle($handle) } }
   finally { [void][SpoolerAccess]::CloseServiceHandle($scm) }
  }
  $boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
  $hostId=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
  return @{platform='win32';name='Spooler';hostId=$hostId;bootId=$boot;configHash=$digest;status=[int]$service.Status;startType=[int]$service.StartType;stock=[bool]$stock;canStart=$canStart;dependenciesRunning=$depsRunning;observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
 } finally { $service.Dispose() }
}
function Assert-Expected($actual,$expected) {
 foreach($key in @('hostId','bootId','configHash')) { if($actual[$key] -ne $expected.$key) { throw 'PRECONDITION_CHANGED' } }
}
if($Operation -eq 'inspect') { Get-SpoolerEvidence | ConvertTo-Json -Compress; exit 0 }
$expected = [Console]::In.ReadToEnd() | ConvertFrom-Json
$before=Get-SpoolerEvidence
Assert-Expected $before $expected
if($Operation -eq 'start') {
 if(!$before.stock -or !$before.canStart -or !$before.dependenciesRunning -or $before.startType -ne 2) { throw 'PRECONDITION_FAILED' }
 if($before.status -eq 4) { @{startDisposition='not_dispatched';alreadyRunning=$true} | ConvertTo-Json -Compress; exit 0 }
 if($before.status -ne 1) { throw 'SERVICE_NOT_STOPPED' }
 $service=New-Object System.ServiceProcess.ServiceController('Spooler','.')
 try {
  # The only mutation in this artifact. No arguments, fallback, restart or retry.
  $service.Start()
  @{startDisposition='accepted'} | ConvertTo-Json -Compress
 } catch {
  $inner=$_.Exception
  while($inner.InnerException) { $inner=$inner.InnerException }
  if($inner -is [ComponentModel.Win32Exception] -and $inner.NativeErrorCode -in @(5,1056,1058,1060,1068,1069,1072)) {
   @{startDisposition=$(if($inner.NativeErrorCode -eq 1056){'not_dispatched'}else{'rejected'});nativeErrorCode=$inner.NativeErrorCode} | ConvertTo-Json -Compress
  } else { throw }
 } finally { $service.Dispose() }
 exit 0
}
$watch=[Diagnostics.Stopwatch]::StartNew()
$samples=@()
while($watch.ElapsedMilliseconds -lt 14000) {
 $s=Get-SpoolerEvidence
 Assert-Expected $s $expected
 if($s.status -eq 4) {
  if($samples.Count -eq 0) { $samples=@($s) }
  elseif($s.observedAt - $samples[0].observedAt -ge 1000) { $samples+= $s; break }
 } else { $samples=@() }
 Start-Sleep -Milliseconds 250
}
@{samples=@($samples)} | ConvertTo-Json -Depth 5 -Compress
