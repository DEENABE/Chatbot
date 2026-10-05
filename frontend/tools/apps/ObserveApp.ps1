param([Parameter(Mandatory=$true)][string]$ExecutablePath,[Parameter(Mandatory=$true)][int]$LaunchProcessId,[Parameter(Mandatory=$true)][string]$LaunchedAt)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$start=[DateTime]::Parse($LaunchedAt).ToUniversalTime().AddSeconds(-2)
$deadline=[DateTime]::UtcNow.AddSeconds(10)
$owned=[Collections.Generic.HashSet[int]]::new();$null=$owned.Add($LaunchProcessId)
do {
 $processes=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
 for($depth=0;$depth -lt 4;$depth++){
  foreach($p in $processes){if($owned.Contains([int]$p.ParentProcessId) -and $p.CreationDate -and $p.CreationDate.ToUniversalTime() -ge $start){$null=$owned.Add([int]$p.ProcessId)}}
 }
 foreach($p in @(Get-Process -ErrorAction SilentlyContinue)){
  try {
   if($p.MainWindowHandle -eq 0){continue}
   $exact=$p.Path -ieq $ExecutablePath
   $descendant=$owned.Contains($p.Id) -and $p.StartTime.ToUniversalTime() -ge $start
   if($exact -or $descendant){@{pid=$p.Id;windowId=$p.MainWindowHandle.ToInt64();criterion=$(if($exact){'executable_window'}else{'launch_descendant_window'});observedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress;exit}
  }catch{}
 }
 Start-Sleep -Milliseconds 250
}while([DateTime]::UtcNow -lt $deadline)
@{status='APP_WINDOW_UNVERIFIED'}|ConvertTo-Json -Compress
