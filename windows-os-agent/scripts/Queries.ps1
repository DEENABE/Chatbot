function Get-Network {
    return [ordered]@{
        adapters = @(Get-NetAdapter | Sort-Object ifIndex | Select-Object Name, InterfaceDescription, ifIndex, Status, AdminStatus)
        ipv4 = @(Get-NetIPAddress -AddressFamily IPv4 | Sort-Object InterfaceIndex, IPAddress | Select-Object InterfaceIndex, IPAddress, PrefixLength, PrefixOrigin)
        interfaces = @(Get-NetIPInterface -AddressFamily IPv4 | Sort-Object InterfaceIndex | Select-Object InterfaceIndex, Dhcp, ConnectionState)
        dns = @(Get-DnsClientServerAddress | Sort-Object InterfaceIndex, AddressFamily | Select-Object InterfaceIndex, AddressFamily, ServerAddresses)
        routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object InterfaceIndex, NextHop | Select-Object InterfaceIndex, NextHop, RouteMetric)
    }
}
function Get-AdapterState([int]$Index) {
    $adapter = @(Get-NetAdapter | Where-Object { $_.ifIndex -eq $Index })
    if ($adapter.Count -ne 1) { Fail 'ADAPTER_NOT_FOUND' 'The specified interface index is not a unique adapter' }
    $net = Get-Network
    return [ordered]@{
        adapter = $adapter[0] | Select-Object Name, ifIndex, AdminStatus
        ipv4 = @($net.ipv4 | Where-Object { $_.InterfaceIndex -eq $Index })
        interfaces = @($net.interfaces | Where-Object { $_.InterfaceIndex -eq $Index } | Select-Object InterfaceIndex, Dhcp)
        dns = @($net.dns | Where-Object { $_.InterfaceIndex -eq $Index })
        routes = @($net.routes | Where-Object { $_.InterfaceIndex -eq $Index })
    }
}
function Get-Brightness {
    $items = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Where-Object Active)
    if (-not $items.Count) { Fail 'UNSUPPORTED_HARDWARE' 'This display has no active WMI brightness provider; external monitors may require a separately vetted DDC/CI adapter.' }
    return @($items | Select-Object InstanceName, CurrentBrightness, Levels | Sort-Object InstanceName)
}
function Get-PowerState {
    Load-Native
    $active = Invoke-NativeCommand 'powercfg.exe' @('/getactivescheme')
    $scheme = [regex]::Match($active, '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}').Value
    return [ordered]@{
        activeGuid = $scheme
        plans = Invoke-NativeCommand 'powercfg.exe' @('/list')
        monitor = Invoke-NativeCommand 'powercfg.exe' @('/query', 'SCHEME_CURRENT', 'SUB_VIDEO', 'VIDEOIDLE')
        standby = Invoke-NativeCommand 'powercfg.exe' @('/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE')
        hibernate = Invoke-NativeCommand 'powercfg.exe' @('/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'HIBERNATEIDLE')
        hibernationEnabled = Read-Value 'HKLM:\SYSTEM\CurrentControlSet\Control\Power' 'HibernateEnabled'
        battery = [LocalOS.Desktop]::Power()
    }
}
function Get-PrivacyState([string]$Capability) {
    $base = 'Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\' + $Capability
    $policyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy'
    $policyName = @{ location = 'LetAppsAccessLocation'; webcam = 'LetAppsAccessCamera'; microphone = 'LetAppsAccessMicrophone' }[$Capability]
    return [ordered]@{
        capability = $Capability
        scope = 'current-user'
        userConsent = Read-Value "HKCU:\$base" 'Value'
        machineConsent = Read-Value "HKLM:\$base" 'Value'
        appPrivacyPolicy = Read-Value $policyPath $policyName
        locationPolicy = Read-Value 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\LocationAndSensors' 'DisableLocation'
        note = 'Consent values do not prove effective permission for every app. Machine settings, policy and per-app consent can override user consent.'
    }
}
function Get-Personalization {
    Load-Native
    $path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
    return [ordered]@{
        appsLight = Read-Value $path 'AppsUseLightTheme'
        systemLight = Read-Value $path 'SystemUsesLightTheme'
        accent = Read-Value 'HKCU:\Software\Microsoft\Windows\DWM' 'AccentColor'
        colorPrevalence = Read-Value $path 'ColorPrevalence'
        wallpaper = Read-Value 'HKCU:\Control Panel\Desktop' 'WallPaper'
        autoHide = [LocalOS.Desktop]::AutoHide()
    }
}
function Get-UpdateStatus {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    try {
        $count = [Math]::Min($searcher.GetTotalHistoryCount(), 20)
        $history = if ($count -gt 0) { @($searcher.QueryHistory(0, $count) | Select-Object Title, Date, ResultCode, HResult) } else { @() }
        return [ordered]@{ rebootRequired = Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'; history = $history }
    } finally { $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($searcher); $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($session) }
}
function Get-ServiceState($Parameters) {
    if ($Parameters.ContainsKey('name')) {
        $service = Get-Service | Where-Object { $_.Name -ceq $Parameters.name }
        if ($null -eq $service) { Fail 'SERVICE_NOT_FOUND' 'No service has this exact name' }
        return $service | Select-Object Name, Status, StartType, CanStop
    }
    return @(Get-Service | Sort-Object Name | Select-Object Name, DisplayName, Status, StartType)
}
function Read-Operation([string]$Operation, [hashtable]$Parameters) {
    switch ($Operation) {
        'system.inspect' {
            $os = Get-CimInstance Win32_OperatingSystem
            return [ordered]@{ version = $os.Version; build = $os.BuildNumber; caption = $os.Caption; administrator = Test-Admin; interactive = [Environment]::UserInteractive; sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId; powershell = $PSVersionTable.PSVersion.ToString(); architecture = [IntPtr]::Size * 8 }
        }
        'network.inspect' { return Get-Network }
        { $_ -in @('network.adapter', 'network.dns', 'network.ipv4') } { return Get-AdapterState $Parameters.interfaceIndex }
        { $_ -in @('wifi.inspect', 'wifi.connect') } { return [ordered]@{ interfaces = Invoke-NativeCommand 'netsh.exe' @('wlan', 'show', 'interfaces'); profiles = Invoke-NativeCommand 'netsh.exe' @('wlan', 'show', 'profiles') } }
        { $_ -in @('radio.inspect', 'radio.set') } { return Get-RadioState }
        'display.inspect' { Load-Native; return [ordered]@{ displays = @([LocalOS.Desktop]::Displays()); topology = [LocalOS.Desktop]::Topology() } }
        'display.mode' { Load-Native; return @([LocalOS.Desktop]::Displays() | Where-Object device -CEQ $Parameters.device | Select-Object device, current) }
        'display.topology' { Load-Native; return [ordered]@{ topology = [LocalOS.Desktop]::Topology() } }
        { $_ -in @('brightness.get', 'brightness.set') } { return Get-Brightness }
        { $_ -in @('audio.inspect', 'audio.volume') } { Load-Native; return [LocalOS.Audio]::Inspect() }
        { $_ -in @('power.inspect', 'power.plan', 'power.timeout', 'power.hibernate') } {
            $state = Get-PowerState
            if ($Operation -ne 'power.inspect') { $state.Remove('battery') }
            return $state
        }
        { $_ -in @('personalization.inspect', 'theme.set', 'wallpaper.set', 'taskbar.set') } { return Get-Personalization }
        { $_ -in @('privacy.get', 'privacy.set') } { return Get-PrivacyState $Parameters.capability }
        { $_ -in @('firewall.get', 'firewall.set') } { return @(Get-NetFirewallProfile | Sort-Object Name | Select-Object Name, Enabled) }
        'storage.inspect' { return [ordered]@{ volumes = @(Get-Volume | Select-Object DriveLetter, FileSystem, Size, SizeRemaining, HealthStatus); candidates = @(Get-TemporaryFiles 7 100) } }
        'storage.cleanup' { return [ordered]@{ candidates = @(Get-TemporaryFiles $Parameters.olderThanDays $Parameters.maxFiles) } }
        { $_ -in @('updates.status', 'updates.scan', 'updates.install') } { return Get-UpdateStatus }
        { $_ -in @('service.inspect', 'service.set') } { return Get-ServiceState $Parameters }
        { $_ -in @('registry.get', 'registry.set') } { $target = Get-RegistryTarget $Parameters.target; return [ordered]@{ target = $Parameters.target; value = Read-Value $target.path $target.name } }
        'policy.inspect' { return [ordered]@{ result = Invoke-NativeCommand 'gpresult.exe' @('/r') } }
        { $_ -in @('policy.get', 'policy.set') } { return Read-LocalGpo $Parameters.target }
        'policy.refresh' { return [ordered]@{ target = $Parameters.target; result = Invoke-NativeCommand 'gpresult.exe' @('/r', '/scope', $Parameters.target) } }
        'settings.open' { return [ordered]@{ page = $Parameters.page } }
        default { return Read-UIAOperation $Operation $Parameters }
    }
}
