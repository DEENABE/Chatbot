# Code-owned Windows settings helper. One JSON request per stdin line, one JSON result per stdout line (the request's "id", if any,
# is echoed back). It runs either one-shot (send a request, close stdin) or as a long-lived worker (keep stdin open): the C# groups
# below are compiled once per process, so a warm worker answers in milliseconds instead of re-paying ~0.3 s per group on every call.
#   {"action":"list"} | {"action":"get","id":"volume"} | {"action":"set","id":"volume","value":30}
# Only the ids below exist. Nothing from the request is ever executed, interpolated into a command, or used as a
# path: `id` selects a code branch and `value` must be a boolean, a bounded integer or one of a fixed list of
# option names (all re-validated here).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Emit/Fail end the CURRENT request from any depth: stash the result and unwind with a sentinel (the process keeps running).
function Emit($o) { $script:Result = $o; throw 'EMIT' }
function Fail($code, $message) { Emit @{ success = $false; code = $code; message = $message } }
function Unavailable($why) { throw [System.InvalidOperationException]::new("UNAVAILABLE:$why") }

$limits = @{
    brightness = @(10, 100); volume = @(0, 100); 'mic-volume' = @(0, 100); 'screen-timeout' = @(0, 720); 'sleep-timeout' = @(0, 720)
    'mouse-speed' = @(1, 20); 'scroll-lines' = @(1, 100); 'double-click-speed' = @(200, 900); 'keyboard-repeat-rate' = @(0, 31); 'cursor-blink-rate' = @(200, 1200)
    'hibernate-timeout' = @(0, 1440); 'disk-timeout' = @(0, 1440); 'lock-screen-timeout' = @(0, 60)
    'dim-timeout' = @(0, 1440); 'max-processor-state' = @(20, 100); 'battery-saver-threshold' = @(0, 100)
    'default-brightness' = @(10, 100); 'unattended-sleep-timeout' = @(0, 1440); 'low-battery-level' = @(5, 100); 'critical-battery-level' = @(3, 50); 'battery-saver-brightness' = @(10, 100)
    'caret-width' = @(1, 20); 'horizontal-scroll-chars' = @(1, 100)
    'pointer-trails' = @(0, 20); 'keyboard-repeat-delay' = @(0, 3); 'menu-show-delay' = @(0, 4000)
    'active-hours-start' = @(0, 23); 'active-hours-end' = @(0, 23)
}
$choices = @{
    'power-mode' = @('best-power-efficiency', 'balanced', 'best-performance')
    'lid-close-action' = @('do-nothing', 'sleep', 'hibernate', 'shut-down')
    'power-button-action' = @('do-nothing', 'sleep', 'hibernate', 'shut-down')
    'mouse-primary-button' = @('left', 'right')
    'wake-timers' = @('disabled', 'enabled', 'important-only')
    'cooling-policy' = @('passive', 'active')
    'low-battery-action' = @('do-nothing', 'sleep', 'hibernate', 'shut-down')
    'critical-battery-action' = @('do-nothing', 'sleep', 'hibernate', 'shut-down')
    'taskbar-alignment' = @('left', 'center')
    'open-explorer-to' = @('this-pc', 'home')
    'taskbar-combine-buttons' = @('always', 'when-full', 'never')
}
$types = @{
    'dark-mode' = 'boolean'; mute = 'boolean'; wifi = 'boolean'; bluetooth = 'boolean'; 'mic-mute' = 'boolean'
    transparency = 'boolean'; 'file-extensions' = 'boolean'; 'hidden-files' = 'boolean'
    notifications = 'boolean'; 'clipboard-history' = 'boolean'; 'airplane-mode' = 'boolean'; 'pointer-precision' = 'boolean'; 'clock-24-hour' = 'boolean'
    'animations' = 'boolean'; 'drag-window-contents' = 'boolean'; 'snap-to-default-button' = 'boolean'; 'hide-pointer-while-typing' = 'boolean'; 'pointer-location-on-ctrl' = 'boolean'; 'usb-selective-suspend' = 'boolean'
    'mouse-click-lock' = 'boolean'; 'keyboard-underlines' = 'boolean'; 'window-minimize-animation' = 'boolean'; 'hybrid-sleep' = 'boolean'
    brightness = 'number'; volume = 'number'; 'mic-volume' = 'number'; 'screen-timeout' = 'number'; 'sleep-timeout' = 'number'; 'mouse-speed' = 'number'
    'scroll-lines' = 'number'; 'double-click-speed' = 'number'; 'keyboard-repeat-rate' = 'number'; 'cursor-blink-rate' = 'number'
    'hibernate-timeout' = 'number'; 'disk-timeout' = 'number'; 'lock-screen-timeout' = 'number'; 'dim-timeout' = 'number'; 'max-processor-state' = 'number'; 'battery-saver-threshold' = 'number'
    'default-brightness' = 'number'; 'unattended-sleep-timeout' = 'number'; 'low-battery-level' = 'number'; 'critical-battery-level' = 'number'; 'battery-saver-brightness' = 'number'
    'caret-width' = 'number'; 'horizontal-scroll-chars' = 'number'
    'pointer-trails' = 'number'; 'keyboard-repeat-delay' = 'number'; 'menu-show-delay' = 'number'
    'power-mode' = 'choice'; 'lid-close-action' = 'choice'; 'power-button-action' = 'choice'; 'mouse-primary-button' = 'choice'; 'wake-timers' = 'choice'; 'cooling-policy' = 'choice'; 'low-battery-action' = 'choice'; 'critical-battery-action' = 'choice'
    'task-view-button' = 'boolean'; 'taskbar-badges' = 'boolean'; 'taskbar-all-displays' = 'boolean'; 'clock-seconds' = 'boolean'
    'desktop-icons' = 'boolean'; 'full-path-title-bar' = 'boolean'; 'compact-view' = 'boolean'; 'item-checkboxes' = 'boolean'
    'folder-thumbnails' = 'boolean'; 'recent-items' = 'boolean'; 'quick-access-recent-files' = 'boolean'; 'quick-access-frequent-folders' = 'boolean'
    'aero-shake' = 'boolean'; 'classic-context-menu' = 'boolean'; 'accent-on-taskbar' = 'boolean'; 'accent-on-title-bars' = 'boolean'
    'advertising-id' = 'boolean'; 'tips-and-suggestions' = 'boolean'; 'game-mode' = 'boolean'; 'mono-audio' = 'boolean'
    'always-show-scrollbars' = 'boolean'; 'notification-sounds' = 'boolean'; 'storage-sense' = 'boolean'; 'adaptive-brightness' = 'boolean'
    'camera-access' = 'boolean'; 'microphone-access' = 'boolean'; 'location-access' = 'boolean'; 'sign-in-on-wake' = 'boolean'
    'firewall-private' = 'boolean'; 'firewall-public' = 'boolean'; 'firewall-domain' = 'boolean'; 'hibernate' = 'boolean'
    'fast-startup' = 'boolean'; 'remote-desktop' = 'boolean'; 'long-paths' = 'boolean'; 'feature-wsl' = 'boolean'
    'feature-virtual-machine-platform' = 'boolean'; 'feature-hyper-v' = 'boolean'; 'feature-windows-sandbox' = 'boolean'
    'active-hours-start' = 'number'; 'active-hours-end' = 'number'
    'taskbar-alignment' = 'choice'; 'open-explorer-to' = 'choice'; 'taskbar-combine-buttons' = 'choice'
}

