<#
.SYNOPSIS
    Verifies the Windows repair dataset against a REAL Windows machine.
    Works with BOTH repair-sessions.json AND repair-dataset.jsonl.

    v3 - Parameter checking now uses the PowerShell AST instead of regex.
         This correctly handles pipes inside quoted strings, parameters
         inside script blocks, and splatting. Known provider dynamic
         parameters (-Type on the registry provider, -Concatenate on
         WSMan, etc.) are recognised instead of being flagged.

.DESCRIPTION
      L1 SYNTAX   - Does the command parse? (executes nothing)
      L2 EXISTS   - Does the cmdlet/exe exist on this machine?
      L3 PARAMS   - Are the named parameters real for that cmdlet? (AST-based)
      L4 EXECUTE  - Actually run READ-ONLY commands and capture REAL output

    UNSAFE and DISKPART commands are NEVER executed - only checked.

.EXAMPLE
    .\Verify-Dataset.ps1 -Level 3
#>
[CmdletBinding()]
param(
    [string]$DatasetPath,
    [ValidateRange(1,4)][int]$Level = 3,
    [string]$ReportPath = ".\verification-report.csv"
)
$ErrorActionPreference = 'Continue'

# --------------------------------------------------------------------------
if (-not $DatasetPath -or -not (Test-Path $DatasetPath)) {
    Write-Host "Looking for dataset in current folder..." -ForegroundColor Yellow
    $cand = Get-ChildItem -Path . -Include 'repair-dataset*.jsonl','repair-sessions*.json' -Recurse -ErrorAction SilentlyContinue |
            Sort-Object Length -Descending | Select-Object -First 1
    if ($cand) { $DatasetPath = $cand.FullName; Write-Host "Found: $DatasetPath" -ForegroundColor Green }
    else { throw "No dataset found. Put repair-dataset.jsonl here or pass -DatasetPath." }
}

$SafeVerbs = @('Get','Test','Measure','Resolve','Find','Show','Select','Compare','Out','Where','Sort','Group','ConvertFrom','ConvertTo')

$SafeNativePatterns = @(
    '^whoami','^klist(\s|$)','^gpresult\s+/[rh]','^netsh\s+\S+\s+show','^netsh\s+\S+\s+\S+\s+show',
    '^vssadmin\s+list','^bcdedit\s+/enum','^fsutil\s+\S+\s+(query|fsinfo)','^fsutil\s+hardlink\s+list',
    '^setspn\s+-[LX]','^certutil\s+-(verify|dump|CAInfo|URL)','^typeperf\s+-q','^logman\s+query',
    '^fltmc\s+filters','^driverquery','^systeminfo','^nltest\s+/(sc_query|dsgetdc)','^netdom\s+query',
    '^repadmin\s+/(repl|showrepl)','^dfsrdiag\s+replicationstate','^w32tm\s+/(query|stripchart)',
    '^slmgr\s+/(dlv|dli)','^manage-bde\s+-status','^manage-bde\s+-protectors\s+-get',
    '^powercfg\s+/(a|q|list|requests|getactivescheme|waketimers|sleepstudy)',
    '^pnputil\s+/enum-drivers','^wbadmin\s+get','^mountvol\s*$','^dotnet\s+--list-runtimes',
    '^winget\s+(list|upgrade)\s*$','^wsl\s+(--list|--status|--version|-l)','^docker\s+(version|inspect|network\s+inspect)',
    '^kubectl\s+describe','^ping\s','^nslookup\s','^ipconfig(\s+/all)?\s*$','^mbr2gpt\s+/validate',
    '^DISM\s+/Online\s+/Cleanup-Image\s+/(ScanHealth|CheckHealth|AnalyzeComponentStore)','^DISM\s+/Online\s+/Get-Features',
    '^chkdsk\s+[A-Za-z]:\s*$','^wevtutil\s+(el|gl|qe)','^reg\s+query','^sc\s+query','^cmdkey\s+/list',
    '^icacls\s+\S+\s*$','^icacls\s+\S+\s+/verify','^where\s','^echo\s',
    '^Get-','^Test-','^Measure-','^Resolve-','^Find-','^Compare-','^\$\w+\s*=\s*Get-','^Add-Type'
)

