function Assert-Preconditions([string]$Operation, [hashtable]$Parameters) {
    if ($Operation -in @('network.adapter', 'network.dns', 'network.ipv4', 'power.hibernate', 'firewall.set', 'service.set', 'policy.refresh', 'policy.set')) { Require-Admin }
    switch ($Operation) {
        'service.set' {
            if ($Parameters.name -cnotin (Get-Policy).services) { Fail 'POLICY_DENIED' 'Service not in mutation allowlist' }
        }
        'registry.set' {
            $t = Get-RegistryTarget $Parameters.target
            if (-not $t.writable) { Fail 'POLICY_DENIED' 'Registry target is read-only' }
            if ($t.path.StartsWith('HKLM:')) { Require-Admin }
            if ($t.type -eq 'DWord') { if ($Parameters.value -isnot [int] -and $Parameters.value -isnot [long]) { Fail 'INVALID_ARGUMENTS' 'DWord must be an integer' }; if ($Parameters.value -lt $t.min -or $Parameters.value -gt $t.max) { Fail 'INVALID_ARGUMENTS' 'DWord outside target range' } }
            elseif ($t.type -eq 'String') { if ($Parameters.value -cnotin $t.values) { Fail 'INVALID_ARGUMENTS' 'String value not allowlisted' } }
            else { Fail 'POLICY_DENIED' 'Only DWord and allowlisted String values supported' }
        }
        'wallpaper.set' { $null = Assert-LocalFile $Parameters.path @('.jpg', '.jpeg', '.png', '.bmp') }
        'privacy.set' {
            $s = Get-PrivacyState $Parameters.capability
            if ($Parameters.enabled -and ($s.machineConsent -eq 'Deny' -or $s.appPrivacyPolicy -eq 2 -or ($Parameters.capability -eq 'location' -and $s.locationPolicy -eq 1))) { Fail 'POLICY_DENIED' 'Machine consent or policy denies this capability. Do not bypass it with a registry or UI fallback.' }
        }
    }
}
function Apply-Operation([string]$Operation, [hashtable]$Parameters, $Before) {
    switch ($Operation) {
        'network.adapter' {
            $adapter = Get-NetAdapter | Where-Object ifIndex -EQ $Parameters.interfaceIndex
            if ($Parameters.enabled) { $adapter | Enable-NetAdapter -Confirm:$false } else { $adapter | Disable-NetAdapter -Confirm:$false }
        }
        'network.dns' {
            if ($Parameters.reset) { Set-DnsClientServerAddress -InterfaceIndex $Parameters.interfaceIndex -ResetServerAddresses }
            else { Set-DnsClientServerAddress -InterfaceIndex $Parameters.interfaceIndex -ServerAddresses $Parameters.servers }
        }
        'network.ipv4' {
            $i = $Parameters.interfaceIndex
            # Explicit plan approval is required: this replaces manual addresses on this one adapter.
            Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object PrefixOrigin -EQ 'Manual' | Remove-NetIPAddress -Confirm:$false
            Get-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Where-Object Protocol -EQ 'NetMgmt' | Remove-NetRoute -Confirm:$false
            if ($Parameters.mode -eq 'dhcp') { Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Enabled }
            else {
                Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Disabled
                $null = New-NetIPAddress -InterfaceIndex $i -IPAddress $Parameters.address -PrefixLength $Parameters.prefixLength -DefaultGateway $Parameters.gateway -AddressFamily IPv4
            }
        }
        'wifi.connect' {
            $null = Invoke-NativeCommand 'netsh.exe' @('wlan', 'connect', "name=$($Parameters.profile)", "interface=$($Parameters.interface)")
        }
        'radio.set' { Set-RadioState $Parameters }
        'display.mode' { Load-Native; [LocalOS.Desktop]::SetMode($Parameters.device, $Parameters.width, $Parameters.height, $Parameters.frequency) }
        'display.topology' { Load-Native; [LocalOS.Desktop]::SetTopology(@{ internal = 1; clone = 2; extend = 4; external = 8 }[$Parameters.topology]) }
        'brightness.set' {
            $monitors = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods | Where-Object InstanceName -CEQ $Parameters.instance)
            if ($monitors.Count -ne 1) { Fail 'MONITOR_NOT_FOUND' 'WMI monitor instance is not unique' }
            $result = Invoke-CimMethod -InputObject $monitors[0] -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]0; Brightness = [byte]$Parameters.percent }
            if ($result.ReturnValue -ne 0) { Fail 'BRIGHTNESS_FAILED' "WMI result: $($result.ReturnValue)" }
        }
        'audio.volume' {
            Load-Native
            $level = if ($Parameters.ContainsKey('percent')) { [Nullable[single]]$Parameters.percent } else { $null }
            $muted = if ($Parameters.ContainsKey('muted')) { [Nullable[bool]]$Parameters.muted } else { $null }
            [LocalOS.Audio]::Set($level, $muted)
        }
        'power.plan' {
            $plans = Invoke-NativeCommand 'powercfg.exe' @('/list')
            if ($plans -notmatch [regex]::Escape($Parameters.guid)) { Fail 'PLAN_NOT_FOUND' 'Power scheme was not enumerated' }
            $null = Invoke-NativeCommand 'powercfg.exe' @('/setactive', $Parameters.guid)
        }
        'power.timeout' { $null = Invoke-NativeCommand 'powercfg.exe' @('/change', "$($Parameters.setting)-timeout-$($Parameters.source)", [string]$Parameters.minutes) }
        'power.hibernate' { $value = if ($Parameters.enabled) { 'on' } else { 'off' }; $null = Invoke-NativeCommand 'powercfg.exe' @('/hibernate', $value) }
        'theme.set' {
            $light = if ($Parameters.mode -eq 'light') { 1 } else { 0 }
            $path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
            Write-Value $path 'AppsUseLightTheme' $light
            Write-Value $path 'SystemUsesLightTheme' $light
            Load-Native; [LocalOS.Desktop]::NotifyPreferences()
        }
        'wallpaper.set' { Load-Native; [LocalOS.Desktop]::Wallpaper((Assert-LocalFile $Parameters.path @('.jpg', '.jpeg', '.png', '.bmp'))) }
        'taskbar.set' { Load-Native; [LocalOS.Desktop]::SetAutoHide($Parameters.autoHide) }
        'privacy.set' {
            $value = if ($Parameters.enabled) { 'Allow' } else { 'Deny' }
            Write-Value ('HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\' + $Parameters.capability) 'Value' $value 'String'
        }
        'firewall.set' { Set-NetFirewallProfile -Profile $Parameters.profiles -Enabled $Parameters.enabled }
        'storage.cleanup' {
            $deleted = New-Object 'System.Collections.Generic.List[string]'
            $skipped = New-Object 'System.Collections.Generic.List[object]'
            foreach ($candidate in $Before.candidates) {
                try {
                    # Check every ancestor again immediately before deletion, including the file itself.
                    $file = Get-Item -LiteralPath $candidate.path -Force
                    if ($file.PSIsContainer -or $file.Length -ne $candidate.bytes -or $file.LastWriteTimeUtc.ToString('o') -ne $candidate.lastWriteUtc) { throw 'File changed after preview' }
                    $cursor = $file
                    while ($null -ne $cursor) {
                        if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point found' }
                        if ($cursor -is [IO.FileInfo]) { $cursor = $cursor.Directory } else { $cursor = $cursor.Parent }
                    }
                    Remove-Item -LiteralPath $file.FullName -Force
                    if (Test-Path -LiteralPath $file.FullName) { throw 'File still exists' }
                    $deleted.Add($file.FullName)
                } catch { $skipped.Add([pscustomobject]@{ path = $candidate.path; reason = $_.Exception.Message }) }
            }
            return [ordered]@{ deleted = $deleted.ToArray(); skipped = $skipped.ToArray() }
        }
        'updates.scan' {
            $session = New-Object -ComObject Microsoft.Update.Session
            $searcher = $session.CreateUpdateSearcher()
            try {
                $result = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
                return [ordered]@{ resultCode = $result.ResultCode; updates = @($result.Updates | ForEach-Object { [pscustomobject]@{ title = $_.Title; id = $_.Identity.UpdateID; downloaded = $_.IsDownloaded; eulaAccepted = $_.EulaAccepted } }) }
            } finally { $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($searcher); $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($session) }
        }
        'updates.install' { Open-SettingsPage 'windowsupdate'; return [ordered]@{ status = 'manual_action_required'; message = 'Windows Update is open. Review and start installation in Settings. No updates were installed by this operation.' } }
        'service.set' {
            $service = Get-Service | Where-Object Name -CEQ $Parameters.name
            if ($null -eq $service) { Fail 'SERVICE_NOT_FOUND' 'Exact service was not found' }
            switch ($Parameters.action) {
                'start' { $service | Start-Service }
                'stop' { $service | Stop-Service }
                'restart' { $service | Restart-Service }
                'configure' { $service | Set-Service -StartupType $Parameters.startupType }
            }
        }
        'registry.set' { $t = Get-RegistryTarget $Parameters.target; Write-Value $t.path $t.name $Parameters.value $t.type }
        'policy.refresh' { return [ordered]@{ output = Invoke-NativeCommand 'gpupdate.exe' @("/target:$($Parameters.target)", '/force', '/wait:20') } }
        'policy.set' { Set-LocalGpo $Parameters.target $Parameters.value }
        'settings.open' { Open-SettingsPage $Parameters.page; return [ordered]@{ status = 'opened'; page = $Parameters.page; verifiedSetting = $false } }
        default { return Set-UIAOperation $Operation $Parameters }
    }
    return $null
}

