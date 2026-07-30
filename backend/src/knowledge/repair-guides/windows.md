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

## Subdomain playbooks

The prompt may name a narrower area, e.g. "windows (audio)". Use the matching
playbook below; fall back to the general sections above when none fits.

### eventlog — reading Windows logs to find a root cause
- Recent errors in a log:
  `Get-WinEvent -LogName System -MaxEvents 30 | Where-Object LevelDisplayName -in 'Error','Critical' | Select-Object TimeCreated, Id, ProviderName`
- Filter by a specific event id:
  `Get-WinEvent -FilterHashtable @{LogName='System'; Id=<id>} -MaxEvents 10 | Select-Object TimeCreated, Message`
- Unexpected shutdowns / restarts (41, 6008, 1074):
  `Get-WinEvent -FilterHashtable @{LogName='System'; Id=41,6008,1074} -MaxEvents 10 | Select-Object TimeCreated, Id`
- Application crashes (1000) and .NET faults (1026):
  `Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1026} -MaxEvents 10 | Select-Object TimeCreated, ProviderName`
- Which provider is noisiest:
  `Get-WinEvent -LogName System -MaxEvents 200 | Group-Object ProviderName | Sort-Object Count -Descending | Select-Object -First 5 Count, Name`
- Read the Message field before concluding; an id alone is not a diagnosis.
  The Security log needs Administrator rights.

### errorcode — turning a numeric code into a cause
- Decode an HRESULT / Win32 code:
  `[System.ComponentModel.Win32Exception]::new(<code>).Message`
- Decode an NTSTATUS-style hex code:
  `net helpmsg <decimal-code>`
- Find where the code was logged:
  `Get-WinEvent -LogName System -MaxEvents 100 | Where-Object Message -like '*<code>*' | Select-Object TimeCreated, ProviderName, Id`
- Windows Update failures (0x8024xxxx) usually mean the update stack, not the
  update itself: check `wuauserv`, `bits`, and the SoftwareDistribution cache.
- Always map the code to a real subsystem before running fixes; never guess.

### driver — devices that misbehave after an update
- Devices in a fault state:
  `Get-PnpDevice | Where-Object Status -ne 'OK' | Select-Object Status, Class, FriendlyName, InstanceId`
- Driver version and provider for a device class:
  `Get-CimInstance Win32_PnPSignedDriver | Where-Object DeviceClass -eq '<CLASS>' | Select-Object DeviceName, DriverVersion, DriverProviderName`
- Power-cycle a device (needs admin):
  `Disable-PnpDevice -InstanceId '<id>' -Confirm:$false; Enable-PnpDevice -InstanceId '<id>' -Confirm:$false`
- A device stuck in `Error` after a Windows update almost always needs a driver
  reinstall — that is a manual step (Device Manager > uninstall with "delete
  driver" > reboot), not something to force from PowerShell.

### audio — no sound, wrong device, or mic problems
- Endpoints and their health:
  `Get-PnpDevice -Class AudioEndpoint | Select-Object Status, FriendlyName`
- Audio service:
  `Get-Service Audiosrv, AudioEndpointBuilder | Select-Object Name, Status`
- Restart the audio stack:
  `Restart-Service Audiosrv -Force`
- Microphone devices:
  `Get-PnpDevice -Class AudioEndpoint | Where-Object FriendlyName -like '*Microphone*' | Select-Object Status, FriendlyName`
- If an endpoint is healthy but silent, the default playback device is usually
  wrong — that is a Settings choice, not a repair. If the endpoint is in
  `Error`, recommend a driver reinstall.

### printer — offline, stuck queue, nothing prints
- Printers and status:
  `Get-Printer | Select-Object Name, PrinterStatus, PortName`
- Spooler service:
  `Get-Service Spooler | Select-Object Status, StartType`
- Stuck jobs in the queue:
  `Get-PrintJob -PrinterName '<name>' | Select-Object Id, JobStatus, DocumentName`
- Restart the spooler (needs admin):
  `Restart-Service Spooler -Force`
- Clear a single stuck job:
  `Remove-PrintJob -PrinterName '<name>' -ID <id>`
- "Offline" with the spooler running is usually a stuck job or the
  "Use Printer Offline" checkbox; check the queue before restarting services.

### display — resolution, scaling, second monitor
- Active displays:
  `Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBasicDisplayParams | Measure-Object | Select-Object Count`
- Monitor devices:
  `Get-PnpDevice -Class Monitor | Select-Object Status, FriendlyName`
- Graphics adapter and driver:
  `Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, CurrentHorizontalResolution`
- A monitor Windows does not list at all is a cable/input/GPU-driver issue, not
  a Windows setting. Suggest Win+P > Extend, reseat the cable, update the GPU
  driver — do not change resolution blindly.

### registry — settings that survive reboots
- Read a value:
  `Get-ItemProperty -Path '<hive>:\<path>' -Name '<value>' -ErrorAction SilentlyContinue`
- List startup entries:
  `Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'`
- Set a value (needs admin for HKLM):
  `Set-ItemProperty -Path '<hive>:\<path>' -Name '<value>' -Value <data>`
- Read before writing, change one value at a time, and never delete a hive.
  Registry deletion is blocked for good reason.

### services — something that should be running is not
- State and startup type:
  `Get-Service <name> | Select-Object Name, Status, StartType`
- What a service depends on:
  `Get-Service <name> -RequiredServices | Select-Object Name, Status`
- Start and make it persistent (needs admin):
  `Set-Service <name> -StartupType Automatic; Start-Service <name>`
- If a service refuses to start, check its dependencies first — starting the
  dependency often fixes the symptom without touching the service itself.

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