# Tell running apps / the shell that a setting changed (WM_SETTINGCHANGE), as the Settings app does.
$broadcastReady = $false
function Send-SettingChange([string]$area) {
    if (-not $script:broadcastReady) {
        Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class SettingBroadcast{[DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r);[DllImport("shell32.dll")]public static extern void SHChangeNotify(int e,uint f,IntPtr a,IntPtr b);}'
        $script:broadcastReady = $true
    }
    $r = [UIntPtr]::Zero
    [void][SettingBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, $area, 2, 1000, [ref]$r)
}

# ---- dark mode (HKCU, per user; no elevation) --------------------------------
$themeKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
function Get-DarkMode { return ((Get-ItemProperty -Path $themeKey -Name AppsUseLightTheme).AppsUseLightTheme -eq 0) }
function Set-DarkMode([bool]$on) {
    $v = if ($on) { 0 } else { 1 }
    Set-ItemProperty -Path $themeKey -Name AppsUseLightTheme -Value $v -Type DWord
    Set-ItemProperty -Path $themeKey -Name SystemUsesLightTheme -Value $v -Type DWord
    Send-SettingChange 'ImmersiveColorSet'
}

# ---- per-user registry toggles (HKCU; no elevation). Absent keys mean "Windows default" ----
$advKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced'
$toastKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications'
$clipKey = 'HKCU:\Software\Microsoft\Clipboard'
function Get-RegValue([string]$path, [string]$name, $default) {
    $v = (Get-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue).$name
    if ($null -eq $v) { return $default }
    return $v
}
function Set-RegDword([string]$path, [string]$name, [int]$value) {
    if (-not (Test-Path -Path $path)) { [void](New-Item -Path $path -Force) }
    Set-ItemProperty -Path $path -Name $name -Value $value -Type DWord
}
function Get-Transparency { return ((Get-RegValue $themeKey 'EnableTransparency' 1) -eq 1) }
function Set-Transparency([bool]$on) { Set-RegDword $themeKey 'EnableTransparency' $(if ($on) { 1 } else { 0 }); Send-SettingChange 'ImmersiveColorSet' }
# HideFileExt / Hidden are inverted views of the user-facing meaning ("show").
function Get-FileExtensions { return ((Get-RegValue $advKey 'HideFileExt' 1) -eq 0) }
function Set-FileExtensions([bool]$show) { Set-RegDword $advKey 'HideFileExt' $(if ($show) { 0 } else { 1 }); Update-Explorer }
function Get-HiddenFiles { return ((Get-RegValue $advKey 'Hidden' 2) -eq 1) }
function Set-HiddenFiles([bool]$show) { Set-RegDword $advKey 'Hidden' $(if ($show) { 1 } else { 2 }); Update-Explorer }
function Update-Explorer { Send-SettingChange 'ShellState'; [SettingBroadcast]::SHChangeNotify(0x8000000, 0, [IntPtr]::Zero, [IntPtr]::Zero) }
function Get-Notifications { return ((Get-RegValue $toastKey 'ToastEnabled' 1) -eq 1) }
function Set-Notifications([bool]$on) { Set-RegDword $toastKey 'ToastEnabled' $(if ($on) { 1 } else { 0 }) }
function Get-ClipboardHistory { return ((Get-RegValue $clipKey 'EnableClipboardHistory' 0) -eq 1) }
function Set-ClipboardHistory([bool]$on) { Set-RegDword $clipKey 'EnableClipboardHistory' $(if ($on) { 1 } else { 0 }) }

