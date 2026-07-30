# Performance Repair Guide

## Diagnose
- Top CPU consumers:
  `Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Name, Id, CPU`
- Top memory consumers:
  `Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 8 Name, Id, @{N='Mem(MB)';E={[math]::Round($_.WorkingSet/1MB)}}`
- Free RAM:
  `Get-CimInstance Win32_OperatingSystem | Select-Object @{N='FreeGB';E={[math]::Round($_.FreePhysicalMemory/1MB,1)}}, @{N='TotalGB';E={[math]::Round($_.TotalVisibleMemorySize/1MB,1)}}`
- Disk space:
  `Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, @{N='FreeGB';E={[math]::Round($_.SizeRemaining/1GB,1)}}, @{N='SizeGB';E={[math]::Round($_.Size/1GB,1)}}`
- Startup programs:
  `Get-CimInstance Win32_StartupCommand | Select-Object Name, Command`
- Sustained disk pressure (100% disk in Task Manager):
  `Get-Counter '\PhysicalDisk(_Total)\% Disk Time' -SampleInterval 1 -MaxSamples 3`
- Disk type and health (HDD vs SSD changes the advice):
  `Get-PhysicalDisk | Select-Object MediaType, HealthStatus, Size`
- Background services that thrash mechanical disks:
  `Get-Service SysMain, WSearch | Select-Object Name, Status`
- Size of the user temp folder before clearing it:
  `Get-ChildItem $env:TEMP -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum`
- Active power plan (throttling / wake stutter):
  `powercfg /getactivescheme`
- Available sleep states:
  `powercfg /a`
- Boot-time process pile-up:
  `Get-Process | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-2) } | Measure-Object`
- Windows Update / delivery cache bloat (needs admin):
  `Get-ChildItem "$env:WINDIR\SoftwareDistribution\Download" -ErrorAction SilentlyContinue`

## Common fixes
- Low disk space — clear the current user's temp files (safe):
  `Remove-Item "$env:TEMP\*" -Recurse -Force -ErrorAction SilentlyContinue`
- Reclaim update/cache space safely with the built-in cleaner:
  `cleanmgr /verylowdisk`
- Sustained 100% disk time on an HDD caused by prefetch (needs admin):
  `Stop-Service SysMain; Set-Service SysMain -StartupType Disabled`
- A single runaway process — identify it, then recommend the user close it
  (only kill on explicit request; killing is disruptive):
  `Stop-Process -Id <pid>` (ask first)
- Confirm the space was actually reclaimed before finishing:
  `Get-PSDrive C | Select-Object @{N='FreeGB';E={[int]($_.Free/1GB)}}`

## Subdomain playbooks

The prompt may name a narrower area, e.g. "performance (gpu)". Use the matching
playbook; fall back to the general sections above when none fits.

### cpu — high or stuck processor usage
- Top consumers by accumulated CPU:
  `Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name, Id, CPU`
- Live processor load:
  `Get-CimInstance Win32_Processor | Select-Object Name, LoadPercentage, NumberOfCores`
- Per-process CPU sample:
  `Get-Counter '\Process(*)\% Processor Time' -MaxSamples 1 | Select-Object -ExpandProperty CounterSamples | Sort-Object CookedValue -Descending | Select-Object -First 5 InstanceName, CookedValue`
- `System` (PID 4) and `MsMpEng` cannot be killed and are expected to be busy
  at times. Sustained high `System` CPU means a driver, not an app.

### gpu — graphics load, driver, or thermal issues
- Adapter and driver:
  `Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterRAM, Status`
- GPU engine utilisation:
  `Get-Counter '\GPU Engine(*)\Utilization Percentage' -MaxSamples 1 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples | Where-Object CookedValue -gt 0 | Sort-Object CookedValue -Descending | Select-Object -First 5 InstanceName, CookedValue`
- Display device health:
  `Get-PnpDevice -Class Display | Select-Object Status, FriendlyName`
- A GPU in `Error` state or an old driver is the usual cause of stutter and
  crashes; recommend a vendor driver update rather than tweaking settings.

### memory — RAM pressure and leaks
- Free vs total:
  `Get-CimInstance Win32_OperatingSystem | Select-Object @{N='FreeGB';E={[math]::Round($_.FreePhysicalMemory/1MB,1)}}, @{N='TotalGB';E={[math]::Round($_.TotalVisibleMemorySize/1MB,1)}}`
- Biggest working sets:
  `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 Name, @{N='MB';E={[int]($_.WorkingSet64/1MB)}}`
- Installed physical modules:
  `Get-CimInstance Win32_PhysicalMemory | Select-Object BankLabel, @{N='GB';E={[int]($_.Capacity/1GB)}}, Speed`
- A single app growing steadily over hours is a leak — restarting that app is
  the fix; adding RAM only delays it.

### boot — slow startup or long login
- Disk media type (the biggest boot factor):
  `Get-PhysicalDisk | Select-Object MediaType, HealthStatus, @{N='GB';E={[int]($_.Size/1GB)}}`
- Startup programs:
  `Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location`
- Last boot time and uptime:
  `Get-CimInstance Win32_OperatingSystem | Select-Object LastBootUpTime`
- Boot-time events:
  `Get-WinEvent -FilterHashtable @{LogName='System'; Id=100} -MaxEvents 5 -ErrorAction SilentlyContinue | Select-Object TimeCreated`
- On an HDD the media type dominates; trim startup apps, then recommend an SSD.

### power — battery, sleep, and wake problems
- Active power scheme:
  `powercfg /getactivescheme`
- Available sleep states:
  `powercfg /a`
- What last woke the machine:
  `powercfg /lastwake`
- Devices allowed to wake the system:
  `powercfg /devicequery wake_armed`
- A brief freeze after wake is normal device re-initialisation. Random wakes
  usually come from a network adapter or scheduled task in the list above.

## Notes
- Never kill critical processes (System, lsass, csrss, winlogon, services).
  These are protected and will return "Access is denied" — that is expected, not
  a failure to retry.
- High CPU under the `System` process (PID 4) is kernel/driver activity, not an
  app. Recommend driver updates rather than trying to kill it.
- High CPU in `MsMpEng` is Windows Defender scanning; it is protected and
  normal. Suggest Defender exclusions for large build folders instead.
- Deleting outside the user's own temp/cache is destructive — recommend, don't
  auto-run. Never format or delete the recovery partition to free space.
- "The process cannot access the file because it is being used" while clearing
  temp is expected — in-use files are skipped safely.
- Slow boot on an HDD with many startup apps is a hardware limit; the real fix
  is trimming startup items and moving to an SSD.
- A steadily growing working set in one long-running app (Electron apps, Teams)
  is a memory leak — recommend restarting/updating that app, not system changes.
- If free RAM is very low while one app holds most of it, the system is healthy
  and the load is application-driven; say so instead of "fixing" Windows.
