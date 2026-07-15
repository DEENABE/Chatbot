# Bluetooth Repair Guide

## Diagnose
- List Bluetooth devices and their state:
  `Get-PnpDevice -Class Bluetooth | Select-Object Status, FriendlyName, InstanceId` 
- Check the Bluetooth Support Service:
  `Get-Service bthserv | Select-Object Name, Status, StartType`
- Radio state (software on/off) via the Radios API:
  `Get-CimInstance -Namespace root/wmi -ClassName MSBTH_Radio -ErrorAction SilentlyContinue`

## Common fixes
- Radio is OFF (device Status is OK but Bluetooth won't turn on): this is a
  software radio toggle. Start the service, then the radio usually needs a
  toggle in Settings if the WinRT Radios API is unavailable non-interactively:
  `Start-Service bthserv`
- Bluetooth Support Service stopped:
  `Start-Service bthserv` (or `Set-Service bthserv -StartupType Automatic; Start-Service bthserv`)
- Adapter is Disabled/Error in Device Manager (needs admin):
  `Get-PnpDevice -Class Bluetooth | Where-Object Status -eq 'Error'`
  `Enable-PnpDevice -InstanceId '<InstanceId>' -Confirm:$false`
- Driver glitch — disable then re-enable the adapter (needs admin):
  `Disable-PnpDevice -InstanceId '<id>' -Confirm:$false; Start-Sleep 2; Enable-PnpDevice -InstanceId '<id>' -Confirm:$false`

## Notes
- Enabling/disabling PnP devices and radios requires Administrator rights.
- If admin is unavailable, recommend the user toggle Bluetooth in
  Settings > Devices, or run the app as Administrator.