# ---- table-driven per-user registry settings (HKCU; no elevation). A request only picks an id from this table and a typed value ----
# Nothing from a request is used as a path, a value name or text written to the registry. Absent values mean "Windows default".
#   dword (default): on/off are the numbers stored for true/false.   map: option name -> stored number.   text: on/off are strings.
#   notify: 'explorer' refreshes the shell, 'immersive' tells apps the colors changed, anything else sends nothing.
$cvKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion'
$consentKey = "$cvKey\CapabilityAccessManager\ConsentStore"
$clsidKey = 'HKCU:\Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}'
$regSettings = @{
    'taskbar-alignment'             = @{ path = $advKey; name = 'TaskbarAl'; default = 'center'; map = @{ left = 0; center = 1 }; notify = 'explorer' }
    'task-view-button'              = @{ path = $advKey; name = 'ShowTaskViewButton'; default = 1; on = 1; off = 0; notify = 'explorer' }
    'taskbar-badges'                = @{ path = $advKey; name = 'TaskbarBadges'; default = 1; on = 1; off = 0; notify = 'explorer' }
    'taskbar-all-displays'          = @{ path = $advKey; name = 'MMTaskbarEnabled'; default = 0; on = 1; off = 0; notify = 'explorer' }
    'taskbar-combine-buttons'       = @{ path = $advKey; name = 'TaskbarGlomLevel'; default = 'always'; map = @{ always = 0; 'when-full' = 1; never = 2 }; notify = 'explorer' }
    'clock-seconds'                 = @{ path = $advKey; name = 'ShowSecondsInSystemClock'; default = 0; on = 1; off = 0; notify = 'explorer' }
    'desktop-icons'                 = @{ path = $advKey; name = 'HideIcons'; default = 0; on = 0; off = 1; notify = 'explorer' }
    'full-path-title-bar'           = @{ path = "$cvKey\Explorer\CabinetState"; name = 'FullPath'; default = 0; on = 1; off = 0; notify = 'explorer' }
    'open-explorer-to'              = @{ path = $advKey; name = 'LaunchTo'; default = 'home'; map = @{ 'this-pc' = 1; home = 2 }; notify = 'explorer' }
    'compact-view'                  = @{ path = $advKey; name = 'UseCompactMode'; default = 0; on = 1; off = 0; notify = 'explorer' }
    'item-checkboxes'               = @{ path = $advKey; name = 'AutoCheckSelect'; default = 0; on = 1; off = 0; notify = 'explorer' }
    'folder-thumbnails'             = @{ path = $advKey; name = 'IconsOnly'; default = 0; on = 0; off = 1; notify = 'explorer' }
    'recent-items'                  = @{ path = $advKey; name = 'Start_TrackDocs'; default = 1; on = 1; off = 0; notify = 'explorer' }
    'quick-access-recent-files'     = @{ path = "$cvKey\Explorer"; name = 'ShowRecent'; default = 1; on = 1; off = 0; notify = 'explorer' }
    'quick-access-frequent-folders' = @{ path = "$cvKey\Explorer"; name = 'ShowFrequent'; default = 1; on = 1; off = 0; notify = 'explorer' }
    'aero-shake'                    = @{ path = $advKey; name = 'DisallowShaking'; default = 0; on = 0; off = 1; notify = 'explorer' }
    'classic-context-menu'          = @{ kind = 'clsid'; notify = 'explorer' }
    'accent-on-taskbar'             = @{ path = $themeKey; name = 'ColorPrevalence'; default = 0; on = 1; off = 0; notify = 'immersive' }
    'accent-on-title-bars'          = @{ path = 'HKCU:\Software\Microsoft\Windows\DWM'; name = 'ColorPrevalence'; default = 0; on = 1; off = 0; notify = 'immersive' }
    'advertising-id'                = @{ path = "$cvKey\AdvertisingInfo"; name = 'Enabled'; default = 1; on = 1; off = 0 }
    'tips-and-suggestions'          = @{ path = "$cvKey\ContentDeliveryManager"; name = 'SubscribedContent-338389Enabled'; default = 1; on = 1; off = 0 }
    'game-mode'                     = @{ path = 'HKCU:\Software\Microsoft\GameBar'; name = 'AutoGameModeEnabled'; also = 'AllowAutoGameMode'; default = 1; on = 1; off = 0 }
    'mono-audio'                    = @{ path = 'HKCU:\Software\Microsoft\Multimedia\Audio'; name = 'AccessibilityMonoMixState'; default = 0; on = 1; off = 0 }
    'always-show-scrollbars'        = @{ path = 'HKCU:\Control Panel\Accessibility'; name = 'DynamicScrollbars'; default = 1; on = 0; off = 1 }
    'notification-sounds'           = @{ path = "$cvKey\Notifications\Settings"; name = 'NOC_GLOBAL_SETTING_ALLOW_NOTIFICATION_SOUND'; default = 1; on = 1; off = 0 }
    'storage-sense'                 = @{ path = "$cvKey\StorageSense\Parameters\StoragePolicy"; name = '01'; default = 0; on = 1; off = 0 }
    'camera-access'                 = @{ kind = 'text'; path = "$consentKey\webcam"; name = 'Value'; default = 'Allow'; on = 'Allow'; off = 'Deny' }
    'microphone-access'             = @{ kind = 'text'; path = "$consentKey\microphone"; name = 'Value'; default = 'Allow'; on = 'Allow'; off = 'Deny' }
    'location-access'               = @{ kind = 'text'; path = "$consentKey\location"; name = 'Value'; default = 'Allow'; on = 'Allow'; off = 'Deny' }
}
function Set-RegString([string]$path, [string]$name, [string]$value) {
    if (-not (Test-Path -Path $path)) { [void](New-Item -Path $path -Force) }
    Set-ItemProperty -Path $path -Name $name -Value $value -Type String
}
function Get-RegSetting([string]$id) {
    $d = $script:regSettings[$id]
    if ($d.kind -eq 'clsid') { return (Test-Path -LiteralPath "$($script:clsidKey)\InprocServer32") }
    $raw = Get-RegValue $d.path $d.name $null
    if ($d.map) {
        if ($null -eq $raw) { return [string]$d.default }
        foreach ($k in $d.map.Keys) { if ([string]$d.map[$k] -eq [string]$raw) { return [string]$k } }
        return 'other' # a value this tool does not manage (for example Explorer set to open on Downloads)
    }
    if ($null -eq $raw) { $raw = $d.default }
    if ($d.kind -eq 'text') { return ([string]$raw -ne $d.off) }
    return ([int]$raw -eq [int]$d.on)
}
function Set-RegSetting([string]$id, $value) {
    $d = $script:regSettings[$id]
    if ($d.kind -eq 'clsid') {
        # The Windows 10 style right-click menu is an empty InprocServer32 override for one fixed CLSID; deleting that key restores the new menu.
        if ($value) { [void](New-Item -Path "$($script:clsidKey)\InprocServer32" -Force -Value '') }
        elseif (Test-Path -LiteralPath $script:clsidKey) { Remove-Item -LiteralPath $script:clsidKey -Recurse -Force }
    }
    elseif ($d.map) { Set-RegDword $d.path $d.name ([int]$d.map[[string]$value]) }
    elseif ($d.kind -eq 'text') { Set-RegString $d.path $d.name $(if ($value) { [string]$d.on } else { [string]$d.off }) }
    else {
        $n = if ($value) { [int]$d.on } else { [int]$d.off }
        Set-RegDword $d.path $d.name $n
        if ($d.also) { Set-RegDword $d.path $d.also $n }
    }
    switch ($d.notify) { 'explorer' { Update-Explorer } 'immersive' { Send-SettingChange 'ImmersiveColorSet' } }
}

