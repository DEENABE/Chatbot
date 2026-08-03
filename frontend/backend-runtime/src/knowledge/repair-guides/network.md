# Network / Wi-Fi Repair Guide

## Diagnose
- Adapters and link state:
  `Get-NetAdapter | Select-Object Name, Status, LinkSpeed, ifIndex`
- IP configuration:
  `Get-NetIPConfiguration`
- Connectivity + DNS:
  `Test-NetConnection -ComputerName 8.8.8.8`
  `Resolve-DnsName microsoft.com`
- Default gateway reachability:
  `Test-NetConnection -ComputerName (Get-NetIPConfiguration | Select-Object -First 1 -ExpandProperty IPv4DefaultGateway).NextHop`
- Which DNS servers are actually assigned:
  `Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, ServerAddresses`
- APIPA check (169.254.x.x means DHCP failed):
  `Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress`
- Wi-Fi signal, radio type and negotiated rate:
  `netsh wlan show interfaces`
- System proxy (a dead proxy black-holes all traffic):
  `netsh winhttp show proxy`
- Adapter power saving (a common cause of random drops):
  `Get-NetAdapterPowerManagement -Name '<AdapterName>'`
- Hosts-file overrides (one site broken, everything else fine):
  `Select-String -Path "$env:SystemRoot\System32\drivers\etc\hosts" -Pattern '<domain>'`
- Resolver latency (slow browsing with good signal):
  `Measure-Command { Resolve-DnsName microsoft.com }`
- Route table / duplicate default routes:
  `Get-NetRoute -DestinationPrefix 0.0.0.0/0`
- VPN dial-up dependency:
  `Get-Service RasMan | Select-Object Name, Status, StartType`
- Physical NIC health (no link light):
  `Get-PnpDevice -Class Net | Select-Object Status, FriendlyName`

## Common fixes
- DNS problems (can ping IPs but names fail):
  `Clear-DnsClientCache` and `ipconfig /flushdns`
- Unreachable or slow resolver — set a reliable public DNS:
  `Set-DnsClientServerAddress -InterfaceAlias '<AdapterName>' -ServerAddresses ('1.1.1.1','8.8.8.8')`
- Stale IP / DHCP:
  `ipconfig /release; ipconfig /renew`
- Reset a flaky adapter (needs admin):
  `Restart-NetAdapter -Name '<AdapterName>' -Confirm:$false`
- Wi-Fi adapter disabled:
  `Get-NetAdapter | Where-Object Status -eq 'Disabled'`
  `Enable-NetAdapter -Name '<AdapterName>' -Confirm:$false` (needs admin)
- Leftover proxy from an uninstalled app:
  `netsh winhttp reset proxy`
- Random disconnects from power saving (needs admin):
  `Disable-NetAdapterPowerManagement -Name '<AdapterName>'`
- VPN cannot connect because the dial-up manager is stopped (needs admin):
  `Set-Service RasMan -StartupType Automatic; Start-Service RasMan`
- Winsock / TCP stack corruption (needs admin, may require reboot):
  `netsh winsock reset` and `netsh int ip reset`
- Verify the fix actually worked before finishing:
  `Test-NetConnection 8.8.8.8 -InformationLevel Quiet`

## Subdomain playbooks

The prompt may name a narrower area, e.g. "network (dns-advanced)". Use the
matching playbook; fall back to the general sections above when none fits.

### dns-advanced — resolution failures and slow lookups
- Measure resolver latency:
  `Measure-Command { Resolve-DnsName <host> } | Select-Object TotalMilliseconds`
- Query a specific server to isolate the resolver:
  `Resolve-DnsName <host> -Server 1.1.1.1 | Select-Object -First 1 Name, IPAddress`
- Current servers per interface:
  `Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, ServerAddresses`
- Inspect the cache:
  `Get-DnsClientCache | Select-Object -First 10 Entry, Data`
- Check the hosts file for overrides:
  `Select-String -Path "$env:SystemRoot\System32\drivers\etc\hosts" -Pattern '<domain>'`
- If a public resolver answers but the configured one does not, the resolver is
  the fault — switch DNS rather than resetting the whole stack.

### vpn / proxy — tunnels and intercepted traffic
- VPN-related services:
  `Get-Service RasMan, *vpn* -ErrorAction SilentlyContinue | Select-Object Name, Status`
- System proxy:
  `netsh winhttp show proxy`
- Reset the proxy to direct:
  `netsh winhttp reset proxy`
- VPN adapters:
  `Get-NetAdapter | Where-Object InterfaceDescription -match 'VPN|TAP|WAN Miniport' | Select-Object Name, Status`
- A proxy pointing at a dead local port (127.0.0.1:xxxx) left behind by an
  uninstalled app silently black-holes all traffic — check this early.

### iis / server — local web services not responding
- Site and app-pool state (needs the IIS module):
  `Get-Service W3SVC | Select-Object Status`
- What is listening on a port:
  `Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq <port> | Select-Object LocalAddress, LocalPort, OwningProcess`
- Map the owning process:
  `Get-Process -Id <pid> | Select-Object Name, Path`
- Test the endpoint locally:
  `Test-NetConnection 127.0.0.1 -Port <port> -InformationLevel Quiet`
- If nothing is listening, the service is down; if it listens but refuses, look
  at the firewall rule for that program.

## Notes
- Prefer least-disruptive fixes first (flush DNS, renew IP) before resetting
  adapters or the TCP stack.
- Adapter enable/disable/reset, `netsh` resets, power-management changes and
  service changes all require Administrator rights. If a command returns
  "Access is denied" or "requires elevation", do not retry it — finish and tell
  the user to relaunch as Administrator, quoting the exact command.
- A full-signal Wi-Fi connection can still be slow: check the band and radio
  type in `netsh wlan show interfaces` (2.4 GHz / 802.11n caps throughput).
- 169.254.x.x is never a working address — it means no DHCP reply was received.
- "Not Present" adapters or PnP devices in an `Error` state usually indicate a
  hardware or cable fault; recommend reseating/replacing rather than software fixes.
- Never delete network registry hives to "reset" networking; use the targeted
  `netsh` resets instead.
