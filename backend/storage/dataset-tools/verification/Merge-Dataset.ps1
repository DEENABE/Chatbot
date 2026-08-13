<#
.SYNOPSIS
    Audits and merges Windows repair datasets from multiple sources
    (e.g. Antigravity-collected data + backup.json) into one clean file.

.DESCRIPTION
    Handles the real problems that appear when two sources are combined:
      - duplicate scenarios (exact and near-duplicate wording)
      - schema mismatch (missing subdomain / plan / feedback / resolved)
      - id collisions between sources
      - broken JSON lines
      - json <-> jsonl drift

    Runs in AUDIT mode by default (changes nothing). Add -Merge to write output.

.EXAMPLE
    # Just look at what you have - safe, writes nothing
    .\Merge-Dataset.ps1 -Files .\antigravity.jsonl, .\backup.json

.EXAMPLE
    # Actually merge and clean
    .\Merge-Dataset.ps1 -Files .\antigravity.jsonl, .\backup.json -Merge -OutPrefix merged

.EXAMPLE
    # Audit a single file you think has 2088 entries
    .\Merge-Dataset.ps1 -Files .\repair-dataset.jsonl
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string[]]$Files,
    [switch]$Merge,
    [string]$OutPrefix = "merged",
    [double]$NearDuplicateThreshold = 0.85
)
$ErrorActionPreference = 'Stop'

function Read-Dataset {
    param([string]$Path)
    $out = New-Object System.Collections.Generic.List[object]
    if (-not (Test-Path $Path)) { Write-Warning "not found: $Path"; return $out }
    $name = Split-Path $Path -Leaf

    if ($Path -match '\.jsonl$') {
        $n = 0; $bad = 0
        foreach ($line in (Get-Content $Path -Encoding UTF8)) {
            if (-not $line.Trim()) { continue }
            $n++
            try { $o = $line | ConvertFrom-Json } catch { $bad++; continue }
            $u = ($o.messages | Where-Object role -eq 'user').content
            $a = ($o.messages | Where-Object role -eq 'assistant').content
            $s = ($o.messages | Where-Object role -eq 'system').content
            $dom = 'unknown'; $sub = $null
            if ($s -match 'specializing in ([^(]+?)\s*\(([^)]+)\)\s*problems') { $dom=$Matches[1].Trim(); $sub=$Matches[2].Trim() }
            elseif ($s -match 'specializing in (.+?) problems') { $dom = $Matches[1].Trim() }
            $out.Add([pscustomobject]@{
                Source=$name; Format='jsonl'; Id=$null; Goal=$u; Domain=$dom; Subdomain=$sub
                Assistant=$a; Raw=$line; HasSteps=$false
            })
        }
        if ($bad) { Write-Warning "$name : $bad unparseable line(s)" }
    }
    else {
        $raw = Get-Content $Path -Raw
        try { $arr = $raw | ConvertFrom-Json } catch { Write-Warning "$name : invalid JSON"; return $out }
        if ($arr -isnot [array]) { $arr = @($arr) }
        foreach ($e in $arr) {
            $out.Add([pscustomobject]@{
                Source=$name; Format='json'; Id=$e.id; Goal=$e.goal; Domain=$e.domain
                Subdomain=$e.subdomain; Assistant=$e.summary; Raw=$e
                HasSteps=[bool]$e.steps
            })
        }
    }
    return $out
}

function Get-NormKey { param([string]$s)
    if (-not $s) { return "" }
    ($s.ToLower() -replace '[^a-z0-9 ]','' -replace '\s+',' ').Trim()
}

# ---------------------------------------------------------------- load
Write-Host "`n=============== SOURCE AUDIT ===============" -ForegroundColor Cyan
$all = New-Object System.Collections.Generic.List[object]
foreach ($f in $Files) {
    $rows = Read-Dataset $f
    Write-Host ("{0,-34} {1,6} records   [{2}]" -f (Split-Path $f -Leaf), $rows.Count, $rows[0].Format)
    foreach ($r in $rows) { $all.Add($r) }
}
Write-Host ("{0,-34} {1,6} records total" -f "COMBINED", $all.Count) -ForegroundColor Yellow

if ($all.Count -eq 0) { throw "Nothing loaded." }

# ---------------------------------------------------------------- schema
Write-Host "`n=============== SCHEMA COVERAGE ===============" -ForegroundColor Cyan
$jsonRows = @($all | Where-Object Format -eq 'json')
if ($jsonRows.Count) {
    $fields = 'id','goal','domain','subdomain','plan','steps','resolved','summary','recommendation','feedback','createdAt'
    foreach ($fld in $fields) {
        $have = @($jsonRows | Where-Object { $null -ne $_.Raw.$fld -and $_.Raw.$fld -ne '' }).Count
        $pct = [int](100*$have/$jsonRows.Count)
        $col = if ($pct -eq 100) {'Green'} elseif ($pct -ge 50) {'Yellow'} else {'Red'}
        Write-Host ("  {0,-14} {1,5}/{2}  {3,3}%" -f $fld, $have, $jsonRows.Count, $pct) -ForegroundColor $col
    }
} else { Write-Host "  (no .json source - schema fields only exist in the sessions format)" -ForegroundColor DarkGray }