# ---- settings that need administrator rights to CHANGE: they are only READ here (HKLM/WMI reads work without elevation). ----
# Changing them is SystemSettingsAdmin.ps1's job, run through a UAC prompt; this helper refuses with ELEVATION_REQUIRED.
$adminIds = @(
    'firewall-private', 'firewall-public', 'firewall-domain', 'hibernate', 'fast-startup', 'remote-desktop', 'long-paths',
    'active-hours-start', 'active-hours-end',
    'feature-wsl', 'feature-virtual-machine-platform', 'feature-hyper-v', 'feature-windows-sandbox'
)
$firewallKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy'
$powerCtlKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power'
$bootPowerKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power'
$activeHoursKey = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
$featureNames = @{
    'feature-wsl' = 'Microsoft-Windows-Subsystem-Linux'; 'feature-virtual-machine-platform' = 'VirtualMachinePlatform'
    'feature-hyper-v' = 'Microsoft-Hyper-V-All'; 'feature-windows-sandbox' = 'Containers-DisposableClientVM'
}
function Test-HomeEdition { return ([int](Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).OperatingSystemSKU -in 98, 99, 100, 101) }
function Get-FeatureState([string]$name) {
    $f = $null
    try { $f = Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='$name'" -ErrorAction Stop } catch { Unavailable 'Windows does not report optional features to this account on this PC.' }
    if (-not $f) { Unavailable 'This edition of Windows does not include that feature.' }
    return ([int]@($f)[0].InstallState -eq 1)
}
function Get-AdminSetting([string]$id) {
    switch ($id) {
        'firewall-private' { return ((Get-RegValue "$($script:firewallKey)\StandardProfile" 'EnableFirewall' 1) -eq 1) }
        'firewall-public' { return ((Get-RegValue "$($script:firewallKey)\PublicProfile" 'EnableFirewall' 1) -eq 1) }
        'firewall-domain' { return ((Get-RegValue "$($script:firewallKey)\DomainProfile" 'EnableFirewall' 1) -eq 1) }
        'hibernate' { return ((Get-RegValue $script:powerCtlKey 'HibernateEnabled' 0) -eq 1) }
        'fast-startup' { return ((Get-RegValue $script:bootPowerKey 'HiberbootEnabled' 0) -eq 1) }
        'remote-desktop' {
            if (Test-HomeEdition) { Unavailable 'Windows Home cannot host Remote Desktop connections.' }
            return ((Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' 'fDenyTSConnections' 1) -eq 0)
        }
        'long-paths' { return ((Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' 'LongPathsEnabled' 0) -eq 1) }
        'active-hours-start' { return [int](Get-RegValue $script:activeHoursKey 'ActiveHoursStart' 8) }
        'active-hours-end' { return [int](Get-RegValue $script:activeHoursKey 'ActiveHoursEnd' 17) }
        default { return (Get-FeatureState $script:featureNames[$id]) }
    }
}

# ---- power-plan settings (powercfg): plugged-in (AC) and on-battery (DC) are read and written SEPARATELY ----
# Table-driven: each entry is a fixed subgroup/setting pair owned by this file. A request only picks an id, a typed value and a source
# (both | plugged-in | battery); nothing from it reaches powercfg except an integer. Many of these settings are hidden from
# "powercfg /q" on modern plans, so they are read with /qh; the last two hex values it prints are the current AC and DC indexes.
$buttonGroup = '4f971e89-eebd-4455-a8de-9e59040e7347'
$buttonActions = @('do-nothing', 'sleep', 'hibernate', 'shut-down')
$powerSettings = @{
    'screen-timeout'          = @{ sub = 'SUB_VIDEO'; setting = 'VIDEOIDLE'; kind = 'minutes' }
    'sleep-timeout'           = @{ sub = 'SUB_SLEEP'; setting = 'STANDBYIDLE'; kind = 'minutes' }
    'hibernate-timeout'       = @{ sub = 'SUB_SLEEP'; setting = 'HIBERNATEIDLE'; kind = 'minutes' }
    'disk-timeout'            = @{ sub = 'SUB_DISK'; setting = 'DISKIDLE'; kind = 'minutes' }
    'lock-screen-timeout'     = @{ sub = 'SUB_VIDEO'; setting = 'VIDEOCONLOCK'; kind = 'minutes' }
    'dim-timeout'             = @{ sub = 'SUB_VIDEO'; setting = 'VIDEODIM'; kind = 'minutes' }
    'max-processor-state'     = @{ sub = 'SUB_PROCESSOR'; setting = 'PROCTHROTTLEMAX'; kind = 'percent' }
    'battery-saver-threshold' = @{ sub = 'SUB_ENERGYSAVER'; setting = 'ESBATTTHRESHOLD'; kind = 'percent'; batteryOnly = $true }
    'usb-selective-suspend'   = @{ sub = '2a737441-1930-4402-8d77-b2bebba308a3'; setting = '48e6b7a6-50f5-4782-a5d4-53bb8f07e226'; kind = 'bool' }
    'wake-timers'             = @{ sub = 'SUB_SLEEP'; setting = 'RTCWAKE'; kind = 'choice'; options = @('disabled', 'enabled', 'important-only') }
    'cooling-policy'          = @{ sub = 'SUB_PROCESSOR'; setting = 'SYSCOOLPOL'; kind = 'choice'; options = @('passive', 'active') }
    'hybrid-sleep'            = @{ sub = 'SUB_SLEEP'; setting = 'HYBRIDSLEEP'; kind = 'bool' }
    'unattended-sleep-timeout' = @{ sub = 'SUB_SLEEP'; setting = 'UNATTENDSLEEP'; kind = 'minutes' }
    'default-brightness'      = @{ sub = 'SUB_VIDEO'; setting = 'VIDEONORMALLEVEL'; kind = 'percent' }
    'battery-saver-brightness' = @{ sub = 'SUB_ENERGYSAVER'; setting = 'ESBRIGHTNESS'; kind = 'percent'; batteryOnly = $true }
    'low-battery-level'       = @{ sub = 'SUB_BATTERY'; setting = 'BATLEVELLOW'; kind = 'percent'; batteryOnly = $true }
    'critical-battery-level'  = @{ sub = 'SUB_BATTERY'; setting = 'BATLEVELCRIT'; kind = 'percent'; batteryOnly = $true }
    'low-battery-action'      = @{ sub = 'SUB_BATTERY'; setting = 'BATACTIONLOW'; kind = 'choice'; options = $buttonActions; batteryOnly = $true }
    'critical-battery-action' = @{ sub = 'SUB_BATTERY'; setting = 'BATACTIONCRIT'; kind = 'choice'; options = $buttonActions; batteryOnly = $true }
    'sign-in-on-wake'         = @{ sub = 'SUB_NONE'; setting = 'CONSOLELOCK'; kind = 'bool' }
    'adaptive-brightness'     = @{ sub = 'SUB_VIDEO'; setting = 'ADAPTBRIGHT'; kind = 'bool' }
    'lid-close-action'        = @{ sub = $buttonGroup; setting = '5ca83367-6e45-459f-a27b-476b1d01c936'; kind = 'choice'; options = $buttonActions }
    'power-button-action'     = @{ sub = $buttonGroup; setting = '7648efa3-dd9c-4e3e-b566-50f929386280'; kind = 'choice'; options = $buttonActions }
}
function ConvertFrom-PowerRaw($d, [long]$raw) {
    switch ($d.kind) {
        'minutes' { return [int][Math]::Round($raw / 60.0) }
        'percent' { return [int]$raw }
        'bool' { return ($raw -ne 0) }
        'choice' {
            if ($raw -lt 0 -or $raw -ge $d.options.Count) { Unavailable 'This PC reports an unsupported value for that setting.' }
            return [string]$d.options[[int]$raw]
        }
    }
}
function Get-PowerPair([string]$id) {
    $d = $script:powerSettings[$id]
    $hex = [regex]::Matches(((& powercfg.exe /qh SCHEME_CURRENT $d.sub $d.setting) -join "`n"), '0x[0-9a-fA-F]{8}')
    if ($hex.Count -lt 2) { Unavailable 'This power plan does not expose that setting.' }
    return @{
        pluggedIn = (ConvertFrom-PowerRaw $d ([Convert]::ToInt64($hex[$hex.Count - 2].Value, 16)))
        onBattery = (ConvertFrom-PowerRaw $d ([Convert]::ToInt64($hex[$hex.Count - 1].Value, 16)))
    }
}
# Which side(s) a request targets: a battery-only setting always means the battery value.
function Get-PowerSides([string]$id, [string]$source) {
    if ($script:powerSettings[$id].batteryOnly -or $source -eq 'battery') { return @('onBattery') }
    if ($source -eq 'plugged-in') { return @('pluggedIn') }
    return @('pluggedIn', 'onBattery')
}
function Set-PowerSetting([string]$id, $value, [string]$source) {
    $d = $script:powerSettings[$id]
    $raw = switch ($d.kind) {
        'minutes' { [int]$value * 60 }
        'percent' { [int]$value }
        'bool' { if ($value) { 1 } else { 0 } }
        'choice' { [Array]::IndexOf($d.options, [string]$value) }
    }
    foreach ($side in (Get-PowerSides $id $source)) {
        $switch = if ($side -eq 'onBattery') { '/setdcvalueindex' } else { '/setacvalueindex' }
        & powercfg.exe $switch SCHEME_CURRENT $d.sub $d.setting $raw | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "powercfg failed ($LASTEXITCODE)" }
    }
    & powercfg.exe /setactive SCHEME_CURRENT | Out-Null
}

# ---- pointer / keyboard / scrolling (SystemParametersInfo; persisted and broadcast) and power mode ----
# Each native group is compiled on its own, and only when a setting needs it. Security software was observed blocking ONE assembly that
# bundled all of these input and power calls together, while accepting each group separately (and this compiles faster).
$spiReady = $false; $clickReady = $false; $caretReady = $false; $overlayReady = $false
function Initialize-Spi {
    if ($script:spiReady) { return }
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class SpiNative{[DllImport("user32.dll",SetLastError=true)]public static extern bool SystemParametersInfo(uint a,uint b,ref int c,uint d);[DllImport("user32.dll",SetLastError=true)]public static extern bool SystemParametersInfo(uint a,uint b,IntPtr c,uint d);[DllImport("user32.dll",SetLastError=true)]public static extern bool SystemParametersInfo(uint a,uint b,int[] c,uint d);}'
    $script:spiReady = $true
}
function Initialize-Click {
    if ($script:clickReady) { return }
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class ClickNative{[DllImport("user32.dll")]public static extern uint GetDoubleClickTime();[DllImport("user32.dll")]public static extern bool SetDoubleClickTime(uint t);}'
    $script:clickReady = $true
}
function Initialize-Caret {
    if ($script:caretReady) { return }
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class CaretNative{[DllImport("user32.dll")]public static extern int GetSystemMetrics(int n);[DllImport("user32.dll")]public static extern uint GetCaretBlinkTime();[DllImport("user32.dll")]public static extern bool SetCaretBlinkTime(uint t);}'
    $script:caretReady = $true
}
function Initialize-PowerOverlay {
    if ($script:overlayReady) { return }
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class PowerNative{[DllImport("powrprof.dll")]public static extern uint PowerGetActualOverlayScheme(out Guid g);[DllImport("powrprof.dll")]public static extern uint PowerSetActiveOverlayScheme(Guid g);}'
    $script:overlayReady = $true
}
# SPI_SETxxx with SPIF_UPDATEINIFILE | SPIF_SENDCHANGE (3): persisted and broadcast, like the Settings app.
function Get-SpiInt([uint32]$getCode) { Initialize-Spi; $v = 0; [void][SpiNative]::SystemParametersInfo($getCode, 0, [ref]$v, 0); return $v }
function Set-SpiInt([uint32]$setCode, [int]$n, [string]$what) { Initialize-Spi; if (-not [SpiNative]::SystemParametersInfo($setCode, $n, [IntPtr]::Zero, 3)) { throw "Windows rejected the $what." } }
function Get-MouseSpeed { return (Get-SpiInt 0x70) }
function Set-MouseSpeed([int]$n) { Initialize-Spi; if (-not [SpiNative]::SystemParametersInfo(0x71, 0, [IntPtr]$n, 3)) { throw 'Windows rejected the pointer speed.' } }
function Get-PointerTrails { return (Get-SpiInt 0x5E) }
function Set-PointerTrails([int]$n) { Set-SpiInt 0x5D $n 'pointer trails' }
function Get-KeyboardRepeatDelay { return (Get-SpiInt 0x16) }
function Set-KeyboardRepeatDelay([int]$n) { Set-SpiInt 0x17 $n 'keyboard repeat delay' }
function Get-MenuShowDelay { return (Get-SpiInt 0x6A) }
function Set-MenuShowDelay([int]$ms) { Set-SpiInt 0x6B $ms 'menu show delay' }
# A few SPI_SET* calls take their value in pvParam, and window minimize/maximize animation takes an ANIMATIONINFO {size, flag}.
function Set-SpiPtr([uint32]$setCode, [int]$n, [string]$what) {
    Initialize-Spi
    if (-not [SpiNative]::SystemParametersInfo($setCode, 0, [IntPtr]$n, 3)) { throw "Windows rejected the $what." }
}
function Get-WindowMinimizeAnimation { Initialize-Spi; $a = [int[]](8, 0); [void][SpiNative]::SystemParametersInfo(0x48, 8, $a, 0); return ($a[1] -ne 0) }
function Set-WindowMinimizeAnimation([bool]$on) {
    Initialize-Spi
    $a = [int[]](8, $(if ($on) { 1 } else { 0 }))
    if (-not [SpiNative]::SystemParametersInfo(0x49, 8, $a, 3)) { throw 'Windows rejected the window animation setting.' }
}
# Boolean SystemParametersInfo settings. Older SPI_SET* calls take the BOOL in uiParam, newer ones in pvParam.
function Get-SpiBool([uint32]$getCode) { Initialize-Spi; $v = 0; [void][SpiNative]::SystemParametersInfo($getCode, 0, [ref]$v, 0); return ($v -ne 0) }
function Set-SpiBoolUi([uint32]$setCode, [bool]$on, [string]$what) {
    Initialize-Spi
    if (-not [SpiNative]::SystemParametersInfo($setCode, $(if ($on) { 1 } else { 0 }), [IntPtr]::Zero, 3)) { throw "Windows rejected the $what setting." }
}
function Set-SpiBoolPtr([uint32]$setCode, [bool]$on, [string]$what) {
    Initialize-Spi
    if (-not [SpiNative]::SystemParametersInfo($setCode, 0, [IntPtr]$(if ($on) { 1 } else { 0 }), 3)) { throw "Windows rejected the $what setting." }
}
function Get-ScrollLines { return (Get-SpiInt 0x68) }
function Set-ScrollLines([int]$n) { Set-SpiInt 0x69 $n 'scroll lines' }
function Get-KeyboardRepeatRate { return (Get-SpiInt 0x0A) }
function Set-KeyboardRepeatRate([int]$n) { Set-SpiInt 0x0B $n 'keyboard repeat rate' }
# "Enhance pointer precision" = the acceleration flag (third value) of SPI_GETMOUSE / SPI_SETMOUSE.
function Get-PointerPrecision { Initialize-Spi; $m = New-Object 'int[]' 3; [void][SpiNative]::SystemParametersInfo(0x3, 0, $m, 0); return ($m[2] -ne 0) }
function Set-PointerPrecision([bool]$on) {
    Initialize-Spi
    $m = [int[]]$(if ($on) { 6, 10, 1 } else { 0, 0, 0 })
    if (-not [SpiNative]::SystemParametersInfo(0x4, 0, $m, 3)) { throw 'Windows rejected the pointer precision setting.' }
}
function Get-DoubleClickSpeed { Initialize-Click; return [int][ClickNative]::GetDoubleClickTime() }
function Set-DoubleClickSpeed([int]$ms) {
    Initialize-Click
    if (-not [ClickNative]::SetDoubleClickTime([uint32]$ms)) { throw 'Windows rejected the double-click speed.' }
    Set-ItemProperty -Path 'HKCU:/Control Panel/Mouse' -Name DoubleClickSpeed -Value "$ms" -Type String # persist across sign-ins
}
# Windows 11 power mode = the active "overlay" scheme (Best power efficiency / Balanced / Best performance).
$powerModes = @{ 'best-power-efficiency' = [Guid]'961cc777-2547-4f9d-8174-7d86181b8a7a'; 'balanced' = [Guid]::Empty; 'best-performance' = [Guid]'ded574b5-45a0-4f42-8737-46345c09c238' }
function Get-PowerMode {
    Initialize-PowerOverlay
    $g = [Guid]::Empty
    if ([PowerNative]::PowerGetActualOverlayScheme([ref]$g) -ne 0) { Unavailable 'This PC does not support power modes.' }
    foreach ($k in $script:powerModes.Keys) { if ($script:powerModes[$k] -eq $g) { return $k } }
    return 'balanced'
}
function Set-PowerMode([string]$mode) {
    Initialize-PowerOverlay
    if ([PowerNative]::PowerSetActiveOverlayScheme($script:powerModes[$mode]) -ne 0) { Unavailable 'This PC does not support that power mode.' }
}

# ---- cursor blink rate (ms) and primary mouse button -------------------------
function Get-CursorBlinkRate { Initialize-Caret; return [int][CaretNative]::GetCaretBlinkTime() }
function Set-CursorBlinkRate([int]$ms) {
    Initialize-Caret
    if (-not [CaretNative]::SetCaretBlinkTime([uint32]$ms)) { throw 'Windows rejected the cursor blink rate.' }
    Set-ItemProperty -Path 'HKCU:/Control Panel/Desktop' -Name CursorBlinkRate -Value "$ms" -Type String # persist across sign-ins
}
# SM_SWAPBUTTON (23) reports a swapped (right-handed-off) mouse; SPI_SETMOUSEBUTTONSWAP (0x21) changes and persists it.
function Get-MousePrimaryButton { Initialize-Caret; return $(if ([CaretNative]::GetSystemMetrics(23) -ne 0) { 'right' } else { 'left' }) }
function Set-MousePrimaryButton([string]$button) { Set-SpiInt 0x21 $(if ($button -eq 'right') { 1 } else { 0 }) 'primary mouse button' }

# ---- 12/24-hour clock: the user's SHORT time format (what the taskbar clock and most apps show). The long format is left alone. ----
$localeReady = $false
function Initialize-Locale {
    if ($script:localeReady) { return }
    Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class LocaleNative{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool SetLocaleInfo(uint l,uint t,string d);}'
    $script:localeReady = $true
}
function Get-Clock24Hour {
    # The persisted user override is the source of truth: GetLocaleInfoEx keeps returning a per-process cached value after a change.
    $format = [string](Get-RegValue 'HKCU:/Control Panel/International' 'sShortTime' 'HH:mm')
    return (($format -cmatch 'H') -and ($format -notmatch 't'))
}
function Set-Clock24Hour([bool]$on) {
    Initialize-Locale
    $short = if ($on) { 'HH:mm' } else { 'h:mm tt' }
    # 0x400 = LOCALE_USER_DEFAULT, 0x79 = LOCALE_SSHORTTIME
    if (-not [LocaleNative]::SetLocaleInfo(0x400, 0x79, $short)) { throw 'Windows rejected the clock format.' }
    Send-SettingChange 'intl'
}

# ---- brightness (built-in panels only; WMI) ----------------------------------
function Get-Brightness {
    $b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $b) { Unavailable 'This display does not support software brightness control.' }
    return [int]$b.CurrentBrightness
}
function Set-Brightness([int]$n) {
    $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $m) { Unavailable 'This display does not support software brightness control.' }
    [void](Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$n })
}

# ---- speaker / microphone volume and mute (Core Audio, default endpoints) -----
$audioReady = $false
function Initialize-Audio {
    if ($script:audioReady) { return }
    Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class SpeakerAudio {
  [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
  [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator { int EnumAudioEndpoints(int f,int m,out IntPtr d); int GetDefaultAudioEndpoint(int flow,int role,out IMMDevice dev); }
  [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice { int Activate(ref Guid iid,uint ctx,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [ComImport,Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p); int GetChannelCount(out uint c);
    int SetMasterVolumeLevel(float l,ref Guid g); int SetMasterVolumeLevelScalar(float l,ref Guid g); int GetMasterVolumeLevel(out float l); int GetMasterVolumeLevelScalar(out float l);
    int SetChannelVolumeLevel(uint c,float l,ref Guid g); int SetChannelVolumeLevelScalar(uint c,float l,ref Guid g); int GetChannelVolumeLevel(uint c,out float l); int GetChannelVolumeLevelScalar(uint c,out float l);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool m,ref Guid g); int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m); }
  static IAudioEndpointVolume Endpoint() { return Endpoint(0); }
  // flow 0 = render (speakers), 1 = capture (microphone)
  static IAudioEndpointVolume Endpoint(int flow) {
    var en=(IMMDeviceEnumerator)new MMDeviceEnumeratorCom(); IMMDevice d; en.GetDefaultAudioEndpoint(flow,1,out d);
    Guid iid=typeof(IAudioEndpointVolume).GUID; object o; d.Activate(ref iid,23,IntPtr.Zero,out o); return (IAudioEndpointVolume)o; }
  public static int GetVolume() { float s; Endpoint().GetMasterVolumeLevelScalar(out s); return (int)Math.Round(s*100); }
  public static void SetVolume(int percent) { Guid g=Guid.Empty; Endpoint().SetMasterVolumeLevelScalar(percent/100f,ref g); }
  public static bool GetMute() { bool m; Endpoint().GetMute(out m); return m; }
  public static void SetMute(bool mute) { Guid g=Guid.Empty; Endpoint().SetMute(mute,ref g); }
  public static bool GetMicMute() { bool m; Endpoint(1).GetMute(out m); return m; }
  public static void SetMicMute(bool mute) { Guid g=Guid.Empty; Endpoint(1).SetMute(mute,ref g); }
  public static int GetMicVolume() { float s; Endpoint(1).GetMasterVolumeLevelScalar(out s); return (int)Math.Round(s*100); }
  public static void SetMicVolume(int percent) { Guid g=Guid.Empty; Endpoint(1).SetMasterVolumeLevelScalar(percent/100f,ref g); }
}
"@
    $script:audioReady = $true
}
function Guard-Audio([scriptblock]$body) {
    try { Initialize-Audio; & $body } catch { Unavailable 'No audio output device is available.' }
}

# ---- Wi-Fi / Bluetooth radios and airplane mode (WinRT Windows.Devices.Radios) ----
$radiosReady = $false
function Initialize-Radios {
    if ($script:radiosReady) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
    [void][Windows.Devices.Radios.RadioState, Windows.System.Devices, ContentType = WindowsRuntime]
    [void][Windows.Devices.Radios.RadioAccessStatus, Windows.System.Devices, ContentType = WindowsRuntime]
    $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $script:radiosReady = $true
}
function Await($op, [Type]$type) { $t = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(15000); return $t.Result }
function Get-Radios([string]$kind) {
    Initialize-Radios
    $all = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
    $list = @($all | Where-Object { "$($_.Kind)" -eq $kind })
    if (-not $list.Count) { Unavailable "No $kind radio was found on this PC." }
    return $list
}
# Airplane mode = every radio off. Windows has no public "airplane mode" switch, so this drives all radios directly.
function Get-AirplaneMode {
    Initialize-Radios
    $all = @(Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]))
    if (-not $all.Count) { Unavailable 'No radios were found on this PC.' }
    return (-not @($all | Where-Object { "$($_.State)" -eq 'On' }).Count)
}
function Set-AirplaneMode([bool]$on) {
    [void](Get-AirplaneMode)
    $access = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
    if ("$access" -ne 'Allowed') { Fail 'RADIO_ACCESS_DENIED' "Windows did not allow changing radios ($access). Check Settings > Privacy & security > Radios." }
    $state = if ($on) { [Windows.Devices.Radios.RadioState]::Off } else { [Windows.Devices.Radios.RadioState]::On }
    foreach ($r in @(Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]))) {
        $status = Await ($r.SetStateAsync($state)) ([Windows.Devices.Radios.RadioAccessStatus])
        if ("$status" -ne 'Allowed') { Fail 'RADIO_ACCESS_DENIED' "Windows refused to change the $($r.Kind) radio ($status)." }
    }
}
function Get-RadioOn([string]$kind) { return [bool](@(Get-Radios $kind | Where-Object { "$($_.State)" -eq 'On' }).Count) }
function Set-RadioOn([string]$kind, [bool]$on) {
    $access = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
    if ("$access" -ne 'Allowed') { Fail 'RADIO_ACCESS_DENIED' "Windows did not allow changing the $kind radio ($access). Check Settings > Privacy & security > Radios." }
    $state = if ($on) { [Windows.Devices.Radios.RadioState]::On } else { [Windows.Devices.Radios.RadioState]::Off }
    foreach ($r in (Get-Radios $kind)) {
        $status = Await ($r.SetStateAsync($state)) ([Windows.Devices.Radios.RadioAccessStatus])
        if ("$status" -ne 'Allowed') { Fail 'RADIO_ACCESS_DENIED' "Windows refused to change the $kind radio ($status)." }
    }
}

