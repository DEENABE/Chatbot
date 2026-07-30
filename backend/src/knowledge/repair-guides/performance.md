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
