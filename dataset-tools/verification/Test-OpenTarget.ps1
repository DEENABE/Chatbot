<#
.SYNOPSIS
    Tests the FileService.openTarget resolver chain WITHOUT launching anything.

.DESCRIPTION
    Extracts the OPEN_TARGET_SCRIPT resolver logic and runs it in "dry" mode:
    it walks the same alias -> PATH -> App Paths -> Start menu chain and
    reports what WOULD be launched for each name, so you can confirm the
    resolver finds your installed apps before wiring it into the agent.

    Nothing is started. No system state is changed.

.EXAMPLE
    .\Test-OpenTarget.ps1
    .\Test-OpenTarget.ps1 -Targets 'chrome','word','spotify','settings'
#>
[CmdletBinding()]
param(
    [string[]]$Targets = @(
        'notepad', 'calculator', 'paint', 'wordpad', 'snipping tool',
        'chrome', 'edge', 'firefox',
        'word', 'excel', 'powerpoint', 'outlook',
        'vscode', 'notepad++', 'terminal', 'powershell', 'cmd',
        'task manager', 'device manager', 'services', 'event viewer',
        'registry editor', 'control panel', 'settings',
        'spotify', 'discord', 'steam', 'vlc', 'zoom', 'teams',
        'explorer', 'C:\', 'https://example.com'
    )
)

$alias = @{
    'chrome'='chrome.exe'; 'google chrome'='chrome.exe'; 'browser'='msedge.exe'
    'edge'='msedge.exe'; 'microsoft edge'='msedge.exe'; 'firefox'='firefox.exe'
    'brave'='brave.exe'; 'opera'='opera.exe'
    'word'='winword.exe'; 'microsoft word'='winword.exe'; 'ms word'='winword.exe'
    'excel'='excel.exe'; 'microsoft excel'='excel.exe'; 'ms excel'='excel.exe'
    'powerpoint'='powerpnt.exe'; 'ppt'='powerpnt.exe'
    'outlook'='outlook.exe'; 'access'='msaccess.exe'; 'onenote'='onenote.exe'
    'vscode'='code.cmd'; 'vs code'='code.cmd'; 'visual studio code'='code.cmd'; 'code'='code.cmd'
    'notepad'='notepad.exe'; 'wordpad'='write.exe'; 'paint'='mspaint.exe'
    'calculator'='calc.exe'; 'calc'='calc.exe'
    'cmd'='cmd.exe'; 'command prompt'='cmd.exe'; 'terminal'='wt.exe'; 'windows terminal'='wt.exe'
    'powershell'='powershell.exe'; 'pwsh'='pwsh.exe'
    'explorer'='explorer.exe'; 'file explorer'='explorer.exe'; 'files'='explorer.exe'
    'task manager'='taskmgr.exe'; 'taskmgr'='taskmgr.exe'
    'device manager'='devmgmt.msc'; 'disk management'='diskmgmt.msc'
    'services'='services.msc'; 'event viewer'='eventvwr.msc'
    'computer management'='compmgmt.msc'; 'performance monitor'='perfmon.exe'
    'resource monitor'='resmon.exe'; 'system information'='msinfo32.exe'
    'registry editor'='regedit.exe'; 'regedit'='regedit.exe'
    'control panel'='control.exe'; 'control'='control.exe'
    'settings'='ms-settings:'; 'windows settings'='ms-settings:'
    'snipping tool'='snippingtool.exe'; 'snip'='snippingtool.exe'
    'notepad++'='notepad++.exe'; 'sublime'='sublime_text.exe'
    'spotify'='spotify.exe'; 'discord'='discord.exe'; 'steam'='steam.exe'
    'vlc'='vlc.exe'; 'zoom'='zoom.exe'; 'slack'='slack.exe'
    'teams'='ms-teams.exe'; 'microsoft teams'='ms-teams.exe'
    'photoshop'='photoshop.exe'; 'obs'='obs64.exe'; 'git bash'='git-bash.exe'
}

