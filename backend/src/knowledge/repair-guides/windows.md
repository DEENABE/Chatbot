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
- All Windows Update dependencies at once:
  `Get-Service wuauserv, cryptSvc, bits, msiserver | Select-Object Name, Status`
- Audio endpoints (no sound / wrong device):
  `Get-PnpDevice -Class AudioEndpoint | Select-Object Status, FriendlyName`
- Printers and their status:
  `Get-Printer | Select-Object Name, PrinterStatus`
- Active display count (second monitor not detected):
  `Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBasicDisplayParams | Measure-Object | Select-Object Count`
- Search index service:
  `Get-Service WSearch | Select-Object Status, StartType`
- Store app licensing service (Store apps won't launch):
  `Get-Service ClipSVC | Select-Object Status`
- Time sync (clock drift):
  `Get-Service W32Time | Select-Object Status, StartType`
- Explorer shell process (frozen Start menu / taskbar):
  `Get-Process explorer | Select-Object Id, StartTime`
- OS build and uptime for context:
  `Get-ComputerInfo | Select-Object WindowsProductName, OsBuildNumber, OsUptime`

## Common fixes
- Audio issues — restart the audio service:
  `Restart-Service Audiosrv -Force`
- Print spooler stuck:
  `Restart-Service Spooler -Force`
- Stopped service that should run:
  `Start-Service <name>` or `Restart-Service <name>`
- Windows Update stuck (needs admin):
  `Restart-Service wuauserv` (and `bits`)
- Windows Update download cache corrupt — stop the services first, or the
  rename fails with a file-in-use error (needs admin):
  `Stop-Service wuauserv, bits -Force`
  `Rename-Item 'C:\Windows\SoftwareDistribution' 'SoftwareDistribution.old'`
  `Start-Service wuauserv, bits`
- Frozen Start menu / taskbar — restart the shell:
  `Stop-Process -Name explorer -Force; Start-Process explorer`
- Search finds nothing — start the index service (needs admin):
  `Start-Service WSearch`
- Store apps won't open — start the licensing service (needs admin):
  `Start-Service ClipSVC`
- Clock wrong / won't sync (needs admin):
  `Start-Service W32Time; w32tm /resync`
- Corrupted system files (needs admin):
  `sfc /scannow`; `DISM /Online /Cleanup-Image /RestoreHealth`
- Disabled device (needs admin):
  `Enable-PnpDevice -InstanceId '<id>' -Confirm:$false`
- Verify the service actually came up before finishing:
  `Get-Service <name> | Select-Object Status`

## Notes
- Diagnose with read-only commands first; identify the exact service/device
  before changing anything.
- Service restarts for the current user often work without admin; device
  enable/disable and system-file repair need Administrator rights. On "Access
  is denied", stop retrying — finish and quote the exact elevated command.
- An audio or display endpoint in an `Error` state after an update usually means
  a broken driver. Restarting the service will not clear it; recommend
  reinstalling the driver (Device Manager > uninstall with "delete driver",
  then reboot) — this is a manual step.
- A second monitor that Windows does not list at all is usually a cable, input
  or GPU-driver issue, not a Windows fault. Suggest Win+P > Extend, reseating
  the cable, then a GPU driver update.
- Blurry legacy apps on high-DPI screens are an app limitation. Point the user
  at Properties > Compatibility > Change high DPI settings > System (Enhanced)
  instead of changing system scaling.
- If a rename or delete fails with "used by another process", stop the owning
  service first and retry — do not force it.
- Never delete `C:\Windows\System32` or drive roots to "clean up"; use `sfc`
  and `DISM` to repair system files.