function Verify-Operation([string]$Operation, [hashtable]$Parameters, $After, $Effect) {
    switch ($Operation) {
        'network.adapter' { return [bool]($After.adapter.AdminStatus.ToString() -eq $(if ($Parameters.enabled) { 'Up' } else { 'Down' })) }
        'network.dns' {
            if ($Parameters.reset) { return $null } # Server list alone cannot prove the source is DHCP.
            $actual = @($After.dns | ForEach-Object ServerAddresses | Sort-Object -Unique)
            return (($actual -join ',') -eq (($Parameters.servers | Sort-Object -Unique) -join ','))
        }
        'network.ipv4' {
            if ($Parameters.mode -eq 'dhcp') { return [bool](@($After.interfaces | Where-Object { $_.Dhcp.ToString() -eq 'Enabled' }).Count -gt 0) }
            return [bool](@($After.ipv4 | Where-Object { $_.IPAddress -eq $Parameters.address -and $_.PrefixLength -eq $Parameters.prefixLength }).Count -eq 1 -and @($After.routes | Where-Object NextHop -EQ $Parameters.gateway).Count -gt 0)
        }
        'wifi.connect' { return $null } # netsh output is localized; do not claim association merely from command success.
        'radio.set' { $state = if ($Parameters.enabled) { 'On' } else { 'Off' }; return [bool](@($After | Where-Object { $_.kind -eq $Parameters.kind -and $_.state -eq $state }).Count -eq 1) }
        'display.mode' { return [bool](@($After | Where-Object { $_.device -ceq $Parameters.device -and $_.current.width -eq $Parameters.width -and $_.current.height -eq $Parameters.height -and $_.current.frequency -eq $Parameters.frequency }).Count -eq 1) }
        'display.topology' { return [bool]($After.topology -eq @{ internal = 1; clone = 2; extend = 4; external = 8 }[$Parameters.topology]) }
        'brightness.set' { return [bool](@($After | Where-Object { $_.InstanceName -ceq $Parameters.instance -and [Math]::Abs($_.CurrentBrightness - $Parameters.percent) -le 1 }).Count -eq 1) }
        'audio.volume' { return [bool](((-not $Parameters.ContainsKey('percent')) -or ($null -ne $After.percent -and [Math]::Abs($After.percent - $Parameters.percent) -le 1)) -and ((-not $Parameters.ContainsKey('muted')) -or $After.muted -eq $Parameters.muted)) }
        'power.plan' { return [bool]($After.activeGuid -eq $Parameters.guid) }
        'power.timeout' {
            $values = [regex]::Matches($After[$Parameters.setting], '0x([0-9a-fA-F]{8})')
            if ($values.Count -lt 2) { return $null }
            # powercfg emits range/increment values before the final AC/DC indexes.
            $i = if ($Parameters.source -eq 'ac') { $values.Count - 2 } else { $values.Count - 1 }
            return [bool]([Convert]::ToUInt32($values[$i].Groups[1].Value, 16) -eq $Parameters.minutes * 60)
        }
        'power.hibernate' { return [bool]([bool]$After.hibernationEnabled -eq $Parameters.enabled) }
        'theme.set' { $light = if ($Parameters.mode -eq 'light') { 1 } else { 0 }; return [bool]($After.appsLight -eq $light -and $After.systemLight -eq $light) }
        'wallpaper.set' { return [bool]($After.wallpaper -eq $Parameters.path) }
        'taskbar.set' { return [bool]($After.autoHide -eq $Parameters.autoHide) }
        'privacy.set' { return [bool]($After.userConsent -eq $(if ($Parameters.enabled) { 'Allow' } else { 'Deny' })) }
        'firewall.set' { return [bool](@($After | Where-Object { $_.Name -in $Parameters.profiles -and [bool][int]$_.Enabled -eq $Parameters.enabled }).Count -eq $Parameters.profiles.Count) }
        'service.set' { if ($Parameters.action -eq 'configure') { return [bool]($After.StartType.ToString() -eq $Parameters.startupType) }; return [bool]($After.Status.ToString() -eq $(if ($Parameters.action -eq 'stop') { 'Stopped' } else { 'Running' })) }
        'registry.set' { return [bool]($After.value -ceq $Parameters.value) }
        'policy.set' { return [bool]($After.configured -ieq "DWORD:$($Parameters.value)" -and $After.effective -eq $Parameters.value) }
        'storage.cleanup' { return [bool]($Effect.skipped.Count -eq 0) }
        'updates.scan' { return [bool]($Effect.resultCode -eq 2) }
        { $_ -in @('settings.open', 'updates.install', 'policy.refresh') } { return $null }
        default { return Verify-UIAOperation $Operation $Parameters $After }
    }
}
