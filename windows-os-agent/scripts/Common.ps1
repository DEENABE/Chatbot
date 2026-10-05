Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail([string]$Code, [string]$Message) {
    $exception = New-Object System.InvalidOperationException($Message)
    $exception.Data['AgentCode'] = $Code
    throw $exception
}
function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { return (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
    finally { $identity.Dispose() }
}
function Require-Admin { if (-not (Test-Admin)) { Fail 'ADMIN_REQUIRED' 'Restart the trusted server in an elevated terminal under the same user account. UAC is never automated.' } }
function Load-Native { if (-not ('LocalOS.Desktop' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'Native.cs') } }
function Invoke-NativeCommand([string]$File, [string[]]$Arguments) {
    $allowed = @('netsh.exe', 'powercfg.exe', 'gpresult.exe', 'gpupdate.exe')
    if ($File -notin $allowed) { Fail 'COMMAND_DENIED' 'Native command not allowlisted' }
    $output = & (Join-Path $env:SystemRoot "System32\$File") @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { Fail 'NATIVE_COMMAND_FAILED' ("$File exited $LASTEXITCODE : " + ($output -join "`n")) }
    return ($output -join "`n")
}
function Read-Value([string]$Path, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $key = Get-Item -LiteralPath $Path
    try { return $key.GetValue($Name, $null) } finally { $key.Close() }
}
function Write-Value([string]$Path, [string]$Name, $Value, [string]$Type = 'DWord') {
    if (-not (Test-Path -LiteralPath $Path)) { $null = New-Item -Path $Path -Force }
    $null = New-ItemProperty -LiteralPath $Path -Name $Name -Value $Value -PropertyType $Type -Force
}
function Get-Policy { return Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\config\policy.json') -Raw | ConvertFrom-Json }
function Get-CanonicalState($Value) {
    # Normalize native enums/types through JSON first; recursively sort property names for stable comparisons.
    $normalized = ConvertTo-Json -InputObject $Value -Depth 20 -Compress | ConvertFrom-Json
    function Sort-State($Item) {
        if ($null -eq $Item) { return $null }
        if ($Item -is [System.Management.Automation.PSCustomObject]) {
            $sorted = [ordered]@{}
            foreach ($p in @($Item.PSObject.Properties | Sort-Object Name)) { $sorted[$p.Name] = Sort-State $p.Value }
            return $sorted
        }
        if ($Item -is [array]) { $result = @(); foreach ($entry in $Item) { $result += ,(Sort-State $entry) }; return ,$result }
        return $Item
    }
    return ConvertTo-Json -InputObject (Sort-State $normalized) -Depth 20 -Compress
}
function Get-RegistryTarget([string]$Name) {
    $policy = Get-Policy
    $property = $policy.registry.PSObject.Properties[$Name]
    if ($null -eq $property) { Fail 'POLICY_DENIED' 'Registry target not allowlisted' }
    $target = $property.Value
    if ($target.path -notmatch '^HK(CU|LM):\\' -or $target.path -match '\.\.') { Fail 'POLICY_INVALID' 'Invalid registry target configuration' }
    return $target
}
function Assert-LocalFile([string]$Path, [string[]]$Extensions) {
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.Substring(2).Contains(':')) { Fail 'PATH_DENIED' 'Only absolute local paths without alternate data streams are allowed' }
    $file = Get-Item -LiteralPath $Path -Force
    if ($file.PSIsContainer -or $file.Extension.ToLowerInvariant() -notin $Extensions) { Fail 'PATH_DENIED' 'Unsupported file type' }
    $cursor = $file
    while ($null -ne $cursor) {
        if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'PATH_DENIED' 'Reparse points are not permitted' }
        if ($cursor -is [IO.FileInfo]) { $cursor = $cursor.Directory } else { $cursor = $cursor.Parent }
    }
    return $file.FullName
}
function Get-TemporaryFiles([int]$Days, [int]$Limit) {
    $root = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $profile = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\') + '\'
    if (-not $root.StartsWith($profile, [StringComparison]::OrdinalIgnoreCase)) { Fail 'TEMP_PATH_DENIED' 'Temp directory must be beneath the current user profile' }
    $rootItem = Get-Item -LiteralPath $root -Force
    $cursor = $rootItem
    while ($null -ne $cursor) {
        if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'TEMP_PATH_DENIED' 'Temp directory has a reparse-point ancestor' }
        $cursor = $cursor.Parent
    }
    # Walk explicitly: never recurse into junctions/symlinks. Only regular files are candidates.
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue($root)
    $result = New-Object 'System.Collections.Generic.List[object]'
    $visited = 0
    while ($queue.Count -gt 0 -and $result.Count -lt $Limit -and $visited -lt 10000) {
        $dir = $queue.Dequeue(); $visited++
        foreach ($entry in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue | Sort-Object FullName)) {
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            if (-not $entry.FullName.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
            if ($entry.PSIsContainer) { $queue.Enqueue($entry.FullName) }
            elseif ($entry.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-$Days)) {
                $result.Add([pscustomobject]@{ path = $entry.FullName; bytes = $entry.Length; lastWriteUtc = $entry.LastWriteTimeUtc.ToString('o') })
                if ($result.Count -ge $Limit) { break }
            }
        }
    }
    return $result.ToArray()
}