# ---- dispatch (ids are code branches, never data) ----------------------------
function Get-Value([string]$id, [string]$source = 'both') {
    if ($script:powerSettings.ContainsKey($id)) {
        $pair = Get-PowerPair $id
        return $(if (@(Get-PowerSides $id $source)[0] -eq 'onBattery') { $pair.onBattery } else { $pair.pluggedIn })
    }
    if ($script:regSettings.ContainsKey($id)) { return Get-RegSetting $id }
    if ($script:adminIds -contains $id) { return Get-AdminSetting $id }
    switch ($id) {
        'dark-mode' { return Get-DarkMode }
        'brightness' { return Get-Brightness }
        'volume' { return Guard-Audio { [SpeakerAudio]::GetVolume() } }
        'mute' { return Guard-Audio { [SpeakerAudio]::GetMute() } }
        'mic-mute' { return Guard-Audio { [SpeakerAudio]::GetMicMute() } }
        'mic-volume' { return Guard-Audio { [SpeakerAudio]::GetMicVolume() } }
        'airplane-mode' { return Get-AirplaneMode }
        'pointer-precision' { return Get-PointerPrecision }
        'scroll-lines' { return Get-ScrollLines }
        'double-click-speed' { return Get-DoubleClickSpeed }
        'keyboard-repeat-rate' { return Get-KeyboardRepeatRate }
        'power-mode' { return Get-PowerMode }
        'mouse-primary-button' { return Get-MousePrimaryButton }
        'cursor-blink-rate' { return Get-CursorBlinkRate }
        'clock-24-hour' { return Get-Clock24Hour }
        'transparency' { return Get-Transparency }
        'file-extensions' { return Get-FileExtensions }
        'hidden-files' { return Get-HiddenFiles }
        'notifications' { return Get-Notifications }
        'clipboard-history' { return Get-ClipboardHistory }
        'pointer-trails' { return Get-PointerTrails }
        'keyboard-repeat-delay' { return Get-KeyboardRepeatDelay }
        'menu-show-delay' { return Get-MenuShowDelay }
        'mouse-speed' { return Get-MouseSpeed }
        'animations' { return Get-SpiBool 0x1042 }
        'drag-window-contents' { return Get-SpiBool 0x26 }
        'snap-to-default-button' { return Get-SpiBool 0x5F }
        'hide-pointer-while-typing' { return Get-SpiBool 0x1020 }
        'pointer-location-on-ctrl' { return Get-SpiBool 0x101C }
        'mouse-click-lock' { return Get-SpiBool 0x101E }
        'keyboard-underlines' { return Get-SpiBool 0x100A }
        'window-minimize-animation' { return Get-WindowMinimizeAnimation }
        'caret-width' { return Get-SpiInt 0x2006 }
        'horizontal-scroll-chars' { return Get-SpiInt 0x6C }
        'wifi' { return Get-RadioOn 'WiFi' }
        'bluetooth' { return Get-RadioOn 'Bluetooth' }
        default { Fail 'UNKNOWN_SETTING' 'Unknown setting.' }
    }
}
function Set-Value([string]$id, $value, [string]$source = 'both') {
    if ($script:powerSettings.ContainsKey($id)) { Set-PowerSetting $id $value $source; return }
    if ($script:adminIds -contains $id) { Fail 'ELEVATION_REQUIRED' 'This setting needs administrator approval and is changed through the elevated helper.' }
    if ($script:regSettings.ContainsKey($id)) { Set-RegSetting $id $value; return }
    switch ($id) {
        'dark-mode' { Set-DarkMode ([bool]$value) }
        'brightness' { Set-Brightness ([int]$value) }
        'volume' { Guard-Audio { [SpeakerAudio]::SetVolume([int]$value) } }
        'mute' { Guard-Audio { [SpeakerAudio]::SetMute([bool]$value) } }
        'mic-mute' { Guard-Audio { [SpeakerAudio]::SetMicMute([bool]$value) } }
        'mic-volume' { Guard-Audio { [SpeakerAudio]::SetMicVolume([int]$value) } }
        'airplane-mode' { Set-AirplaneMode ([bool]$value) }
        'pointer-precision' { Set-PointerPrecision ([bool]$value) }
        'scroll-lines' { Set-ScrollLines ([int]$value) }
        'double-click-speed' { Set-DoubleClickSpeed ([int]$value) }
        'keyboard-repeat-rate' { Set-KeyboardRepeatRate ([int]$value) }
        'power-mode' { Set-PowerMode ([string]$value) }
        'mouse-primary-button' { Set-MousePrimaryButton ([string]$value) }
        'cursor-blink-rate' { Set-CursorBlinkRate ([int]$value) }
        'clock-24-hour' { Set-Clock24Hour ([bool]$value) }
        'transparency' { Set-Transparency ([bool]$value) }
        'file-extensions' { Set-FileExtensions ([bool]$value) }
        'hidden-files' { Set-HiddenFiles ([bool]$value) }
        'notifications' { Set-Notifications ([bool]$value) }
        'clipboard-history' { Set-ClipboardHistory ([bool]$value) }
        'pointer-trails' { Set-PointerTrails ([int]$value) }
        'keyboard-repeat-delay' { Set-KeyboardRepeatDelay ([int]$value) }
        'menu-show-delay' { Set-MenuShowDelay ([int]$value) }
        'mouse-speed' { Set-MouseSpeed ([int]$value) }
        'animations' { Set-SpiBoolPtr 0x1043 ([bool]$value) 'animations' }
        'drag-window-contents' { Set-SpiBoolUi 0x25 ([bool]$value) 'window dragging' }
        'snap-to-default-button' { Set-SpiBoolUi 0x60 ([bool]$value) 'snap-to-default-button' }
        'hide-pointer-while-typing' { Set-SpiBoolPtr 0x1021 ([bool]$value) 'hide-pointer-while-typing' }
        'pointer-location-on-ctrl' { Set-SpiBoolPtr 0x101D ([bool]$value) 'pointer-location-on-ctrl' }
        'mouse-click-lock' { Set-SpiBoolPtr 0x101F ([bool]$value) 'mouse-click-lock' }
        'keyboard-underlines' { Set-SpiBoolPtr 0x100B ([bool]$value) 'keyboard-underlines' }
        'window-minimize-animation' { Set-WindowMinimizeAnimation ([bool]$value) }
        'caret-width' { Set-SpiPtr 0x2007 ([int]$value) 'text cursor width' }
        'horizontal-scroll-chars' { Set-SpiInt 0x6D ([int]$value) 'horizontal scroll' }
        'wifi' { Set-RadioOn 'WiFi' ([bool]$value) }
        'bluetooth' { Set-RadioOn 'Bluetooth' ([bool]$value) }
        default { Fail 'UNKNOWN_SETTING' 'Unknown setting.' }
    }
}
# Read the value back until it matches. Radios and brightness change asynchronously, so poll briefly. Returns the final reading:
# a plugged-in / on-battery pair for power-plan settings, a single value otherwise.
function Read-Back([string]$id, $wanted, [string]$source = 'both') {
    $isPower = $script:powerSettings.ContainsKey($id)
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds ($(if ($i -eq 0) { 150 } else { 400 }))
        if ($isPower) {
            $pair = Get-PowerPair $id
            $ok = $true
            foreach ($side in (Get-PowerSides $id $source)) { if ($pair[$side] -ne $wanted) { $ok = $false } }
            if ($ok) { return $pair }
        }
        else {
            $now = Get-Value $id
            # Percent-like values may round by one step; minutes, pointer speed, options and booleans must match exactly.
            if ($id -in 'brightness', 'volume', 'mic-volume') { if ([Math]::Abs([int]$now - [int]$wanted) -le 1) { return $now } } elseif ($now -eq $wanted) { return $now }
        }
    }
    if ($isPower) { return Get-PowerPair $id }
    return Get-Value $id
}