# Cache the Start menu once - Get-StartApps is slow.
$startApps = @()
try { $startApps = @(Get-StartApps -ErrorAction Stop) } catch {
    Write-Warning 'Get-StartApps unavailable - step 4 will be skipped.'
}
Write-Host "Start menu entries found: $($startApps.Count)" -ForegroundColor DarkGray
Write-Host ''

function Test-Resolvable([string]$Candidate) {
    # A launchable candidate is either a resolvable command, an existing file,
    # or a protocol/URL. .msc and ms-settings: are handled by the shell.
    if ($Candidate -match '^[a-zA-Z][a-zA-Z0-9+.\-]*:' -and $Candidate -notmatch '^[a-zA-Z]:[\\/]') { return $true }
    if (Test-Path -LiteralPath $Candidate -ErrorAction SilentlyContinue) { return $true }
    if (Get-Command -Name $Candidate -ErrorAction SilentlyContinue) { return $true }
    if ($Candidate -match '\.msc$') { return (Test-Path -LiteralPath (Join-Path $env:SystemRoot "System32\$Candidate")) }
    return $false
}

$results = foreach ($t in $Targets) {
    $t = $t.Trim()
    $via = $null; $resolved = $null

    # 0. explicit path / UNC / URL / protocol
    if ($t -match '^[a-zA-Z]:[\\/]' -or $t -match '^\\\\' -or $t -match '^[a-zA-Z][a-zA-Z0-9+.\-]*:') {
        if (Test-Path -LiteralPath $t -ErrorAction SilentlyContinue) { $via='path'; $resolved=$t }
        elseif ($t -match '^[a-zA-Z][a-zA-Z0-9+.\-]*:') { $via='protocol'; $resolved=$t }
    }

    # 1. alias
    if (-not $via) {
        $key = $t.ToLowerInvariant()
        if ($alias.ContainsKey($key)) {
            $c = $alias[$key]
            if (Test-Resolvable $c) { $via='alias'; $resolved=$c }
        }
    }

    # 2. PATH
    if (-not $via) {
        $cmd = Get-Command -Name $t -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd -and $cmd.Source) { $via='path-env'; $resolved=$cmd.Source }
    }

    # 3. App Paths
    if (-not $via) {
        foreach ($name in @($t, "$t.exe")) {
            foreach ($hive in @('HKLM:', 'HKCU:')) {
                $reg = Join-Path $hive "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$name"
                if (Test-Path -LiteralPath $reg) {
                    $exe = (Get-ItemProperty -LiteralPath $reg).'(default)'
                    if ($exe) { $via='app-paths'; $resolved=$exe; break }
                }
            }
            if ($via) { break }
        }
    }

    # 4. Start menu (desktop + UWP)
    if (-not $via -and $startApps.Count) {
        $match = @($startApps | Where-Object { $_.Name -ieq $t })
        if (-not $match) { $match = @($startApps | Where-Object { $_.Name -ilike "$t*" }) }
        if (-not $match) { $match = @($startApps | Where-Object { $_.Name -ilike "*$t*" }) }
        if ($match) { $via='start-menu'; $resolved=$match[0].Name }
    }

    [pscustomobject]@{
        Target   = $t
        Resolved = if ($via) { $resolved } else { '--' }
        Via      = if ($via) { $via } else { 'NOT FOUND' }
        Status   = if ($via) { 'OK' } else { 'MISS' }
    }
}

$results | Format-Table -AutoSize

$ok   = @($results | Where-Object Status -eq 'OK').Count
$miss = @($results | Where-Object Status -eq 'MISS').Count
Write-Host ''
Write-Host "Resolvable: $ok    Not found: $miss" -ForegroundColor $(if ($miss) { 'Yellow' } else { 'Green' })
if ($miss) {
    Write-Host ''
    Write-Host 'Not found (these are apps you do not have installed, or names worth adding to the alias table):' -ForegroundColor DarkYellow
    $results | Where-Object Status -eq 'MISS' | ForEach-Object { Write-Host "  - $($_.Target)" }
}
Write-Host ''
Write-Host 'Nothing was launched. This script only resolves names.' -ForegroundColor DarkGray
