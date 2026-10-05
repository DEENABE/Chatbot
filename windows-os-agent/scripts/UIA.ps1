$script:SettingsPages = @('network-status', 'network-wifi', 'network-ethernet', 'network-cellular', 'network-airplanemode', 'bluetooth', 'display', 'nightlight', 'sound', 'powersleep', 'batterysaver', 'personalization', 'personalization-colors', 'taskbar', 'privacy-location', 'privacy-webcam', 'privacy-microphone', 'windowsupdate', 'storagesense')
function Open-SettingsPage([string]$Page) {
    if ($Page -notin $script:SettingsPages) { Fail 'PAGE_DENIED' 'Settings URI is not allowlisted' }
    if (-not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { Fail 'INTERACTIVE_SESSION_REQUIRED' 'Run in the signed-in desktop session, not as a Session 0 service' }
    # This launches the interactive Settings app deliberately; it is not a hidden helper.
    Start-Process -FilePath "ms-settings:$Page" | Out-Null
}
function Get-SettingsRoot([string]$Page) {
    Open-SettingsPage $Page
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        $processes = @(Get-Process -Name SystemSettings -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId })
        $roots = @()
        foreach ($process in $processes) {
            $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $process.Id)
            $roots += @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition))
        }
        if ($roots.Count -eq 1) { return $roots[0] }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    Fail 'UIA_WINDOW_UNAVAILABLE' 'Expected exactly one Settings window in the current desktop session'
}
function Get-UIAProfile([string]$Operation, [hashtable]$Parameters) {
    if (-not $script:Request.enableUia) { Fail 'UIA_DISABLED' 'Enable ENABLE_UIA only in an interactive desktop deployment. The direct API is unavailable for this operation.' }
    $build = [string](Read-Value 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' 'CurrentBuildNumber')
    $culture = [Globalization.CultureInfo]::CurrentUICulture.Name
    $profiles = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\config\uia-profiles.json') -Raw | ConvertFrom-Json).profiles
    $normalized = $Operation -replace '\.get$', '.set'
    $matches = @($profiles | Where-Object {
        $candidate = $_
        $matchesContext = $candidate.operation -ceq $normalized -and [string]$candidate.build -ceq $build -and $candidate.culture -ceq $culture
        if ($matchesContext -and $candidate.PSObject.Properties['when']) {
            foreach ($field in $candidate.when.PSObject.Properties) {
                if (-not $Parameters.ContainsKey($field.Name) -or $Parameters[$field.Name] -cne $field.Value) { $matchesContext = $false }
            }
        }
        $matchesContext
    })
    if ($matches.Count -ne 1) { Fail 'UIA_PROFILE_REQUIRED' "No unique trusted UIA profile for $normalized on Windows build $build ($culture). Calibrate the profile with Inspect-Settings.ps1; no control was changed." }
    return $matches[0]
}
function Get-UIATarget([string]$Operation, [hashtable]$Parameters) {
    $profile = Get-UIAProfile $Operation $Parameters
    $root = Get-SettingsRoot $profile.uri
    # Both ID and control type must match. Name can add a discriminator, never replace an ID.
    if ([string]::IsNullOrWhiteSpace($profile.automationId)) { Fail 'UIA_PROFILE_INVALID' 'A nonempty AutomationId is required' }
    $type = [System.Windows.Automation.ControlType]::LookupById([int]$profile.controlType)
    if ($null -eq $type) { Fail 'UIA_PROFILE_INVALID' 'Unknown control type' }
    $idCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$profile.automationId)
    $typeCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
    $condition = New-Object System.Windows.Automation.AndCondition($idCondition, $typeCondition)
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $found = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
        if ($profile.PSObject.Properties['name']) {
            $name = [string]$profile.name
            if ($name.Contains('{name}') -and $Parameters.ContainsKey('name')) { $name = $name.Replace('{name}', $Parameters.name) }
            $found = @($found | Where-Object { $_.Current.Name -ceq $name })
        }
        $found = @($found | Where-Object { -not $_.Current.IsOffscreen })
        if ($found.Count -eq 1) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($found.Count -ne 1) { Fail 'UIA_TARGET_AMBIGUOUS' "Expected one exact visible control; found $($found.Count). No input was sent." }
    if (-not $found[0].Current.IsEnabled) { Fail 'ACCESS_DENIED' 'The Windows control is disabled. Do not bypass policy or privilege restrictions.' }
    return @{ profile = $profile; element = $found[0] }
}
function Read-UIAValue($Target) {
    $element = $Target.element
    switch ($Target.profile.pattern) {
        'toggle' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); return [ordered]@{ state = $pattern.Current.ToggleState.ToString(); name = $element.Current.Name } }
        'range' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern); return [ordered]@{ value = $pattern.Current.Value; minimum = $pattern.Current.Minimum; maximum = $pattern.Current.Maximum; readOnly = $pattern.Current.IsReadOnly } }
        'selection' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); return [ordered]@{ selected = $pattern.Current.IsSelected; name = $element.Current.Name } }
        'value' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); return [ordered]@{ value = $pattern.Current.Value; readOnly = $pattern.Current.IsReadOnly } }
        default { Fail 'UIA_PROFILE_INVALID' 'Only toggle, range, selection and value patterns are supported; arbitrary clicks and InvokePattern are intentionally unavailable.' }
    }
}
function Read-UIAOperation([string]$Operation, [hashtable]$Parameters) { return Read-UIAValue (Get-UIATarget $Operation $Parameters) }
function Set-UIAOperation([string]$Operation, [hashtable]$Parameters) {
    $target = Get-UIATarget $Operation $Parameters
    $element = $target.element
    switch ($target.profile.pattern) {
        'toggle' {
            if (-not $Parameters.ContainsKey('enabled')) { Fail 'UIA_PROFILE_INVALID' 'This operation has no enabled value' }
            $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
            if ($pattern.Current.ToggleState.ToString() -eq 'Indeterminate') { Fail 'UIA_INDETERMINATE' 'Tri-state switch requires manual action' }
            $desired = if ($Parameters.enabled) { 'On' } else { 'Off' }
            if ($pattern.Current.ToggleState.ToString() -ne $desired) { $pattern.Toggle() }
        }
        'range' {
            $pattern = $element.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
            if (-not $Parameters.ContainsKey('percent') -or $pattern.Current.IsReadOnly -or $Parameters.percent -lt $pattern.Current.Minimum -or $Parameters.percent -gt $pattern.Current.Maximum) { Fail 'UIA_VALUE_DENIED' 'Range is read-only or value is outside its bounds' }
            $pattern.SetValue([double]$Parameters.percent)
        }
        'selection' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); if (-not $pattern.Current.IsSelected) { $pattern.Select() } }
        'value' {
            if (-not $Parameters.ContainsKey('color')) { Fail 'UIA_PROFILE_INVALID' 'Only accent color text entry is supported' }
            $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($pattern.Current.IsReadOnly) { Fail 'ACCESS_DENIED' 'The control is read-only' }
            $pattern.SetValue($Parameters.color)
        }
        default { Fail 'UIA_PROFILE_INVALID' 'Unsupported UIA pattern' }
    }
    return [ordered]@{ engine = 'uia'; selector = $target.profile.automationId }
}
function Verify-UIAOperation([string]$Operation, [hashtable]$Parameters, $After) {
    if ($Parameters.ContainsKey('percent')) { return [bool]([Math]::Abs($After.value - $Parameters.percent) -le 1) }
    if ($Parameters.ContainsKey('enabled')) { return [bool]($After.state -eq $(if ($Parameters.enabled) { 'On' } else { 'Off' })) }
    if ($Operation -eq 'audio.default') {
        Load-Native
        $endpoints = @([LocalOS.Audio]::Inspect().endpoints | Where-Object { $_.direction -eq $Parameters.direction -and $_.name -ceq $Parameters.name -and $_.multimediaDefault })
        return [bool]($endpoints.Count -eq 1)
    }
    # Text entry alone does not prove that the accent color was applied by Settings.
    if ($Operation -eq 'accent.set') { return $null }
    return $null
}