# ---------------------------------------------------------------- ids
Write-Host "`n=============== ID CHECK ===============" -ForegroundColor Cyan
$withId = @($all | Where-Object { $_.Id })
$dupId  = @($withId | Group-Object Id | Where-Object Count -gt 1)
Write-Host ("  records with id : {0}" -f $withId.Count)
Write-Host ("  duplicate ids   : {0}" -f $dupId.Count) -ForegroundColor $(if($dupId.Count){'Red'}else{'Green'})
foreach ($g in ($dupId | Select-Object -First 5)) {
    Write-Host ("    {0}  x{1}  ({2})" -f $g.Name, $g.Count, (($g.Group.Source | Select-Object -Unique) -join ', ')) -ForegroundColor Red
}

# ---------------------------------------------------------------- exact dups
Write-Host "`n=============== EXACT DUPLICATE GOALS ===============" -ForegroundColor Cyan
$byGoal = $all | Group-Object { Get-NormKey $_.Goal } | Where-Object { $_.Name -and $_.Count -gt 1 }
Write-Host ("  duplicate goal groups : {0}" -f $byGoal.Count) -ForegroundColor $(if($byGoal.Count){'Yellow'}else{'Green'})
$crossSource = @($byGoal | Where-Object { ($_.Group.Source | Select-Object -Unique).Count -gt 1 })
Write-Host ("  ...of which span BOTH sources : {0}" -f $crossSource.Count) -ForegroundColor $(if($crossSource.Count){'Yellow'}else{'Green'})
foreach ($g in ($byGoal | Select-Object -First 8)) {
    Write-Host ("    x{0}  [{1}]  {2}" -f $g.Count, (($g.Group.Source|Select-Object -Unique) -join '+'), $g.Group[0].Goal.Substring(0,[Math]::Min(66,$g.Group[0].Goal.Length))) -ForegroundColor DarkYellow
}

# ---------------------------------------------------------------- near dups
Write-Host "`n=============== NEAR-DUPLICATE SCAN ===============" -ForegroundColor Cyan
Write-Host "  (comparing within 4-word prefix buckets)" -ForegroundColor DarkGray
$buckets = @{}
foreach ($r in $all) {
    $k = Get-NormKey $r.Goal
    if (-not $k) { continue }
    $p = ($k -split ' ' | Select-Object -First 4) -join ' '
    if (-not $buckets.ContainsKey($p)) { $buckets[$p] = New-Object System.Collections.Generic.List[object] }
    $buckets[$p].Add([pscustomobject]@{ Key=$k; Row=$r })
}
$near = New-Object System.Collections.Generic.List[object]
foreach ($b in $buckets.Values) {
    if ($b.Count -lt 2) { continue }
    for ($i=0; $i -lt $b.Count; $i++) {
        for ($j=$i+1; $j -lt $b.Count; $j++) {
            if ($b[$i].Key -eq $b[$j].Key) { continue }
            $len = [Math]::Max($b[$i].Key.Length, $b[$j].Key.Length)
            if ($len -eq 0) { continue }
            # cheap similarity: shared word ratio
            $w1 = $b[$i].Key -split ' '; $w2 = $b[$j].Key -split ' '
            $shared = @($w1 | Where-Object { $w2 -contains $_ }).Count
            $ratio = 2.0*$shared/($w1.Count + $w2.Count)
            if ($ratio -ge $NearDuplicateThreshold) {
                $near.Add([pscustomobject]@{ Score=[math]::Round($ratio,2); A=$b[$i].Row.Goal; B=$b[$j].Row.Goal
                                             SrcA=$b[$i].Row.Source; SrcB=$b[$j].Row.Source })
            }
        }
    }
}
Write-Host ("  near-duplicate pairs (>= {0}) : {1}" -f $NearDuplicateThreshold, $near.Count) -ForegroundColor $(if($near.Count){'Yellow'}else{'Green'})
foreach ($n in ($near | Sort-Object Score -Descending | Select-Object -First 8)) {
    Write-Host ("    {0}  [{1}] {2}" -f $n.Score, $n.SrcA, $n.A.Substring(0,[Math]::Min(58,$n.A.Length))) -ForegroundColor DarkYellow
    Write-Host ("          [{0}] {1}" -f $n.SrcB, $n.B.Substring(0,[Math]::Min(58,$n.B.Length))) -ForegroundColor DarkYellow
}

