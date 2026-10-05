function Get-GpoTarget([string]$Name) {
    $policy = Get-Policy
    $property = $policy.groupPolicy.PSObject.Properties[$Name]
    if ($null -eq $property) { Fail 'POLICY_DENIED' 'Local GPO target is not allowlisted' }
    $target = $property.Value
    if ($target.scope -notin @('User', 'Computer') -or $target.key -notmatch '^Software\\Policies\\[A-Za-z0-9 _\\-]+$' -or $target.name -notmatch '^[A-Za-z0-9_-]+$') { Fail 'POLICY_INVALID' 'Invalid Local GPO configuration' }
    return $target
}
function Get-LgpoTool {
    $config = (Get-Policy).lgpo
    if (-not $config.path -or $config.sha256 -notmatch '^[a-fA-F0-9]{64}$') { Fail 'LGPO_REQUIRED' 'Install Microsoft LGPO from the Security Compliance Toolkit and configure its absolute path and SHA-256 in policy.json.' }
    $path = Assert-LocalFile $config.path @('.exe')
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $config.sha256) { Fail 'LGPO_HASH_MISMATCH' 'LGPO executable no longer matches the pinned hash' }
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') { Fail 'LGPO_SIGNATURE_INVALID' 'LGPO must carry a valid Microsoft signature' }
    return $path
}
function Read-LocalGpo([string]$Name) {
    $target = Get-GpoTarget $Name
    $exe = Get-LgpoTool
    $section = if ($target.scope -eq 'User') { 'User' } else { 'Machine' }
    $file = Join-Path $env:SystemRoot "System32\GroupPolicy\$section\Registry.pol"
    $value = $null
    if (Test-Path -LiteralPath $file) {
        $switch = if ($target.scope -eq 'User') { '/u' } else { '/m' }
        $output = & $exe /parse $switch $file 2>&1
        if ($LASTEXITCODE -ne 0) { Fail 'LGPO_FAILED' 'LGPO could not parse Registry.pol' }
        $lines = @($output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -and -not $_.StartsWith(';') })
        for ($i=0; $i -lt $lines.Count-3; $i++) {
            if ($lines[$i] -ieq $target.scope -and $lines[$i+1] -ieq $target.key -and $lines[$i+2] -ieq $target.name) { $value = $lines[$i+3] }
        }
    }
    $hive = if ($target.scope -eq 'User') { 'HKCU:\' } else { 'HKLM:\' }
    return [ordered]@{ target = $Name; scope = $target.scope; configured = $value; effective = Read-Value ($hive + $target.key) $target.name }
}
function Set-LocalGpo([string]$Name, [int]$Value) {
    Require-Admin
    if ($Value -notin @(0, 1)) { Fail 'INVALID_ARGUMENTS' 'Local GPO value must be zero or one' }
    $target = Get-GpoTarget $Name
    $exe = Get-LgpoTool
    $file = Join-Path ([IO.Path]::GetTempPath()) (([guid]::NewGuid().ToString()) + '.lgpo.txt')
    $content = "$($target.scope)`r`n$($target.key)`r`n$($target.name)`r`nDWORD:$Value`r`n"
    try {
        [IO.File]::WriteAllText($file, $content, [Text.Encoding]::Unicode)
        $output = & $exe /t $file 2>&1
        if ($LASTEXITCODE -ne 0) { Fail 'LGPO_FAILED' ($output -join "`n") }
        $null = Invoke-NativeCommand 'gpupdate.exe' @("/target:$($target.scope.ToLowerInvariant())", '/force', '/wait:20')
    } finally { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } }
}
