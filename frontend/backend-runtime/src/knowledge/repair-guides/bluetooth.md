# Bluetooth Repair Guide

## Diagnose
- List Bluetooth devices and their state:
  `Get-PnpDevice -Class Bluetooth | Select-Object Status, FriendlyName, InstanceId`
- Check the Bluetooth Support Service:
  `Get-Service bthserv | Select-Object Name, Status, StartType`
- Radio state (software on/off) via the Radios API:
  `Get-CimInstance -Namespace root/wmi -ClassName MSBTH_Radio -ErrorAction SilentlyContinue`
- No Bluetooth at all in Device Manager (radio missing vs disabled):
  `Get-PnpDevice -Class Bluetooth | Measure-Object | Select-Object Count`
- Supporting services for audio/transfer profiles:
  `Get-Service BthAvctpSvc, BluetoothUserService* | Select-Object Name, Status`
- Audio endpoints (a paired speaker that makes no sound):
  `Get-PnpDevice -Class AudioEndpoint | Select-Object Status, FriendlyName`
- Hands-Free vs Stereo profile in use (stuttering audio when the mic is live):
  `Get-PnpDevice | Where-Object FriendlyName -like '*Hands-Free*' | Select-Object Status, FriendlyName`
- Driver details for the radio:
  `Get-PnpDeviceProperty -InstanceId '<InstanceId>' -KeyName DEVPKEY_Device_DriverVersion`

## Common fixes
- Radio is OFF (device Status is OK but Bluetooth won't turn on): this is a
  software radio toggle. Start the service, then the radio usually needs a
  toggle in Settings if the WinRT Radios API is unavailable non-interactively:
  `Start-Service bthserv`
- Bluetooth Support Service stopped:
  `Start-Service bthserv` (or `Set-Service bthserv -StartupType Automatic; Start-Service bthserv`)
- Bluetooth turns itself off after every reboot — make the service persistent:
  `Set-Service bthserv -StartupType Automatic`
- Adapter is Disabled/Error in Device Manager (needs admin):
  `Get-PnpDevice -Class Bluetooth | Where-Object Status -eq 'Error'`
  `Enable-PnpDevice -InstanceId '<InstanceId>' -Confirm:$false`
- Driver glitch — disable then re-enable the adapter (needs admin):
  `Disable-PnpDevice -InstanceId '<id>' -Confirm:$false; Start-Sleep 2; Enable-PnpDevice -InstanceId '<id>' -Confirm:$false`
- File transfers to a phone failing — start the AVCTP transport service:
  `Start-Service BthAvctpSvc`
- Pairing glitches — refresh the whole stack instead of removing devices:
  `Restart-Service bthserv -Force`
- Verify the stack is up before finishing:
  `Get-Service bthserv | Select-Object Status`

## Notes
- Enabling/disabling PnP devices and radios requires Administrator rights.
- If admin is unavailable, recommend the user toggle Bluetooth in
  Settings > Devices, or run the app as Administrator.
- A paired audio device that shows a healthy endpoint but plays no sound is
  usually not the default playback device — tell the user to select it in
  Settings > Sound rather than re-pairing.
- Audio that stutters only while the microphone is active is the Hands-Free
  (HFP) profile taking over; this is a Bluetooth profile limitation, not a
  fault. Recommend using the Stereo (A2DP) device for music.
- Never bulk-remove all Bluetooth PnP devices — that can remove the radio
  itself. Remove only the specific problem device from Settings and re-pair.
- Interference (2.4 GHz Wi-Fi, USB 3 hubs) and low device batteries cause lag
  and skipping even when every device reports OK.
