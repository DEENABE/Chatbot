$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$desktopMutex=[Threading.Mutex]::new($false,'Local\ChanakyaDesktopAutomation')
$ownsDesktop=$false
try {
  try{$ownsDesktop=$desktopMutex.WaitOne(4000)}catch{if($_.Exception.GetBaseException() -is [Threading.AbandonedMutexException]){$ownsDesktop=$true}else{throw}}
  if(!$ownsDesktop){throw 'UI_BUSY'}
  $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  if($r.target.type -notin @('FILE','MEDIA','DOCUMENT','WORKSPACE')){throw 'APP_CAPABILITY_UNSUPPORTED'}
  $deadline=[DateTime]::UtcNow.AddSeconds(5)
  do {
    $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
    $roots=@($windows | Where-Object {try{(Get-Process -Id $_.Current.ProcessId -ErrorAction Stop).Path -ieq $r.executablePath}catch{$false}})
    if(!$roots.Count){Start-Sleep -Milliseconds 200}
  }while(!$roots.Count -and [DateTime]::UtcNow -lt $deadline)
  if($roots.Count -ne 1){throw 'UI_FALLBACK_FAILED: One application window is required.'}
  $root=$roots[0]
  if($root.Current.Name -match '(?i)password|credential|user account control|security code|\bOTP\b|\bPIN\b'){throw 'UI_FALLBACK_FAILED: Sensitive window.'}
  function Named([string]$name,[Windows.Automation.ControlType]$type) {
    $items=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
    return @($items|Where-Object {!$_.Current.IsPassword -and $_.Current.Name -eq $name -and $_.Current.ControlType -eq $type})
  }
  $file=@(Named 'File' ([Windows.Automation.ControlType]::MenuItem))
  if($file.Count -ne 1){throw 'UI_FALLBACK_FAILED: No unique File menu.'}
  $file[0].GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
  Start-Sleep -Milliseconds 200
  $open=@(Named 'Open...' ([Windows.Automation.ControlType]::MenuItem))
  if($open.Count -ne 1){$open=@(Named 'Open' ([Windows.Automation.ControlType]::MenuItem))}
  if($open.Count -ne 1){throw 'UI_FALLBACK_FAILED: No unique Open menu.'}
  $open[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  $deadline=[DateTime]::UtcNow.AddSeconds(5)
  do {
    Start-Sleep -Milliseconds 200
    $dialogs=@([Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ClassNameProperty,'#32770')) | Where-Object {$_.Current.ProcessId -eq $root.Current.ProcessId})
  }while(!$dialogs.Count -and [DateTime]::UtcNow -lt $deadline)
  if($dialogs.Count -ne 1){throw 'UI_FALLBACK_FAILED: Standard file dialog not found.'}
  $dialog=$dialogs[0]
  $controls=$dialog.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
  $edits=@($controls|Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::Edit -and $_.Current.Name -eq 'File name:' -and !$_.Current.IsPassword})
  $buttons=@($controls|Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.Name -eq 'Open'})
  if($edits.Count -ne 1 -or $buttons.Count -ne 1){throw 'UI_FALLBACK_FAILED: File dialog controls not found.'}
  $edits[0].GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue([string]$r.target.path)
  $buttons[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  $deadline=[DateTime]::UtcNow.AddSeconds(6)
  $label=[IO.Path]::GetFileName([string]$r.target.path)
  do {Start-Sleep -Milliseconds 200;$title=$root.Current.Name}while($title.IndexOf($label,[StringComparison]::OrdinalIgnoreCase) -lt 0 -and [DateTime]::UtcNow -lt $deadline)
  if($title.IndexOf($label,[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'VERIFICATION_FAILED'}
  @{success=$true;processId=$root.Current.ProcessId;verification=@{status='verified';criterion='window_title';windowTitle=$title;confidence='medium';observedAt=[DateTime]::UtcNow.ToString('o')}}|ConvertTo-Json -Depth 5 -Compress
}catch{@{success=$false;code='UI_FALLBACK_FAILED';message=$_.Exception.Message}|ConvertTo-Json -Compress}

finally {if($ownsDesktop){$desktopMutex.ReleaseMutex()};$desktopMutex.Dispose()}
