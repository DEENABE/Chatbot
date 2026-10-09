# Code-owned ELEVATED helper for the few Windows settings that need administrator rights to change.
#
# It is never started silently: SettingsElevator.js launches it through a normal Windows UAC prompt, only after the human
# ConfirmationGate approved the change. It is read from the protected install folder, hashed against a digest pinned in the
# app (SystemSettingsAdminDigest.js) and run from memory, so what runs elevated is exactly what shipped.
#
# Input: -Id (one of the ids below) and -Value (a boolean or a whole number). Nothing else is accepted and nothing from the
# request is executed, interpolated into a command, or used as a path. There is no result file and no output channel: the
# outcome is the process exit code, and the app verifies the change independently by reading the setting back without elevation.
#   0 applied   2 invalid request   3 integrity (set by the bootstrap)   4 prerequisite not met   5 not supported on this PC
#   6 failed    7 applied, restart needed   8 not elevated
param([string]$Id, $Value)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$global:AdminExit = 6
function Quit([int]$code) { throw "ADMIN_CODE:$code" }

$boolIds = @(
    'firewall-private', 'firewall-public', 'firewall-domain', 'hibernate', 'fast-startup', 'remote-desktop', 'long-paths',
    'feature-wsl', 'feature-virtual-machine-platform', 'feature-hyper-v', 'feature-windows-sandbox'
)
$hourIds = @('active-hours-start', 'active-hours-end')
$profiles = @{ 'firewall-private' = 'Private'; 'firewall-public' = 'Public'; 'firewall-domain' = 'Domain' }
$features = @{
    'feature-wsl' = 'Microsoft-Windows-Subsystem-Linux'; 'feature-virtual-machine-platform' = 'VirtualMachinePlatform'
    'feature-hyper-v' = 'Microsoft-Hyper-V-All'; 'feature-windows-sandbox' = 'Containers-DisposableClientVM'
}
$powerKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power'
$bootPowerKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power'
$terminalKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server'
$fileSystemKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'
$activeHoursKey = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
$remoteDesktopRuleGroup = '@FirewallAPI.dll,-28752' # language-independent "Remote Desktop" firewall rule group

function Set-HklmDword([string]$path, [string]$name, [int]$value) {
    if (-not (Test-Path -Path $path)) { [void](New-Item -Path $path -Force) }
    Set-ItemProperty -Path $path -Name $name -Value $value -Type DWord
}
function Get-HklmValue([string]$path, [string]$name, $default) {
    $v = (Get-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue).$name
    if ($null -eq $v) { return $default }
    return $v
}

try {
    $restartNeeded = $false
    # Validate the request first, then insist on really being elevated.
    if ($boolIds -contains $Id) { if ($Value -isnot [bool]) { Quit 2 } }
    elseif ($hourIds -contains $Id) { if ($Value -isnot [int] -or $Value -lt 0 -or $Value -gt 23) { Quit 2 } }
    else { Quit 2 }
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Quit 8 }

    if ($profiles.ContainsKey($Id)) {
        Set-NetFirewallProfile -Name $profiles[$Id] -Enabled $(if ($Value) { 'True' } else { 'False' })
    }
    elseif ($Id -eq 'hibernate') {
        & "$env:SystemRoot\System32\powercfg.exe" /hibernate $(if ($Value) { 'on' } else { 'off' }) | Out-Null
        if ($LASTEXITCODE -ne 0) { Quit 6 }
    }
    elseif ($Id -eq 'fast-startup') {
        if ($Value -and (Get-HklmValue $powerKey 'HibernateEnabled' 0) -ne 1) { Quit 4 } # Fast Startup is a hibernate feature
        Set-HklmDword $bootPowerKey 'HiberbootEnabled' $(if ($Value) { 1 } else { 0 })
    }
    elseif ($Id -eq 'remote-desktop') {
        if ([int](Get-CimInstance -ClassName Win32_OperatingSystem).OperatingSystemSKU -in 98, 99, 100, 101) { Quit 5 } # Home cannot host RDP
        Set-HklmDword $terminalKey 'fDenyTSConnections' $(if ($Value) { 0 } else { 1 })
        if ($Value) { Enable-NetFirewallRule -Group $remoteDesktopRuleGroup -ErrorAction SilentlyContinue }
        else { Disable-NetFirewallRule -Group $remoteDesktopRuleGroup -ErrorAction SilentlyContinue }
    }
    elseif ($Id -eq 'long-paths') {
        Set-HklmDword $fileSystemKey 'LongPathsEnabled' $(if ($Value) { 1 } else { 0 })
    }
    elseif ($hourIds -contains $Id) {
        $start = if ($Id -eq 'active-hours-start') { $Value } else { [int](Get-HklmValue $activeHoursKey 'ActiveHoursStart' 8) }
        $end = if ($Id -eq 'active-hours-end') { $Value } else { [int](Get-HklmValue $activeHoursKey 'ActiveHoursEnd' 17) }
        $span = ($end - $start + 24) % 24
        if ($span -eq 0 -or $span -gt 18) { Quit 4 } # Windows allows an active-hours window of at most 18 hours
        Set-HklmDword $activeHoursKey $(if ($Id -eq 'active-hours-start') { 'ActiveHoursStart' } else { 'ActiveHoursEnd' }) $Value
    }
    elseif ($features.ContainsKey($Id)) {
        $name = $features[$Id]
        $present = Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='$name'" -ErrorAction Stop
        if (-not $present) { Quit 5 } # this edition of Windows does not include the feature
        $result = if ($Value) { Enable-WindowsOptionalFeature -Online -FeatureName $name -NoRestart -All } else { Disable-WindowsOptionalFeature -Online -FeatureName $name -NoRestart }
        if ($result.RestartNeeded) { $restartNeeded = $true }
    }
    else { Quit 2 }

    $global:AdminExit = $(if ($restartNeeded) { 7 } else { 0 })
}
catch {
    $m = $_.Exception.Message
    $global:AdminExit = $(if ($m -like 'ADMIN_CODE:*') { [int]$m.Substring(11) } else { 6 })
}