# ---------------------------------------------------------------- coverage
Write-Host "`n=============== DOMAIN COVERAGE ===============" -ForegroundColor Cyan
$all | Group-Object Domain | Sort-Object Count -Descending | Select-Object -First 12 |
    ForEach-Object { Write-Host ("  {0,-24} {1,5}" -f $_.Name, $_.Count) }
Write-Host ("  distinct domains    : {0}" -f (@($all | Select-Object -ExpandProperty Domain -Unique)).Count)
$subs = @($all | Where-Object Subdomain | Select-Object -ExpandProperty Subdomain -Unique)
Write-Host ("  distinct subdomains : {0}" -f $subs.Count)

# ---------------------------------------------------------------- verdict
$unique = @($all | Group-Object { Get-NormKey $_.Goal } | Where-Object Name).Count
Write-Host "`n=============== VERDICT ===============" -ForegroundColor Green
Write-Host ("  raw records        : {0}" -f $all.Count)
Write-Host ("  unique scenarios   : {0}" -f $unique) -ForegroundColor Cyan
Write-Host ("  redundant records  : {0}" -f ($all.Count - $unique)) -ForegroundColor $(if(($all.Count-$unique)){'Yellow'}else{'Green'})
if ($near.Count) {
    Write-Host ("  + {0} near-duplicate pairs worth reviewing manually" -f $near.Count) -ForegroundColor Yellow
}

# ---------------------------------------------------------------- merge
if ($Merge) {
    Write-Host "`n=============== MERGING ===============" -ForegroundColor Cyan
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $usedIds = New-Object 'System.Collections.Generic.HashSet[string]'
    $keptJson = New-Object System.Collections.Generic.List[object]
    $keptJsonl = New-Object System.Collections.Generic.List[string]
    $n = 0; $dropped = 0

    # prefer records that carry full schema (steps) so detail is not lost
    foreach ($r in ($all | Sort-Object @{E={-[int]$_.HasSteps}}, Source)) {
        $k = Get-NormKey $r.Goal
        if (-not $k) { $dropped++; continue }
        if (-not $seen.Add($k)) { $dropped++; continue }

        if ($r.Format -eq 'json') {
            $obj = $r.Raw
            $id = $obj.id
            if (-not $id -or -not $usedIds.Add($id)) {
                do { $n++; $id = "merged-{0:d5}" -f $n } while (-not $usedIds.Add($id))
                $obj | Add-Member -NotePropertyName id -NotePropertyValue $id -Force
            }
            if (-not $obj.subdomain) { $obj | Add-Member -NotePropertyName subdomain -NotePropertyValue $obj.domain -Force }
            if ($null -eq $obj.resolved) { $obj | Add-Member -NotePropertyName resolved -NotePropertyValue $true -Force }
            $keptJson.Add($obj)
            $cmds = if ($obj.steps) { ($obj.steps | ForEach-Object { "- $($_.command)" }) -join "`n" } else { "" }
            $sub = if ($obj.subdomain) { " ($($obj.subdomain))" } else { "" }
            $keptJsonl.Add((@{ messages=@(
                @{role='system';content="You are a Windows repair expert specializing in $($obj.domain)$sub problems. Diagnose with read-only commands first, then apply safe fixes."}
                @{role='user';content=$obj.goal}
                @{role='assistant';content="$($obj.summary)`nCommands used:`n$cmds`nRecommendation: $($obj.recommendation)"}
            )} | ConvertTo-Json -Depth 8 -Compress))
        } else {
            $keptJsonl.Add($r.Raw)
        }
    }

    $outJson  = "$OutPrefix-sessions.json"
    $outJsonl = "$OutPrefix-dataset.jsonl"
    if ($keptJson.Count)  { $keptJson  | ConvertTo-Json -Depth 12 | Set-Content $outJson -Encoding UTF8 }
    if ($keptJsonl.Count) { Set-Content $outJsonl -Value $keptJsonl -Encoding UTF8 }

    Write-Host ("  kept    : {0}" -f $seen.Count) -ForegroundColor Green
    Write-Host ("  dropped : {0} (duplicates)" -f $dropped) -ForegroundColor Yellow
    if ($keptJson.Count)  { Write-Host ("  wrote   : {0}  ({1} records)" -f $outJson, $keptJson.Count) -ForegroundColor Cyan }
    if ($keptJsonl.Count) { Write-Host ("  wrote   : {0}  ({1} lines)"   -f $outJsonl, $keptJsonl.Count) -ForegroundColor Cyan }
} else {
    Write-Host "`n(audit only - nothing written. Add -Merge to produce cleaned files.)" -ForegroundColor DarkGray
}

Write-Host "`nDone.`n" -ForegroundColor Green