$HardUnsafePatterns = @(
    'clean\s+all','^\s*clean\s*$','delete\s+partition','delete\s+volume','\bformat\s+(quick|fs=)',
    'Format-Volume','Clear-Disk','Initialize-Disk','Set-Partition','New-Partition','Remove-Partition',
    'Remove-Item','Remove-ItemProperty','Set-ItemProperty','New-Item','New-ItemProperty','Set-Item\b',
    'Stop-Process','Stop-Service','Start-Service','Restart-Service','Set-Service','sc\s+(config|delete)',
    '^(Remove|Set|New|Add|Disable|Enable|Start|Restart|Stop|Clear|Reset|Repair|Install|Uninstall|Update|Invoke|Register|Unregister|Import|Export|Rename|Move|Copy|Checkpoint|Suspend|Resume|Initialize|Connect|Unblock)-',
    'reg\s+(add|delete|import|load|unload)','takeown','icacls\s+\S+\s+/(grant|deny|remove|reset|setowner|inheritance)',
    'bootrec','bcdboot','bcdedit\s+/(set|delete|copy|create)','reagentc\s+/(enable|disable)',
    'netsh\s+(winsock\s+reset|int\s+ip\s+reset|winhttp\s+reset)','netsh\s+\S+\s+(add|delete|set)\s',
    'sfc\s+/scannow','DISM.*(RestoreHealth|StartComponentCleanup|RevertPendingActions|Enable-Feature|Add-Driver)',
    'chkdsk\s+\S+\s+/','^diskpart','wsreset','msdtc\s+-','lodctr','unlodctr','winmgmt\s+/(salvage|reset)',
    'wevtutil\s+cl','vssadmin\s+(resize|add|delete)','wbadmin\s+(start|enable|disable)',
    'slmgr\s+/(ato|skms|rearm|upk)','manage-bde\s+-(unlock|on|off)','manage-bde\s+-protectors\s+-add',
    'powercfg\s+/(h|setactive|setacvalueindex|setdcvalueindex)','pnputil\s+/(delete|add|install)',
    'taskkill','shutdown','mbr2gpt\s+/convert','verifier\s+/','mdsched','wusa','msiexec',
    'certutil\s+-(repairstore|generateSST)','wmic\s+\S+\s+set','gpupdate','runas','attrib\s+-',
    'OfficeC2RClient','OneDrive\.exe','\.Quit\(\)','\.SaveAs','CalculateFull','AcceptAll'
)

$DiskpartPattern = 'DISKPART>|^\s*(select\s+(disk|volume|partition|vdisk)|list\s+(disk|volume|partition|vdisk)|detail\s+|assign\s|remove\s+letter|^active$|convert\s+(gpt|mbr)|attributes\s+(disk|volume)|automount|^import$|expand\s+vdisk|attach\s+vdisk|^san$|uniqueid\s+disk|^rescan$|create\s+partition|shrink\s|^extend|online\s+disk|offline\s+disk|set\s+id=|gpt\s+attributes)'

# Provider dynamic parameters: valid, but not visible via Get-Command
$DynamicParams = @{
    'Set-ItemProperty' = @('Type')
    'New-ItemProperty' = @('Type')
    'Get-ItemProperty' = @('Type')
    'Set-Item'         = @('Concatenate','Type')
    'New-Item'         = @('Type','Target','Value')
    'Get-ChildItem'    = @('Stream','Hidden','ReadOnly','System','Directory','File','Attributes')
    'Get-Item'         = @('Stream')
    'Remove-Item'      = @('Stream')
    'Get-Content'      = @('Stream','Raw','Encoding','Delimiter','Wait','AsByteStream')
    'Set-Content'      = @('Stream','Encoding','AsByteStream')
    'Add-Content'      = @('Stream','Encoding')
    'Test-Path'        = @('OlderThan','NewerThan')
}

function Get-CommandSafety {
    param([string]$Cmd)
    $c = $Cmd.Trim()
    if ([string]::IsNullOrWhiteSpace($c)) { return 'EMPTY' }
    if ($c -match '^\s*#') { return 'COMMENT' }
    if ($c -match $DiskpartPattern) { return 'DISKPART' }
    foreach ($p in $HardUnsafePatterns) { if ($c -match $p) { return 'UNSAFE' } }
    foreach ($p in $SafeNativePatterns) { if ($c -match $p) { return 'SAFE' } }
    $first = ($c -split '[\s|]')[0]
    if ($first -match '^([A-Za-z]+)-') { if ($SafeVerbs -contains $Matches[1]) { return 'SAFE' }; return 'UNSAFE' }
    return 'UNKNOWN'
}

