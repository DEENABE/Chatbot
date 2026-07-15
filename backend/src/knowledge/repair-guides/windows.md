# General Windows Repair Guide

Use this for anything not covered by a specialized domain: audio, display,
printers, Windows Update, drivers, services, etc.

## Diagnose
- Service state:
  `Get-Service <name> | Select-Object Name, Status, StartType`
- Problem devices in Device Manager:
  `Get-PnpDevice | Where-Object Status -eq 'Error' | Select-Object Class, FriendlyName, InstanceId`
- Recent system errors:
  `Get-WinEvent -LogName System -MaxEvents 20 | Where-Object LevelDisplayName -in 'Error','Critical' | Select-Object TimeCreated, ProviderName, Id, Message`
- Windows Update service:
  `Get-Service wuauserv, bits | Select-Object Name, Status`

## Common fixes
- Audio issues — restart the audio service:
  `Restart-Service Audiosrv -Force`
- Print spooler stuck:
  `Restart-Service Spooler -Force`
- Stopped service that should run:
  `Start-Service <name>` or `Restart-Service <name>`
- Windows Update stuck (needs admin):
  `Restart-Service wuauserv` (and `bits`)
- Corrupted system files (needs admin):
  `sfc /scannow`; `DISM /Online /Cleanup-Image /RestoreHealth`
- Disabled device (needs admin):
  `Enable-PnpDevice -InstanceId '<id>' -Confirm:$false`

## Notes
- Diagnose with read-only commands first; identify the exact service/device
  before changing anything.
- Service restarts for the current user often work without admin; device
  enable/disable and system-file repair need Administrator rights.
