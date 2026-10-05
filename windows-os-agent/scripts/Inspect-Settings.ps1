param([Parameter(Mandatory=$true)][string]$Page)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'UIA.ps1')
$root = Get-SettingsRoot $Page
$elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$controls = @($elements | Select-Object -First 1000 | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.AutomationId } | ForEach-Object {
    [pscustomobject]@{ automationId = $_.Current.AutomationId; name = $_.Current.Name; controlType = $_.Current.ControlType.Id; enabled = $_.Current.IsEnabled; patterns = @($_.GetSupportedPatterns() | ForEach-Object ProgrammaticName) }
})
[pscustomobject]@{ build = Read-Value 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' 'CurrentBuildNumber'; culture = [Globalization.CultureInfo]::CurrentUICulture.Name; uri = $Page; controls = $controls } | ConvertTo-Json -Depth 8
