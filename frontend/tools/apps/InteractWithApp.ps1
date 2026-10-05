$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$desktopMutex=[Threading.Mutex]::new($false,'Local\ChanakyaDesktopAutomation')
$ownsDesktop=$false
try {
  $ownsDesktop=$desktopMutex.WaitOne(0)
  if(!$ownsDesktop){throw 'UI_BUSY'}
  $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
  if($request.action -notin @('calculate','typeInNotepad','inspect','locate')) { throw 'UI_UNSUPPORTED_ACTION' }
  $appProcessId=[int]$request.processId
  if($appProcessId -lt 0) { throw 'UI_INVALID_PROCESS' }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AppUIIdentity {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr p, ref uint len, StringBuilder id);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint msg,IntPtr w,string text,uint flags,uint timeout,out IntPtr result);
 public static string Identity(int pid) {
   var p=OpenProcess(0x1000,false,pid);if(p==IntPtr.Zero)throw new Exception("UI_PROCESS_UNAVAILABLE");
   try {uint length=0;GetApplicationUserModelId(p,ref length,null);if(length==0||length>1024)throw new Exception("UI_INVALID_IDENTITY");var id=new StringBuilder((int)length);if(GetApplicationUserModelId(p,ref length,id)!=0)throw new Exception("UI_INVALID_IDENTITY");return id.ToString();}finally{CloseHandle(p);}
 }
}
'@
  $identity=[string]$request.appUserModelId
  if($identity -notmatch '^Microsoft\.Windows(Calculator|Notepad)_8wekyb3d8bbwe!App$') { throw 'UI_IDENTITY_MISMATCH' }
  if($request.action -eq 'calculate' -and $identity -notmatch 'WindowsCalculator_') { throw 'UI_IDENTITY_MISMATCH' }
  if($request.action -eq 'typeInNotepad' -and $identity -notmatch 'WindowsNotepad_') { throw 'UI_IDENTITY_MISMATCH' }
  if($request.action -eq 'locate' -and $identity -match 'WindowsCalculator_'){$focusTarget=if($appProcessId -gt 0){$appProcessId}else{'Calculator'};$null=(New-Object -ComObject WScript.Shell).AppActivate($focusTarget);Start-Sleep -Milliseconds 200}
  $condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$appProcessId)
  $root=$null
  $deadline=[DateTime]::UtcNow.AddSeconds(6)
  do {
    $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
    $matching=@()
    if($request.action -eq 'locate' -and $appProcessId -eq 0 -and $identity -match 'WindowsCalculator_') {
      $displayCondition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,'CalculatorResults')
      foreach($w in $windows){
        $display=$w.FindFirst([Windows.Automation.TreeScope]::Descendants,$displayCondition)
        if(!$display){continue}
        try{if([AppUIIdentity]::Identity($display.Current.ProcessId) -cne $identity){continue}}catch{continue}
        $root=$display
        do{$parent=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($root);if($parent -and $parent.Current.ProcessId -eq $display.Current.ProcessId){$root=$parent}else{break}}while($true)
        break
      }
      if($root){break}
    }
    foreach($window in $windows) {
      if($appProcessId -gt 0 -and $request.action -ne 'typeInNotepad') {
        $candidate=$window.FindFirst([Windows.Automation.TreeScope]::Subtree,$condition)
        if($candidate) {try {if([AppUIIdentity]::Identity($candidate.Current.ProcessId) -ceq $identity){$root=$candidate;break}}catch{}}
      }
      try {if([AppUIIdentity]::Identity($window.Current.ProcessId) -ceq $identity){$matching+=,$window}}catch{}
    }
    if($request.action -eq 'typeInNotepad') {
      foreach($window in $matching) {
        $documents=$window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Document))
        if($documents.Count -eq 1) {
          try {if($documents[0].GetCurrentPattern([Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1).TrimEnd([char[]]"`r`n").Length -eq 0){$root=$window;break}}catch{}
        }
      }
    }
    if(!$root -and $matching.Count -eq 1){$root=$matching[0]}
    if(!$root -and $matching.Count -gt 1 -and $identity -match 'WindowsCalculator_'){$root=$matching[0]}
    if(!$root -and $matching.Count -gt 1){throw 'UI_AMBIGUOUS_WINDOW: More than one application window is open.'}
    if(!$root){Start-Sleep -Milliseconds 200}
  } while(!$root -and [DateTime]::UtcNow -lt $deadline)
  if(!$root) { throw 'UI_WINDOW_NOT_FOUND' }
  $appProcessId=$root.Current.ProcessId
  if([AppUIIdentity]::Identity($appProcessId) -cne $identity){throw 'UI_IDENTITY_MISMATCH'}
  if($request.action -eq 'calculate') {
    # Focus the actual host window containing this authenticated Calculator.
    $parent=$root
    $hostHandle=0
    for($depth=0;$parent -and $depth -lt 16;$depth++){
      if($parent.Current.NativeWindowHandle){$hostHandle=$parent.Current.NativeWindowHandle}
      $next=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
      if(!$next -or $next.Equals([Windows.Automation.AutomationElement]::RootElement)){break}
      $parent=$next
    }
    if($hostHandle){$null=[AppUIIdentity]::SetForegroundWindow([IntPtr]$hostHandle)}
    Start-Sleep -Milliseconds 250
  }
  function Find-Control([string]$id) {
    $c=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,$id)
    $limit=[DateTime]::UtcNow.AddSeconds(2)
    do {
      $items=$root.FindAll([Windows.Automation.TreeScope]::Descendants,$c)
      if($items.Count -gt 1){$items=@($items|Where-Object {!$_.Current.IsOffscreen})}
      if(!$items.Count){Start-Sleep -Milliseconds 100}
    }while(!$items.Count -and [DateTime]::UtcNow -lt $limit)
    if($items.Count -ne 1) { throw "UI_CONTROL_UNAVAILABLE: $id" }
    return $items[0]
  }
  function Invoke-Control([string]$id) {
    if([AppUIIdentity]::Identity($appProcessId) -cne $identity) {throw 'UI_IDENTITY_CHANGED'}
    $control=Find-Control $id
    if(!$control.Current.IsEnabled -or $control.Current.ProcessId -ne $appProcessId) {throw 'UI_CONTROL_UNAVAILABLE'}
    $pattern=$control.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    Start-Sleep -Milliseconds 150
  }
  if($request.action -eq 'locate') { @{success=$true;processId=$appProcessId;appUserModelId=$identity}|ConvertTo-Json -Compress;exit }
  if($request.action -eq 'inspect') {
    $controls=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
    @($controls | Where-Object {!$_.Current.IsPassword -and $_.Current.Name -notmatch '(?i)password|credential|OTP|PIN'} | ForEach-Object { @{id=$_.Current.AutomationId;name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName;handle=$_.Current.NativeWindowHandle} }) | ConvertTo-Json -Depth 4 -Compress
    exit
  }
  if($request.action -eq 'calculate') {
    $expression=[string]$request.expression
    if($expression -notmatch '^(\d{1,12}(?:\.\d{1,8})?)\s*([+*/-])\s*(\d{1,12}(?:\.\d{1,8})?)$') {throw 'UI_INVALID_EXPRESSION'}
    $left=[double]::Parse($Matches[1],[Globalization.CultureInfo]::InvariantCulture)
    $right=[double]::Parse($Matches[3],[Globalization.CultureInfo]::InvariantCulture)
    $expected=switch($Matches[2]) {'+' {$left+$right} '-' {$left-$right} '*' {$left*$right} '/' {if($right -eq 0){throw 'UI_DIVISION_BY_ZERO'};$left/$right}}
    $keys=@{'+'='plusButton';'-'='minusButton';'*'='multiplyButton';'/'='divideButton';'.'='decimalSeparatorButton'}
    # Validate the complete profile before touching the existing calculation.
    $null=Find-Control 'CalculatorResults'
    $sequence=@('clearButton')
    foreach($char in $expression.ToCharArray()) {
      if([char]::IsWhiteSpace($char)){continue}
      $sequence+= $(if([char]::IsDigit($char)){"num${char}Button"}else{$keys[[string]$char]})
    }
    $sequence+='equalButton'
    foreach($id in $sequence){$null=Find-Control $id}
    foreach($id in $sequence){Invoke-Control $id}
    $display=(Find-Control 'CalculatorResults').Current.Name
    if(!$display){throw 'UI_RESULT_UNAVAILABLE'}
    $numberText=$display -replace '^[^0-9+-]*',''
    $actual=0.0
    if(![double]::TryParse($numberText,([Globalization.NumberStyles]::Float -bor [Globalization.NumberStyles]::AllowThousands),[Globalization.CultureInfo]::CurrentCulture,[ref]$actual) -or [Math]::Abs($actual-$expected) -gt [Math]::Max(1,[Math]::Abs($expected))*1e-12){throw 'UI_CALCULATION_UNVERIFIED'}
    $result=@{success=$true;processId=$appProcessId;appUserModelId=$identity;displayText=$numberText;displayLabel=$display;expression=$expression;verification=@{status='verified';criterion='calculator_display';observedAt=[DateTime]::UtcNow.ToString('o')}}
  } else {
    $text=[string]$request.text
    if(!$text -or $text.Length -gt 4000 -or $text.Contains([char]0)){throw 'UI_INVALID_TEXT'}
    $edits=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Document))
    if($edits.Count -ne 1){throw 'UI_EDITOR_UNAVAILABLE'}
    $editor=$edits[0]
    if($editor.Current.IsPassword -or $editor.Current.ProcessId -ne $appProcessId){throw 'UI_EDITOR_UNAVAILABLE'}
    $textPattern=$editor.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern)
    if($textPattern.DocumentRange.GetText(-1).TrimEnd([char[]]"`r`n").Length -ne 0){throw 'UI_EDITOR_NOT_EMPTY: Existing Notepad text was preserved.'}
    $valuePattern=$null
    if([AppUIIdentity]::Identity($appProcessId) -cne $identity){throw 'UI_IDENTITY_CHANGED'}
    if($editor.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$valuePattern)) {
      if($valuePattern.Current.IsReadOnly){throw 'UI_EDITOR_READ_ONLY'}
      $valuePattern.SetValue($text)
    } else {
      $handle=$editor.Current.NativeWindowHandle
      if(!$handle){throw 'UI_EDITOR_PATTERN_UNSUPPORTED'}
      $unused=[IntPtr]::Zero
      if([AppUIIdentity]::SendMessageTimeout([IntPtr]$handle,0x000C,[IntPtr]::Zero,$text,2,2000,[ref]$unused) -eq [IntPtr]::Zero){throw 'UI_TEXT_WRITE_FAILED'}
    }
    Start-Sleep -Milliseconds 200
    if($textPattern.DocumentRange.GetText(-1).TrimEnd([char[]]"`r`n") -cne $text.TrimEnd([char[]]"`r`n")){throw 'UI_TEXT_UNVERIFIED'}
    $result=@{success=$true;processId=$appProcessId;appUserModelId=$identity;verification=@{status='verified';criterion='notepad_text';observedAt=[DateTime]::UtcNow.ToString('o')}}
  }
  $result | ConvertTo-Json -Depth 5 -Compress
} catch {
  @{success=$false;code='UI_EXECUTION_FAILED';message=$_.Exception.Message} | ConvertTo-Json -Compress
}

finally {if($ownsDesktop){$desktopMutex.ReleaseMutex()};$desktopMutex.Dispose()}
