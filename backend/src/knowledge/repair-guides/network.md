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

## Common fixes
- DNS problems (can ping IPs but names fail):
  `Clear-DnsClientCache` and `ipconfig /flushdns`
- Stale IP / DHCP:
  `ipconfig /release; ipconfig /renew`
- Reset a flaky adapter (needs admin):
  `Restart-NetAdapter -Name '<AdapterName>' -Confirm:$false`
- Wi-Fi adapter disabled:
  `Get-NetAdapter | Where-Object Status -eq 'Disabled'`
  `Enable-NetAdapter -Name '<AdapterName>' -Confirm:$false` (needs admin)
- Winsock / TCP stack corruption (needs admin, may require reboot):
  `netsh winsock reset` and `netsh int ip reset`

## Notes
- Prefer least-disruptive fixes first (flush DNS, renew IP) before resetting
  adapters or the TCP stack.
- Adapter enable/disable/reset and netsh resets require Administrator rights.
