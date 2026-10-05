function Wait-WinRT($Operation, [Type]$ResultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait(15000)) { Fail 'TIMEOUT' 'WinRT radio request timed out' }
    return $task.Result
}
function Get-Radios {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType=WindowsRuntime]
    return @(Wait-WinRT ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]))
}
function Get-RadioState {
    return @(Get-Radios | ForEach-Object { [pscustomobject]@{ name = $_.Name; kind = $_.Kind.ToString(); state = $_.State.ToString() } } | Sort-Object kind, name)
}
function Set-RadioState($Parameters) {
    $radios = @(Get-Radios | Where-Object { $_.Kind.ToString() -eq $Parameters.kind })
    if ($radios.Count -ne 1) { Fail 'AMBIGUOUS_RADIO' "Expected one $($Parameters.kind) radio; found $($radios.Count)" }
    # RequestAccessAsync may require consent. Never automate consent or switch engines to bypass a denial.
    $access = Wait-WinRT ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
    if ($access.ToString() -ne 'Allowed') { Fail 'ACCESS_DENIED' "Radio access: $access" }
    $desired = if ($Parameters.enabled) { [Windows.Devices.Radios.RadioState]::On } else { [Windows.Devices.Radios.RadioState]::Off }
    $result = Wait-WinRT ($radios[0].SetStateAsync($desired)) ([Windows.Devices.Radios.RadioAccessStatus])
    if ($result.ToString() -ne 'Allowed') { Fail 'ACCESS_DENIED' "Radio change: $result" }
}
