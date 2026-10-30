$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$mutex=[Threading.Mutex]::new($false,'Local\ChanakyaDesktopAutomation');$owned=$false
$stage='mutex'
try {
  try{$owned=$mutex.WaitOne(4000)}catch{if($_.Exception.GetBaseException() -is [Threading.AbandonedMutexException]){$owned=$true}else{throw}};if(!$owned){throw 'UI_BUSY'}
  $stage='request'
  $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
  $stage='compile'
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName Accessibility
  Add-Type -AssemblyName System.Drawing
  $source=Join-Path $PSScriptRoot 'DesktopAccessibility.cs'
  $references=@('System.dll','System.Core.dll',[Drawing.Bitmap].Assembly.Location,[Windows.Automation.AutomationElement].Assembly.Location,[Windows.Automation.ControlType].Assembly.Location,[Windows.Rect].Assembly.Location,[Accessibility.IAccessible].Assembly.Location)
  # The library name carries the source hash, so an updated .cs never loads an old build. Any cache problem falls back to
  # compiling in memory exactly as before.
  $loaded=$false
  try{
    $cache=Join-Path $env:LOCALAPPDATA 'Chanakya\desktop-control'
    $library=Join-Path $cache ('DesktopAccessibility-'+(Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.Substring(0,24)+'.dll')
    if(!(Test-Path -LiteralPath $library)){
      New-Item -ItemType Directory -Force -Path $cache | Out-Null
      Get-ChildItem -LiteralPath $cache -Filter '*.tmp' -ErrorAction SilentlyContinue | Where-Object {$_.LastWriteTime -lt (Get-Date).AddMinutes(-5)} | Remove-Item -Force -ErrorAction SilentlyContinue
      $partial="$library.$PID.tmp"
      Add-Type -Path $source -ReferencedAssemblies $references -OutputAssembly $partial -OutputType Library
      Move-Item -LiteralPath $partial -Destination $library -Force
    }
    Add-Type -Path $library;$loaded=$true
  }catch{$loaded=$false}
  if(!$loaded -and -not ('DesktopAccessibility' -as [type])){Add-Type -Path $source -ReferencedAssemblies $references}
  $stage='initialize'
  [DesktopAccessibility]::Initialize()
  $stage='execute'
  if($r.action -eq 'observe'){
    if($r.followOwned){$result=[DesktopAccessibility]::Observe([string]$r.executablePath,[string]$r.appUserModelId,[long]$r.windowId,[bool]$r.focus,[int]$r.processId,[long]$r.rootWindowId,[bool]$r.restoreMinimized)}
    else{$result=[DesktopAccessibility]::Read([string]$r.executablePath,[string]$r.appUserModelId,[long]$r.windowId,[bool]$r.focus,[int]$r.processId,[bool]$r.restoreMinimized)}
  }elseif($r.action -eq 'act'){
    $result=[DesktopAccessibility]::Act([string]$r.executablePath,[string]$r.appUserModelId,[long]$r.windowId,[string]$r.screenFingerprint,[string]$r.locator,[string]$r.signature,[string]$r.operation,[string]$r.value,[int]$r.processId)
  }elseif($r.action -eq 'input'){
    $result=[DesktopAccessibility]::Input([string]$r.executablePath,[string]$r.appUserModelId,[long]$r.windowId,[string]$r.kind,[string]$r.payload,[string]$r.locator,[string]$r.signature,[int]$r.processId)
  }elseif($r.action -eq 'close'){
    $result=[DesktopAccessibility]::Close([string]$r.executablePath,[string]$r.appUserModelId,[long]$r.windowId,[int]$r.processId)
  }elseif($r.action -eq 'capture'){
    $result=[DesktopAccessibility]::Capture([string]$r.executablePath,[string]$r.appUserModelId,[long]$r.windowId,[int]$r.processId)
  }elseif($r.action -eq 'visualAct'){
    $result=[DesktopAccessibility]::VisualAct([string]$r.executablePath,[string]$r.appUserModelId,[long]$r.windowId,[int]$r.processId,[string]$r.frameHash,[double]$r.x,[double]$r.y,[double]$r.width,[double]$r.height,[string]$r.operation)
  }else{throw 'UNSUPPORTED_ACTION'}
  $stage='serialize'
  $result|ConvertTo-Json -Depth 7 -Compress
}catch{
  $failure=$_.Exception.GetBaseException();$reason=$failure.Message
  if($env:CHANAKYA_DEBUG_UI -eq '1'){
    # Print only fixed action tokens and exception metadata. Exception messages,
    # request payloads and accessibility values can contain private UI content.
    $action='unknown';if($r.action -in @('observe','act','input','close','capture','visualAct')){$action=[string]$r.action}
    $operation='unknown';if($r.operation -in @('click','doubleClick','focus','collapse','scrollDown','scrollUp','scrollLeft','scrollRight','invoke','expand','select','toggle','setValue')){$operation=[string]$r.operation}
    $origin='unknown';$frames=[Diagnostics.StackTrace]::new($failure,$false).GetFrames()
    if($frames){$method=$frames[0].GetMethod();$origin=$method.DeclaringType.FullName+'.'+$method.Name}
    [Console]::Error.WriteLine('DESKTOP_UI_FAILURE stage='+$stage+' action='+$action+' operation='+$operation+' type='+$failure.GetType().FullName+' hresult='+$failure.HResult+' origin='+$origin)
  }
  if($reason -notmatch '^[A-Z_]+$'){$reason='UI_INSPECTION_FAILED'}
  @{success=$false;code=$reason;message=$reason}|ConvertTo-Json -Compress
}
finally{if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()}