# --------------------------------------------------------------------------
Write-Host "Loading $DatasetPath ..." -ForegroundColor Cyan
$entries = New-Object System.Collections.Generic.List[object]
$isJsonl = $DatasetPath -match '\.jsonl$'

if ($isJsonl) {
    $ln = 0
    foreach ($line in (Get-Content $DatasetPath -Encoding UTF8)) {
        if (-not $line.Trim()) { continue }
        $ln++
        try { $o = $line | ConvertFrom-Json } catch { continue }
        $sys = ($o.messages | Where-Object role -eq 'system').content
        $domain = 'unknown'; if ($sys -match 'specializing in (.+?) problems') { $domain = $Matches[1] }
        $asst = ($o.messages | Where-Object role -eq 'assistant').content
        $cmds = @()
        if ($asst -match '(?s)Commands used:\s*(.+?)(\r?\nRecommendation:|\z)') {
            foreach ($l in ($Matches[1] -split "`r?`n")) {
                if ($l -match '^\s*-\s+(.+)$') {
                    $cc = $Matches[1] -replace '\s*\[FAILED:.*$',''
                    if ($cc.Trim()) { $cmds += $cc.Trim() }
                }
            }
        }
        $entries.Add([pscustomobject]@{ id="line-$ln"; domain=$domain; goal=($o.messages|Where-Object role -eq 'user').content; commands=$cmds })
    }
} else {
    foreach ($e in (Get-Content $DatasetPath -Raw | ConvertFrom-Json)) {
        $entries.Add([pscustomobject]@{ id=$e.id; domain=$e.domain; goal=$e.goal; commands=@($e.steps.command) })
    }
}
Write-Host ("Entries loaded: {0}" -f $entries.Count) -ForegroundColor Cyan
if ($entries.Count -eq 0) { throw "No entries parsed - wrong file?" }

# --------------------------------------------------------------------------
$results = New-Object System.Collections.Generic.List[object]
$idx = 0
foreach ($entry in $entries) {
    $idx++
    if ($idx % 100 -eq 0) { Write-Host "  ...$idx / $($entries.Count)" -ForegroundColor DarkGray }
    $stepNo = 0
    foreach ($cmd in $entry.commands) {
        $stepNo++
        $safety = Get-CommandSafety $cmd
        $row = [ordered]@{
            EntryId=$entry.id; Domain=$entry.domain; Goal=($entry.goal -replace '\s+',' ')
            StepNo=$stepNo; Command=$cmd; Safety=$safety
            SyntaxOK=''; CmdExists=''; ParamsOK=''; Executed='no'; RealOutput=''; Notes=''
        }

        $ast = $null
        if ($Level -ge 1) {
            if ($safety -in 'COMMENT','EMPTY','DISKPART') { $row.SyntaxOK='n/a' }
            else {
                $t=$null;$er=$null
                $ast = [System.Management.Automation.Language.Parser]::ParseInput($cmd,[ref]$t,[ref]$er)
                if ($er -and $er.Count) { $row.SyntaxOK='FAIL'; $row.Notes=$er[0].Message }
                else { $row.SyntaxOK='ok' }
            }
        }

        if ($Level -ge 2 -and $safety -notin 'COMMENT','EMPTY','DISKPART') {
            $first = (($cmd -split '[\s|;]')[0]).Trim('"',"'",'(')
            if ($first -match "^\`$|^\[|^'|^`"") { $row.CmdExists='n/a' }
            elseif (Get-Command $first -ErrorAction SilentlyContinue) { $row.CmdExists='ok' }
            else { $row.CmdExists='MISSING'; if(-not $row.Notes){$row.Notes="'$first' not installed on this machine"} }
        }

        # ---- L3 : AST-BASED parameter validation ----
        if ($Level -ge 3 -and $row.SyntaxOK -eq 'ok' -and $ast) {
            $bad = @(); $checked = $false
            $cmdAsts = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true)
            foreach ($ca in $cmdAsts) {
                $cname = $null
                try { $cname = $ca.GetCommandName() } catch {}
                if (-not $cname) { continue }
                $ci = Get-Command $cname -ErrorAction SilentlyContinue
                if (-not $ci) { continue }
                if ($ci.CommandType -eq 'Alias') { $ci = $ci.ResolvedCommand }
                if (-not $ci -or $ci.CommandType -notin 'Cmdlet','Function') { continue }
                $checked = $true
                $declared = @($ci.Parameters.Keys)
                if ($DynamicParams.ContainsKey($ci.Name)) { $declared += $DynamicParams[$ci.Name] }
                foreach ($el in $ca.CommandElements) {
                    if ($el -isnot [System.Management.Automation.Language.CommandParameterAst]) { continue }
                    $pn = $el.ParameterName
                    if (-not ($declared | Where-Object { $_ -like "$pn*" })) { $bad += "$cname -$pn" }
                }
            }
            if ($bad.Count)   { $row.ParamsOK = 'SUSPECT: ' + (($bad | Select-Object -Unique) -join '; ') }
            elseif ($checked) { $row.ParamsOK = 'ok' }
            else              { $row.ParamsOK = 'n/a' }
        }

        if ($Level -ge 4 -and $safety -eq 'SAFE' -and $row.SyntaxOK -eq 'ok' -and $row.CmdExists -eq 'ok') {
            try {
                $job = Start-Job -ScriptBlock { param($c)
                    try { Invoke-Expression $c 2>&1 | Out-String } catch { "ERROR: $($_.Exception.Message)" }
                } -ArgumentList $cmd
                if (Wait-Job $job -Timeout 20) {
                    $out = (Receive-Job $job | Out-String).Trim()
                    $row.Executed='yes'
                    $row.RealOutput = if($out.Length -gt 800){$out.Substring(0,800)+'...'}else{$out}
                    if ($out -match '^ERROR:') { $row.Notes=$out }
                } else { $row.Executed='timeout' }
                Remove-Job $job -Force -ErrorAction SilentlyContinue
            } catch { $row.Executed='error'; $row.Notes=$_.Exception.Message }
        }

        $results.Add([pscustomobject]$row)
    }
}

