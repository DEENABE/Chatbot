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

## Common fixes
- Low disk space — clear the current user's temp files (safe):
  `Remove-Item "$env:TEMP\*" -Recurse -Force -ErrorAction SilentlyContinue`
- Windows Update / delivery cache bloat (needs admin):
  `Get-ChildItem "$env:WINDIR\SoftwareDistribution\Download" -ErrorAction SilentlyContinue`
- A single runaway process — identify it, then recommend the user close it
  (only kill on explicit request; killing is disruptive):
  `Stop-Process -Id <pid>` (ask first)

## Notes
- Never kill critical processes (System, lsass, csrss, winlogon, services).
- Deleting outside the user's own temp/cache is destructive — recommend, don't
  auto-run.
