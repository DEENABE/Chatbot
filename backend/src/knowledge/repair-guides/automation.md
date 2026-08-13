# Automation Repair Guide

## Diagnose
- Check whether a task with this name already exists before creating one:
  `Get-ScheduledTask -TaskName 'Chanakya-<Name>' -ErrorAction SilentlyContinue`
- List every non-Microsoft scheduled task (safe to review for removal; `\Microsoft\*` tasks are the OS's own):
  `Get-ScheduledTask | Where-Object TaskPath -notlike '\Microsoft\*' | Select-Object TaskName, TaskPath, State`
- Check a task's last run result and next run time:
  `Get-ScheduledTaskInfo -TaskName 'Chanakya-<Name>' | Select-Object LastRunTime, LastTaskResult, NextRunTime`
- Confirm a source/destination path exists before wiring a backup or sync job:
  `Test-Path 'C:\Path\To\Folder'`
- Check free space on a destination drive:
  `Get-Volume -DriveLetter D | Select-Object DriveLetter, SizeRemaining`
- List everything that currently starts with Windows (four separate mechanisms — Task Manager's Startup tab only shows two of them):
  `Get-CimInstance Win32_StartupCommand | Select-Object Name, Location, Command`
  `Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup" -ErrorAction SilentlyContinue`
  `Get-ScheduledTask | Where-Object { $_.Triggers.CimClass.CimClassName -contains 'MSFT_TaskLogonTrigger' }`
- Preview what a cleanup job would remove before scheduling it (dry run, never delete first):
  `Get-ChildItem $env:TEMP -Recurse -File -ErrorAction SilentlyContinue | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7) | Measure-Object Length -Sum`

## Common fixes
- Register a scheduled task (generic pattern — swap the action/trigger):
  `$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -Command "<command>"'`
  `$t = New-ScheduledTaskTrigger -Daily -At 22:00`
  `Register-ScheduledTask -TaskName 'Chanakya-<Name>' -Action $a -Trigger $t -RunLevel Highest`
- Weekly trigger on specific days: `New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Wednesday,Friday -At 07:00`
- Logon trigger (app launch, not a fixed time — follows actual sign-in): `New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`
- Recurring interval (health checks, monitors): `New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 4)`
- Folder backup (mirrors — deletions at the source ARE applied to the backup, confirm this with the user first): `robocopy "<source>" "<dest>" /MIR /R:2 /W:5 /LOG+:<dest>\backup.log`
- Folder backup without mirroring deletions: `robocopy "<source>" "<dest>" /E`
- Delete a task: `Unregister-ScheduledTask -TaskName 'Chanakya-<Name>' -Confirm:$false`
- Pause a task without deleting it (prefer this when the user might want it back): `Disable-ScheduledTask -TaskName 'Chanakya-<Name>'`
- Disable a startup app reversibly (matches what Task Manager's Disable button does — do not delete the Run key entry):
  `Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' -Name '<AppName>' -Value ([byte[]](3,0,0,0,0,0,0,0,0,0,0,0))`
- Export event log entries on a schedule (read-only, never clears the log — `wevtutil cl` destroys evidence and must never be used here):
  `Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2; StartTime=(Get-Date).AddDays(-1)} | Export-Csv "<path>" -NoTypeInformation`
- Start/stop a service on a schedule: `New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -Command "Stop-Service <name> -Force"'`

## Notes
- Name every task you create with a `Chanakya-` prefix so it can be found and cleaned up later.
- `Register-ScheduledTask` over an existing task name silently overwrites it — always check existence first with `Get-ScheduledTask`, and offer to update in place (`Set-ScheduledTask`) rather than blindly re-registering.
- Never propose deleting ALL scheduled tasks. The overwhelming majority belong to Windows itself (`\Microsoft\*`) and are required for updates, defrag, and maintenance — only list and offer non-Microsoft tasks for removal.
- Recurring deletion (temp cleanup, Downloads purge) needs a dry run shown to the user first, with an explicit age threshold — never delete a whole folder unconditionally on a schedule.
- Shutdown/restart scheduling and stopping a service with dependents are high-risk: run `classifyCommand`-sensitive text (e.g. `shutdown /s`, `shutdown /r`) will be BLOCKED by the safety layer even inside a `Register-ScheduledTask` call — this is intentional, not a bug. Tell the user to run the equivalent command manually, or that it requires a design that asks for confirmation before every run, which this agent cannot do unattended.
- `-RunLevel Highest` requires an elevated session; check `Test-Path`/service dependencies before registering, and if elevation is missing, say so rather than silently registering a task that will fail every run.
- A destination drive that isn't currently attached (external/network drive) should be surfaced before creating the task — a task registered against a missing path just fails silently on every run.