$results | Export-Csv -Path $ReportPath -NoTypeInformation -Encoding UTF8

$t=$results.Count
$sy=@($results|Where-Object SyntaxOK -eq 'FAIL').Count
$mi=@($results|Where-Object CmdExists -eq 'MISSING').Count
$pa=@($results|Where-Object {$_.ParamsOK -like 'SUSPECT*'}).Count
$sf=@($results|Where-Object Safety -eq 'SAFE').Count
$un=@($results|Where-Object Safety -eq 'UNSAFE').Count
$dp=@($results|Where-Object Safety -eq 'DISKPART').Count
$rn=@($results|Where-Object Executed -eq 'yes').Count

Write-Host ""
Write-Host "================ VERIFICATION SUMMARY (v3 / AST) ================" -ForegroundColor Green
Write-Host ("Dataset              : {0}" -f (Split-Path $DatasetPath -Leaf))
Write-Host ("Entries              : {0}" -f $entries.Count)
Write-Host ("Commands checked     : {0}" -f $t)
Write-Host ("  SAFE (runnable)    : {0}" -f $sf)
Write-Host ("  UNSAFE (never run) : {0}" -f $un)
Write-Host ("  diskpart sub-cmds  : {0}" -f $dp)
Write-Host ""
Write-Host ("L1 syntax failures   : {0}" -f $sy) -ForegroundColor $(if($sy){'Red'}else{'Green'})
Write-Host ("L2 command not found : {0}   <- normal: RSAT/Hyper-V/SQL/IIS not installed" -f $mi) -ForegroundColor Yellow
Write-Host ("L3 suspect params    : {0}" -f $pa) -ForegroundColor $(if($pa){'Yellow'}else{'Green'})
Write-Host ("L4 executed for real : {0}" -f $rn) -ForegroundColor Cyan
Write-Host ""
Write-Host "Report: $ReportPath" -ForegroundColor Cyan

if($sy){ Write-Host "`n--- SYNTAX FAILURES ---" -ForegroundColor Red
  $results|Where-Object SyntaxOK -eq 'FAIL'|Select-Object -First 15 EntryId,Command,Notes|Format-List }
if($pa){ Write-Host "`n--- SUSPECT PARAMETERS ---" -ForegroundColor Yellow
  $results|Where-Object {$_.ParamsOK -like 'SUSPECT*'}|Select-Object -First 25 EntryId,Command,ParamsOK|Format-Table -AutoSize -Wrap }

Write-Host "`nDone." -ForegroundColor Green