function Invoke-Request($req) {
    try {
        $action = [string]$req.action
        if ($action -eq 'list') {
            $items = foreach ($id in $types.Keys) {
                try {
                    if ($script:powerSettings.ContainsKey($id)) {
                        $pair = Get-PowerPair $id
                        @{ id = $id; available = $true; value = $(if ($script:powerSettings[$id].batteryOnly) { $pair.onBattery } else { $pair.pluggedIn }); pluggedIn = $pair.pluggedIn; onBattery = $pair.onBattery }
                    }
                    else { @{ id = $id; available = $true; value = (Get-Value $id) } }
                }
                catch {
                    if ($_.Exception.Message -eq 'EMIT') { throw }
                    @{ id = $id; available = $false; value = $null; reason = ($_.Exception.Message -replace '^UNAVAILABLE:', '') }
                }
            }
            Emit @{ success = $true; settings = @($items) }
        }
        $id = [string]$req.id
        if (-not $types.ContainsKey($id)) { Fail 'UNKNOWN_SETTING' 'Unknown setting.' }
        $isPower = $script:powerSettings.ContainsKey($id)
        $source = [string]$req.source
        if ($source) {
            if ($source -cnotin 'both', 'plugged-in', 'battery') { Fail 'INVALID_INPUT' 'source must be both, plugged-in or battery.' }
            if (-not $isPower) { Fail 'INVALID_INPUT' 'This setting has no separate plugged-in / on-battery value.' }
            if ($script:powerSettings[$id].batteryOnly -and $source -eq 'plugged-in') { Fail 'INVALID_INPUT' 'This setting only applies on battery.' }
        }
        else { $source = 'both' }
        if ($action -eq 'get') {
            if ($isPower) {
                $pair = Get-PowerPair $id
                Emit @{ success = $true; id = $id; value = $(if ($script:powerSettings[$id].batteryOnly) { $pair.onBattery } else { $pair.pluggedIn }); pluggedIn = $pair.pluggedIn; onBattery = $pair.onBattery }
            }
            Emit @{ success = $true; id = $id; value = (Get-Value $id) }
        }
        if ($action -eq 'set') {
            $value = $req.value
            if ($types[$id] -eq 'boolean') { if ($value -isnot [bool]) { Fail 'INVALID_INPUT' 'A boolean value is required.' } }
            elseif ($types[$id] -eq 'choice') { if ($value -isnot [string] -or $choices[$id] -cnotcontains $value) { Fail 'INVALID_INPUT' "Value must be one of: $($choices[$id] -join ', ')." } }
            else {
                if ($value -isnot [int] -and $value -isnot [long]) { Fail 'INVALID_INPUT' 'A whole-number value is required.' }
                if ($value -lt $limits[$id][0] -or $value -gt $limits[$id][1]) { Fail 'OUT_OF_RANGE' "Value must be $($limits[$id][0])-$($limits[$id][1])." }
                # Windows treats a pointer-trail length of 1 as "off" and reads it back as 0, so the value is ambiguous: refuse it.
                if ($id -eq 'pointer-trails' -and $value -eq 1) { Fail 'OUT_OF_RANGE' 'Use 0 for no trails, or 2-20 for the trail length.' }
            }
            if ($script:adminIds -contains $id) { Fail 'ELEVATION_REQUIRED' 'This setting needs administrator approval and is changed through the elevated helper.' }
            if ($isPower) {
                if ($id -eq 'low-battery-level') { $crit = (Get-PowerPair 'critical-battery-level').onBattery; if ($value -le $crit) { Fail 'OUT_OF_RANGE' "The low battery level must be above the critical level ($crit%)." } }
                if ($id -eq 'critical-battery-level') { $low = (Get-PowerPair 'low-battery-level').onBattery; if ($value -ge $low) { Fail 'OUT_OF_RANGE' "The critical battery level must be below the low level ($low%)." } }
                $before = Get-PowerPair $id
                Set-PowerSetting $id $value $source
                $now = Read-Back $id $value $source
                $side = @(Get-PowerSides $id $source)[0]
                Emit @{ success = $true; id = $id; source = $source; previous = $before[$side]; requested = $value; value = $now[$side]; pluggedIn = $now.pluggedIn; onBattery = $now.onBattery; before = @{ pluggedIn = $before.pluggedIn; onBattery = $before.onBattery } }
            }
            $previous = Get-Value $id
            Set-Value $id $value
            Emit @{ success = $true; id = $id; previous = $previous; requested = $value; value = (Read-Back $id $value) }
        }
        Fail 'INVALID_INPUT' 'Unknown action.'
    }
    catch {
        $m = $_.Exception.Message
        if ($m -eq 'EMIT') { return $script:Result }
        if ($m -like 'UNAVAILABLE:*') { return @{ success = $false; code = 'SETTING_UNAVAILABLE'; message = ($m -replace '^UNAVAILABLE:', '') } }
        return @{ success = $false; code = 'SETTING_FAILED'; message = $m }
    }
}

# ---- request loop: one JSON object per line in, one per line out ----------------
$utf8 = New-Object System.Text.UTF8Encoding $false
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.AutoFlush = $true
while ($null -ne ($line = $reader.ReadLine())) {
    $line = $line.TrimStart([char]0xFEFF).Trim()
    if (-not $line) { continue }
    $requestId = $null
    try {
        $req = $line | ConvertFrom-Json
        $requestId = $req.requestId
        $res = Invoke-Request $req
    }
    catch { $res = @{ success = $false; code = 'INVALID_INPUT'; message = 'The request was not valid JSON.' } }
    if ($null -ne $requestId) { $res['requestId'] = $requestId }
    $writer.WriteLine(($res | ConvertTo-Json -Compress -Depth 5))
}
