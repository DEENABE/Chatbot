# Private worker. Only the authenticated Node executor supplies JSON over stdin.
# No model-generated code is evaluated and no ExecutionPolicy bypass is requested.
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:MutationStarted = $false
try {
    . (Join-Path $PSScriptRoot 'Common.ps1')
    . (Join-Path $PSScriptRoot 'Radio.ps1')
    . (Join-Path $PSScriptRoot 'GroupPolicy.ps1')
    . (Join-Path $PSScriptRoot 'UIA.ps1')
    . (Join-Path $PSScriptRoot 'Queries.ps1')
    . (Join-Path $PSScriptRoot 'Mutations.ps1')
    $raw = [Console]::In.ReadToEnd()
    if ($raw.Length -gt 1048576) { Fail 'INPUT_LIMIT' 'Worker input exceeds its size budget' }
    $script:Request = $raw | ConvertFrom-Json
    if ($script:Request.mode -notin @('execute', 'preview')) { Fail 'INVALID_MODE' 'Unknown worker mode' }
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\config\operations.json') -Raw | ConvertFrom-Json
    $definition = @($manifest | Where-Object id -CEQ $script:Request.operation)
    if ($definition.Count -ne 1) { Fail 'UNKNOWN_OPERATION' 'Operation not in the manifest' }
    $definition = $definition[0]
    $parameters = @{}
    foreach ($property in $script:Request.parameters.PSObject.Properties) { $parameters[$property.Name] = $property.Value }
    $operation = [string]$script:Request.operation
    $isWrite = $definition.risk -ne 'read'
    if ($isWrite) { Assert-Preconditions $operation $parameters }
    $forceUia = $script:Request.PSObject.Properties['engine'] -and $script:Request.engine -eq 'uia'
    $before = if ($forceUia) { Read-UIAOperation $operation $parameters } else { Read-Operation $operation $parameters }
    if (-not $isWrite -or $script:Request.mode -eq 'preview') {
        $envelope = @{ ok = $true; status = 'observed'; operation = $operation; data = $before }
    } else {
        if ($script:Request.PSObject.Properties['expectedBefore']) {
            if ((Get-CanonicalState $before) -cne (Get-CanonicalState $script:Request.expectedBefore)) { Fail 'STATE_CHANGED' 'State changed between approval and worker execution. No mutation was attempted.' }
        }
        $script:MutationStarted = $true
        $effect = if ($forceUia) { Set-UIAOperation $operation $parameters } else { Apply-Operation $operation $parameters $before }
        $after = $null; $verified = $null
        for ($attempt = 0; $attempt -lt 4; $attempt++) {
            $after = if ($forceUia) { Read-UIAOperation $operation $parameters } else { Read-Operation $operation $parameters }
            $verified = if ($forceUia) { Verify-UIAOperation $operation $parameters $after } else { Verify-Operation $operation $parameters $after $effect }
            if ($null -eq $verified -or $verified) { break }
            Start-Sleep -Milliseconds 400
        }
        if ($null -ne $verified -and -not $verified) {
            $envelope = @{ ok = $false; operation = $operation; error = @{ code = 'VERIFICATION_FAILED'; message = 'The requested state was not verified. Do not blindly repeat this change.'; outcomeUnknown = $true }; before = $before; after = $after; effect = $effect }
        } else {
            $status = if ($verified) { 'verified' } else { 'executed_unverified' }
            if ($null -ne $effect -and $effect.Contains('status')) { $status = $effect.status }
            $envelope = @{ ok = $true; operation = $operation; status = $status; verified = $verified; before = $before; after = $after; effect = $effect }
        }
    }
} catch {
    $code = if ($_.Exception.Data.Contains('AgentCode')) { $_.Exception.Data['AgentCode'] } else { 'WINDOWS_ERROR' }
    if ($_.Exception -is [UnauthorizedAccessException]) { $code = 'ACCESS_DENIED' }
    $envelope = @{ ok = $false; error = @{ code = $code; message = $_.Exception.Message; outcomeUnknown = $script:MutationStarted; hresult = $_.Exception.HResult } }
}
[Console]::Out.WriteLine(($envelope | ConvertTo-Json -Depth 16 -Compress))
