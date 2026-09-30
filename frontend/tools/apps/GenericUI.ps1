$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$desktopMutex=[Threading.Mutex]::new($false,'Local\ChanakyaDesktopAutomation')
$ownsDesktop=$false
try {
  $ownsDesktop=$desktopMutex.WaitOne(0)
  if(!$ownsDesktop){throw 'UI_BUSY'}
  $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -TypeDefinition @"
using System;using System.Text;using System.Runtime.InteropServices;
public static class InspectIdentity {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a,bool i,int p);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr p,ref uint l,StringBuilder s);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
 public static string Get(int pid){var p=OpenProcess(0x1000,false,pid);if(p==IntPtr.Zero)return "";try{uint n=0;GetApplicationUserModelId(p,ref n,null);if(n==0||n>1024)return "";var s=new StringBuilder((int)n);return GetApplicationUserModelId(p,ref n,s)==0?s.ToString():"";}finally{CloseHandle(p);}}
}
"@
  $sensitive='(?i)password|passcode|credential|one.time|verification code|security code|credit.?card|card.?number|\bcvv\b|\bPIN\b|\bOTP\b|secure desktop|user account control'
  # Every UIA property read is a cross-process call; a cache request batches them with the traversal itself.
  $cacheRequest=[Windows.Automation.CacheRequest]::new()
  foreach($property in @([Windows.Automation.AutomationElement]::NameProperty,[Windows.Automation.AutomationElement]::AutomationIdProperty,[Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.AutomationElement]::ClassNameProperty,[Windows.Automation.AutomationElement]::IsEnabledProperty,[Windows.Automation.AutomationElement]::IsOffscreenProperty,[Windows.Automation.AutomationElement]::IsPasswordProperty,[Windows.Automation.AutomationElement]::LabeledByProperty,[Windows.Automation.AutomationElement]::ProcessIdProperty)){$cacheRequest.Add($property)}
  $cacheScope=$cacheRequest.Activate()
  $processInfo=@{}
  # Path/system-name requests only need processes with the expected image name: one Get-Process call instead of one per window.
  $knownOnly=!$r.appUserModelId
  if($knownOnly){
    $imageNames=@();if($r.executablePath){$imageNames+=[IO.Path]::GetFileNameWithoutExtension([string]$r.executablePath)};if($r.systemProcessNames){$imageNames+=@($r.systemProcessNames)}
    foreach($p in @(Get-Process -Name $imageNames -ErrorAction SilentlyContinue)){$processInfo[$p.Id]=@{Name=$p.ProcessName;Path=$p.Path;Aumid=$null;AumidRead=$false}}
  }
  function Get-ProcessInfo($processId) {
    if($knownOnly){return $processInfo[$processId]}
    if(!$processInfo.ContainsKey($processId)){
      $info=$null
      try{$p=Get-Process -Id $processId -ErrorAction Stop;$info=@{Name=$p.ProcessName;Path=$p.Path;Aumid=$null;AumidRead=$false}}catch{}
      $processInfo[$processId]=$info
    }
    return $processInfo[$processId]
  }
  function Get-Aumid($processId,$info) {
    if(!$info.AumidRead){$info.Aumid=[InspectIdentity]::Get($processId);$info.AumidRead=$true}
    return $info.Aumid
  }
  $deadline=[DateTime]::UtcNow.AddSeconds(5)
  do {
  $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
  $matching=@()
  foreach($w in $windows) {
    try {
      $info=Get-ProcessInfo $w.Cached.ProcessId
      if(!$info){continue}
      $name=$w.Cached.Name
      $identityMatch=($r.executablePath -and $info.Path -ieq $r.executablePath) -or ($r.appUserModelId -and (Get-Aumid $w.Cached.ProcessId $info) -ceq $r.appUserModelId)
      if($r.systemProcessNames -and $info.Name -in $r.systemProcessNames){$identityMatch=$true}
      if($identityMatch -and (!$r.windowTitle -or $name -eq $r.windowTitle) -and $name -notmatch $sensitive){$matching+=,$w}
      elseif($r.appUserModelId -and $info.Name -eq 'ApplicationFrameHost'){
        $children=$w.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
        foreach($c in $children){$childInfo=Get-ProcessInfo $c.Cached.ProcessId;if($childInfo -and (Get-Aumid $c.Cached.ProcessId $childInfo) -ceq $r.appUserModelId){$matching+=,$c;break}}
      }
    }catch{}
  }
  if(!$matching.Count -and $r.action -eq 'waitForWindow'){Start-Sleep -Milliseconds 200}
  }while(!$matching.Count -and $r.action -eq 'waitForWindow' -and [DateTime]::UtcNow -lt $deadline)
  if(!$matching.Count){if($r.action -eq 'isWindowOpen'){@{success=$true;open=$false}|ConvertTo-Json;exit};throw 'WINDOW_NOT_FOUND'}
  if($matching.Count -gt 1){
    $active=@($matching|Where-Object {$_.Current.NativeWindowHandle -eq [InspectIdentity]::GetForegroundWindow().ToInt64()})
    if($active.Count -eq 1){$matching=$active}else{throw 'AMBIGUOUS_WINDOW'}
  }
  $root=$matching[0]
  $output=@{foreground=([InspectIdentity]::GetForegroundWindow().ToInt64() -eq $root.Current.NativeWindowHandle);success=$true;processId=$root.Current.ProcessId;windowTitle=$root.Current.Name;windowId=$root.Current.NativeWindowHandle}
  if($r.action -in @('findWindow','waitForWindow','isWindowOpen')) {$output.open=$true}
  elseif($r.action -eq 'closeWindow') {$root.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close()}
  elseif($r.action -eq 'focusWindow') {$root.SetFocus()}
  else {
    # Bounded breadth-first traversal: never materialize the entire application tree. Sensitivity is propagated
    # from parent to child while walking, so no element ever needs an ancestor re-walk; sensitive subtrees are pruned.
    function Test-SensitiveElement($element) {
      if($element.Cached.IsPassword -or $element.Cached.Name -match $sensitive -or $element.Cached.AutomationId -match $sensitive){return $true}
      $label=$element.Cached.LabeledBy
      return [bool]($label -and $label.Current.Name -match $sensitive)
    }
    $safe=[Collections.Generic.List[object]]::new()
    $queue=[Collections.Generic.Queue[object]]::new()
    if(!(Test-SensitiveElement $root)){$queue.Enqueue(@{element=$root;depth=0})}
    $walker=[Windows.Automation.TreeWalker]::ControlViewWalker
    while($queue.Count -gt 0 -and $safe.Count -lt 300){
      $node=$queue.Dequeue()
      if($node.depth -ge 8){continue}
      $parentName=$node.element.Cached.Name
      $child=$walker.GetFirstChild($node.element,$cacheRequest)
      while($child -and $safe.Count -lt 300){
        if(!$child.Cached.IsOffscreen -and !$child.Cached.IsPassword -and !(Test-SensitiveElement $child)){
          $safe.Add(@{element=$child;parentName=$parentName});$queue.Enqueue(@{element=$child;depth=$node.depth+1})
        }
        $child=$walker.GetNextSibling($child,$cacheRequest)
      }
    }
    if($r.action -eq 'listControls') {
      $output.controls=@($safe | ForEach-Object {$e=$_.element.Cached;@{automationId=$e.AutomationId;name=$e.Name;controlType=$e.ControlType.ProgrammaticName;className=$e.ClassName;enabled=$e.IsEnabled;offscreen=$e.IsOffscreen;parentName=$_.parentName}})
    } else {
      $found=@($safe | Where-Object {
        $e=$_.element.Cached
        if($r.automationId){$e.AutomationId -ceq $r.automationId}
        elseif($r.controlName){$e.Name -ceq $r.controlName -and (!$r.controlType -or $e.ControlType.ProgrammaticName -eq "ControlType.$($r.controlType)")}
        elseif($r.className){$e.ClassName -ceq $r.className}
        else{$false}
      })
      if($found.Count -eq 0){throw 'CONTROL_NOT_FOUND'}
      if($found.Count -ne 1){throw 'AMBIGUOUS_CONTROL'}
      $c=$found[0].element
      if($c.Current.IsPassword -or $c.Current.Name -match $sensitive){throw 'SENSITIVE_CONTROL'}
      $output.control=@{automationId=$c.Current.AutomationId;name=$c.Current.Name;controlType=$c.Current.ControlType.ProgrammaticName}
      switch($r.action) {
        'findControl' {}
        'waitForControl' {}
        'readText' {
          # Return only the selected non-sensitive control, never a window/document subtree.
          $output.text=$c.Current.Name
          if($c.Current.ControlType -eq [Windows.Automation.ControlType]::Edit){$output.text=$c.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value}
        }
        'navigateControl' {
          if($c.Current.ControlType -eq [Windows.Automation.ControlType]::TabItem){$c.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()}
          elseif($c.Current.ControlType -eq [Windows.Automation.ControlType]::MenuItem){$c.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()}
          else{throw 'NAVIGATION_ONLY'}
        }
        default {throw 'UI_UNSUPPORTED_ACTION'}
      }
    }
  }
  $output.verification=@{status='verified';criterion='uia_observation';observedAt=[DateTime]::UtcNow.ToString('o')}
  $output|ConvertTo-Json -Depth 6 -Compress
}catch{@{success=$false;code=$_.Exception.Message;message=$_.Exception.Message}|ConvertTo-Json -Compress}

finally {if($cacheScope){$cacheScope.Dispose()};if($ownsDesktop){$desktopMutex.ReleaseMutex()};$desktopMutex.Dispose()}
