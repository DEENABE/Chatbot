$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$mutex=[Threading.Mutex]::new($false,'Local\ChanakyaDesktopAutomation');$owned=$false
try {
  $owned=$mutex.WaitOne(0);if(!$owned){throw 'UI_BUSY'}
  $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName Accessibility
  Add-Type -Path (Join-Path $PSScriptRoot 'DesktopAccessibility.cs') -ReferencedAssemblies @('System.dll','System.Core.dll',[Windows.Automation.AutomationElement].Assembly.Location,[Windows.Automation.ControlType].Assembly.Location,[Windows.Rect].Assembly.Location,[Accessibility.IAccessible].Assembly.Location)
  if($r.action -eq 'observe'){
    $result=[DesktopAccessibility]::Read([string]$r.executablePath,[string]$r.appUserModelId,[long]$r.windowId,[bool]$r.focus,[int]$r.processId)
  }elseif($r.action -eq 'act'){
    $result=[DesktopAccessibility]::Act([string]$r.executablePath,[string]$r.appUserModelId,[long]$r.windowId,[string]$r.screenFingerprint,[string]$r.locator,[string]$r.signature,[string]$r.operation,[string]$r.value)
  }elseif($r.action -eq 'input'){
    $result=[DesktopAccessibility]::Input([string]$r.executablePath,[string]$r.appUserModelId,[long]$r.windowId,[string]$r.kind,[string]$r.payload)
  }else{throw 'UNSUPPORTED_ACTION'}
  $result|ConvertTo-Json -Depth 7 -Compress
}catch{$reason=$_.Exception.GetBaseException().Message;if($reason -notmatch '^[A-Z_]+$'){$reason='UI_INSPECTION_FAILED'};@{success=$false;code=$reason;message=$reason}|ConvertTo-Json -Compress}
finally{if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()}
