#!/usr/bin/env python3
"""
gen_automation.py - builds the AUTOMATION half of the Chanakya dataset.

This is a DIFFERENT record type from troubleshooting. Troubleshooting teaches
  symptom -> evidence -> root cause -> fix
Automation teaches
  request -> intent -> parameter extraction -> plan preview -> CONFIRMATION
          -> execute -> verify -> rollback path

Key schema additions over the troubleshooting records:
  intent               canonical action id (routing target for the planner)
  parameters           slots extracted from the user's sentence
  missingParameters    slots the agent must ASK about, never guess
  riskLevel            low | medium | high
  requiresConfirmation whether the plan must be shown before executing
  plannedAction        the exact preview text shown to the user
  verification         commands proving the action actually took effect
  rollback             how to undo it

The `blocked` / `reason` fields (already present in the troubleshooting schema
but always false/null there) become meaningful here: a step with
blocked=true, reason="awaiting user confirmation" is the confirmation gate.

Outputs: automation-sessions.json  +  automation-dataset.jsonl
"""
import json, uuid
from datetime import datetime, timedelta

SESS = "automation-sessions.json"
JSNL = "automation-dataset.jsonl"

SYSTEM = ("You are Chanakya, a Windows automation agent. Extract the intent and "
          "parameters from the user's request. Ask about any missing parameter "
          "rather than guessing. Show the planned action and obtain confirmation "
          "before anything that creates, modifies or deletes system state. "
          "After executing, verify the result and state how to undo it.")

# (intent, subdomain, goal, params, missing, clarification, risk, confirm,
#  plannedAction, steps[(cmd, blocked, exit, out, err, reason)], verification[(cmd,out)],
#  rollback, resolved, summary, recommendation, feedback(worked,note))
R = [
# ---------------------------------------------------------------- 1 backup
("schedule.backup.folder","Task Scheduler",
 "Back up my Documents folder to the D drive every night",
 {"source":"C:\\Users\\jdoe\\Documents","destination":"D:\\Backups\\Documents","time":"22:00","frequency":"daily"},
 ["retention"],
 "How many days of backups should I keep before old ones are removed? I will not delete anything until you tell me.",
 "medium", True,
 "Create scheduled task 'Chanakya-BackupDocuments'\n  Runs: daily at 22:00\n  Action: robocopy \"C:\\Users\\jdoe\\Documents\" \"D:\\Backups\\Documents\" /MIR /R:2 /W:5 /LOG+:D:\\Backups\\backup.log\n  Runs as: current user, highest privileges\n  NOTE: /MIR mirrors - files deleted from the source WILL be deleted from the backup.",
 [("Test-Path 'C:\\Users\\jdoe\\Documents'",False,0,"True","",None),
  ("Get-Volume -DriveLetter D | Select-Object DriveLetter, SizeRemaining",False,0,"DriveLetter  SizeRemaining\n-----------  -------------\nD             487302610944","",None),
  ("Get-ScheduledTask -TaskName 'Chanakya-BackupDocuments' -ErrorAction SilentlyContinue",False,1,"","(task does not exist yet)",None),
  ("<awaiting confirmation of the plan above>",True,0,"","","User must confirm: /MIR deletes files from the backup that were removed at the source"),
  ("$a=New-ScheduledTaskAction -Execute 'robocopy.exe' -Argument '\"C:\\Users\\jdoe\\Documents\" \"D:\\Backups\\Documents\" /MIR /R:2 /W:5 /LOG+:D:\\Backups\\backup.log'; $t=New-ScheduledTaskTrigger -Daily -At 22:00; Register-ScheduledTask -TaskName 'Chanakya-BackupDocuments' -Action $a -Trigger $t -RunLevel Highest",False,0,"TaskPath TaskName                    State\n-------- --------                    -----\n\\        Chanakya-BackupDocuments    Ready","",None)],
 [("Get-ScheduledTask -TaskName 'Chanakya-BackupDocuments' | Select-Object TaskName, State","Chanakya-BackupDocuments  Ready"),
  ("(Get-ScheduledTask -TaskName 'Chanakya-BackupDocuments').Triggers | Select-Object StartBoundary","StartBoundary : 2026-08-12T22:00:00")],
 "Unregister-ScheduledTask -TaskName 'Chanakya-BackupDocuments' -Confirm:$false",
 True,
 "The request specified source, destination and timing but not retention. Retention was asked about rather than assumed, because /MIR is destructive on the backup side. Once confirmed, the task was registered and verified as Ready with the correct trigger.",
 "Run the task once manually to confirm the first copy succeeds before relying on it. If you want deleted files kept in the backup, replace /MIR with /E, which copies without mirroring deletions.",
 (True,"task created and the first run copied everything")),
("schedule.backup.folder","Task Scheduler",
 "Set up a backup but the destination drive isn't plugged in right now",
 {"source":"C:\\Work","destination":"E:\\Backup","frequency":"daily","time":"18:00"},
 [], None, "medium", True,
 "Create scheduled task 'Chanakya-BackupWork' running daily at 18:00.\n  WARNING: E: is not currently present. The task will be created, but every run will fail until the drive is attached.\n  Recommended: add a pre-check so the task exits quietly instead of erroring when the drive is missing.",
 [("Test-Path 'E:\\'",False,1,"False","",None),
  ("Get-Volume | Select-Object DriveLetter, FileSystemLabel, DriveType",False,0,"DriveLetter FileSystemLabel DriveType\n----------- --------------- ---------\nC           System          Fixed\nD           Data            Fixed","",None),
  ("<awaiting confirmation: destination drive not present>",True,0,"","","User must confirm creating a task whose destination does not currently exist")],
 [], None, False,
 "The destination drive is not attached, so the task would be registered but fail on every run. Rather than creating a silently broken schedule, the situation was surfaced and confirmation requested.",
 "Attach the drive and re-run this request so the destination can be validated, or confirm creation with a guard clause: wrap the robocopy in a check that exits 0 when E:\\ is absent, so a missing drive does not fill the task history with failures.",
 (False,"waiting until I get the external drive back")),
# ---------------------------------------------------------------- 2 sync
("schedule.sync.files","Task Scheduler",
 "Keep my project folder in sync with the network share automatically",
 {"local":"C:\\Projects","remote":"\\\\fileserver\\projects","frequency":"hourly"},
 ["direction"],
 "Should this be one-way (local overwrites the share), one-way (share overwrites local), or two-way? One-way mirroring can delete files on the losing side, so I need this before proceeding.",
 "high", True,
 "Create scheduled task 'Chanakya-SyncProjects'\n  Runs: hourly\n  Action (pending direction choice): robocopy with /MIR in the confirmed direction\n  NOTE: robocopy cannot do true two-way sync. If you need two-way, I will recommend a purpose-built tool instead of building it from robocopy.",
 [("Test-Path 'C:\\Projects'",False,0,"True","",None),
  ("Test-NetConnection fileserver -Port 445 -InformationLevel Quiet",False,0,"True","",None),
  ("Get-ChildItem 'C:\\Projects' -Recurse -File | Measure-Object | Select-Object Count",False,0,"Count\n-----\n 4821","",None),
  ("<blocked: sync direction not specified>",True,0,"","","Cannot choose a mirroring direction on the user's behalf - wrong choice destroys data")],
 [], None, False,
 "Both endpoints are reachable and the local folder holds 4,821 files, but the request did not state a direction. Mirroring the wrong way would delete real work, so no task was created and the question was returned to the user.",
 "Once you confirm a direction, a one-way robocopy /MIR task is appropriate. If both sides genuinely change independently, robocopy is the wrong tool - use a real sync utility or a versioned share, because /MIR in either direction will destroy the other side's edits.",
 (False,"good catch - I actually need two-way, will look at proper sync tools")),
# ---------------------------------------------------------------- 3 run script at time
("schedule.script.powershell","Task Scheduler",
 "Run my report script every weekday at 7am",
 {"script":"C:\\Scripts\\DailyReport.ps1","time":"07:00","days":"Mon-Fri"},
 [], None, "low", True,
 "Create scheduled task 'Chanakya-DailyReport'\n  Runs: Mon,Tue,Wed,Thu,Fri at 07:00\n  Action: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"C:\\Scripts\\DailyReport.ps1\"\n  Runs whether or not you are signed in.\n  -NonInteractive is included so the task cannot hang waiting for a prompt.",
 [("Test-Path 'C:\\Scripts\\DailyReport.ps1'",False,0,"True","",None),
  ("Get-ExecutionPolicy -List | Where-Object Scope -eq 'LocalMachine' | Select-Object ExecutionPolicy",False,0,"ExecutionPolicy\n---------------\n    RemoteSigned","",None),
  ("Get-AuthenticodeSignature 'C:\\Scripts\\DailyReport.ps1' | Select-Object Status",False,0,"Status\n------\nNotSigned","",None),
  ("<awaiting confirmation>",True,0,"","","Creating a scheduled task that runs an unsigned script with elevated rights"),
  ("$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"C:\\Scripts\\DailyReport.ps1\"'; $t=New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 07:00; Register-ScheduledTask -TaskName 'Chanakya-DailyReport' -Action $a -Trigger $t -RunLevel Highest",False,0,"TaskName             State\n--------             -----\nChanakya-DailyReport Ready","",None)],
 [("Get-ScheduledTask -TaskName 'Chanakya-DailyReport' | Select-Object State","State : Ready"),
  ("(Get-ScheduledTask -TaskName 'Chanakya-DailyReport').Triggers.DaysOfWeek","62  (Mon-Fri bitmask)")],
 "Unregister-ScheduledTask -TaskName 'Chanakya-DailyReport' -Confirm:$false",
 True,
 "The script exists but is unsigned while the machine policy is RemoteSigned, so the task needs -ExecutionPolicy Bypass to run it. That widens what the task can execute, which is why confirmation was requested before registering.",
 "Sign the script with a code-signing certificate and drop the Bypass flag - that keeps machine policy intact. Also add a transcript inside the script so failures under the task's non-interactive context are visible.",
 (True,"ran at 7am on the dot, log file appeared")),
# ---------------------------------------------------------------- 4 launch app
("schedule.app.launch","startup",
 "Open Outlook automatically when I log in each morning",
 {"application":"Outlook","trigger":"at logon"},
 [], None, "low", False,
 "Create scheduled task 'Chanakya-LaunchOutlook'\n  Trigger: at logon of the current user\n  Action: start Outlook\n  Runs in your interactive session, not elevated.\n  A logon trigger is used instead of a fixed time so it follows your actual sign-in.",
 [("Get-Command outlook -ErrorAction SilentlyContinue | Select-Object Source",False,1,"","(not on PATH)",None),
  ("Get-ChildItem 'C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE' | Select-Object FullName",False,0,"FullName\n--------\nC:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE","",None),
  ("$a=New-ScheduledTaskAction -Execute 'C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE'; $t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; Register-ScheduledTask -TaskName 'Chanakya-LaunchOutlook' -Action $a -Trigger $t",False,0,"TaskName                State\n--------                -----\nChanakya-LaunchOutlook  Ready","",None)],
 [("Get-ScheduledTask -TaskName 'Chanakya-LaunchOutlook' | Select-Object State","State : Ready"),
  ("(Get-ScheduledTask -TaskName 'Chanakya-LaunchOutlook').Triggers[0].CimClass.CimClassName","MSFT_TaskLogonTrigger")],
 "Unregister-ScheduledTask -TaskName 'Chanakya-LaunchOutlook' -Confirm:$false",
 True,
 "Outlook is not on PATH, so the executable was located under the Office install root before building the action. A logon trigger was chosen over a fixed morning time so the app opens when you actually sign in rather than at an arbitrary hour.",
 "The Startup folder would also work and is simpler to remove later. Use the scheduled task if you want a delay - add -Delay 00:01:00 to the trigger so Outlook opens after the desktop settles.",
 (True,"opens right after I sign in now")),
# ---------------------------------------------------------------- 5 cleanup Sunday
("schedule.cleanup","Task Scheduler",
 "Clean out my temp files every Sunday night",
 {"targets":["%TEMP%","C:\\Windows\\Temp"],"frequency":"weekly Sunday","time":"23:00"},
 [], None, "high", True,
 "PREVIEW ONLY - nothing will be deleted until you confirm.\n\nCreate scheduled task 'Chanakya-WeeklyTempCleanup'\n  Runs: Sundays at 23:00\n  Deletes: files older than 7 days in %TEMP% and C:\\Windows\\Temp\n  Skips: files currently in use (errors suppressed)\n\nDry run below shows exactly what WOULD be removed this week.",
 [("Get-ChildItem $env:TEMP -Recurse -File -ErrorAction SilentlyContinue | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7) | Measure-Object Length -Sum | Select-Object Count, @{N='MB';E={[int]($_.Sum/1MB)}}",False,0,"Count    MB\n-----  ----\n 3184  2417","",None),
  ("Get-ChildItem 'C:\\Windows\\Temp' -Recurse -File -ErrorAction SilentlyContinue | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7) | Measure-Object Length -Sum | Select-Object Count, @{N='MB';E={[int]($_.Sum/1MB)}}",False,0,"Count   MB\n-----  ---\n  912  884","",None),
  ("<awaiting confirmation: 4,096 files / 3.2 GB would be deleted weekly>",True,0,"","","Recurring deletion task - user must approve the scope and the 7-day age threshold"),
  ("$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -Command \"Get-ChildItem $env:TEMP,C:\\Windows\\Temp -Recurse -File -ErrorAction SilentlyContinue | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7) | Remove-Item -Force -ErrorAction SilentlyContinue\"'; $t=New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 23:00; Register-ScheduledTask -TaskName 'Chanakya-WeeklyTempCleanup' -Action $a -Trigger $t -RunLevel Highest",False,0,"TaskName                     State\n--------                     -----\nChanakya-WeeklyTempCleanup   Ready","",None)],
 [("Get-ScheduledTask -TaskName 'Chanakya-WeeklyTempCleanup' | Select-Object State","State : Ready")],
 "Unregister-ScheduledTask -TaskName 'Chanakya-WeeklyTempCleanup' -Confirm:$false  (already-deleted files are not recoverable)",
 True,
 "A dry run was performed first, showing 4,096 files totalling 3.2 GB currently match the deletion criteria. Only after that concrete number was presented and confirmed was the recurring task created.",
 "The 7-day age threshold protects files a running installer may still need. Never point this at broader paths like Downloads or a user profile root - temp directories are safe because their contents are disposable by definition.",
 (True,"seeing the 3.2 GB number first made me comfortable approving it")),
# ---------------------------------------------------------------- 6 service schedule
("schedule.service.control","services",
 "Stop the SQL service at 8pm and start it again at 6am",
 {"service":"MSSQLSERVER","stopAt":"20:00","startAt":"06:00"},
 [], None, "high", True,
 "Create TWO scheduled tasks:\n  1. 'Chanakya-StopSQL'  - daily 20:00 - Stop-Service MSSQLSERVER\n  2. 'Chanakya-StartSQL' - daily 06:00 - Start-Service MSSQLSERVER\nBoth run as SYSTEM with highest privileges.\n\nWARNING: stopping SQL Server disconnects every active session immediately. Any application depending on this instance will fail between 20:00 and 06:00.",
 [("Get-Service MSSQLSERVER | Select-Object Name, Status, StartType",False,0,"Name        Status  StartType\n----        ------  ---------\nMSSQLSERVER Running Automatic","",None),
  ("Get-Service | Where-Object { $_.ServicesDependedOn.Name -contains 'MSSQLSERVER' } | Select-Object Name, Status",False,0,"Name        Status\n----        ------\nSQLSERVERAGENT Running","",None),
  ("<awaiting confirmation: dependent service SQLSERVERAGENT will also stop>",True,0,"","","Stopping a database engine on a schedule affects dependent services and any connected application"),
  ("$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -Command \"Stop-Service MSSQLSERVER -Force\"'; $t=New-ScheduledTaskTrigger -Daily -At 20:00; Register-ScheduledTask -TaskName 'Chanakya-StopSQL' -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest",False,0,"TaskName          State\n--------          -----\nChanakya-StopSQL  Ready","",None),
  ("$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -Command \"Start-Service MSSQLSERVER\"'; $t=New-ScheduledTaskTrigger -Daily -At 06:00; Register-ScheduledTask -TaskName 'Chanakya-StartSQL' -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest",False,0,"TaskName           State\n--------           -----\nChanakya-StartSQL  Ready","",None)],
 [("Get-ScheduledTask -TaskName 'Chanakya-St*SQL' | Select-Object TaskName, State","Chanakya-StartSQL Ready\nChanakya-StopSQL  Ready"),
  ("Get-Service MSSQLSERVER | Select-Object Status","Status : Running")],
 "Unregister-ScheduledTask -TaskName 'Chanakya-StopSQL','Chanakya-StartSQL' -Confirm:$false",
 True,
 "The dependency check found SQLSERVERAGENT depends on this instance and will stop with it - a consequence the request did not mention. That was surfaced before creating anything, then both tasks were registered as SYSTEM so they work without a signed-in user.",
 "Confirm no backup or maintenance job is scheduled inside the 20:00-06:00 window, since those will now fail. Consider setting SQLSERVERAGENT to start with the engine so the 06:00 task brings the whole stack back rather than just the database engine.",
 (True,"both tasks created, agent service came back with it")),
# ---------------------------------------------------------------- 7 create generic
("task.create","Task Scheduler",
 "Make a task that runs my disk check script on the first of every month",
 {"script":"C:\\Scripts\\DiskCheck.ps1","frequency":"monthly","dayOfMonth":1,"time":"03:00"},
 [], None, "low", True,
 "Create scheduled task 'Chanakya-MonthlyDiskCheck'\n  Trigger: monthly, day 1, at 03:00\n  Action: powershell.exe -NoProfile -NonInteractive -File \"C:\\Scripts\\DiskCheck.ps1\"\n  Wake the computer to run: no (it will run at next boot if the machine is off)",
 [("Test-Path 'C:\\Scripts\\DiskCheck.ps1'",False,0,"True","",None),
  ("<awaiting confirmation>",True,0,"","","Registering a new recurring scheduled task"),
  ("$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -File \"C:\\Scripts\\DiskCheck.ps1\"'; $t=New-ScheduledTaskTrigger -Once -At '2026-09-01T03:00:00' -RepetitionInterval (New-TimeSpan -Days 30); $s=New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2); Register-ScheduledTask -TaskName 'Chanakya-MonthlyDiskCheck' -Action $a -Trigger $t -Settings $s -RunLevel Highest",False,0,"TaskName                   State\n--------                   -----\nChanakya-MonthlyDiskCheck  Ready","",None)],
 [("Get-ScheduledTask -TaskName 'Chanakya-MonthlyDiskCheck' | Select-Object State","State : Ready"),
  ("Get-ScheduledTaskInfo -TaskName 'Chanakya-MonthlyDiskCheck' | Select-Object NextRunTime","NextRunTime : 9/1/2026 3:00:00 AM")],
 "Unregister-ScheduledTask -TaskName 'Chanakya-MonthlyDiskCheck' -Confirm:$false",
 True,
 "PowerShell's trigger cmdlets have no native monthly option, so a repeating 30-day trigger was used with -StartWhenAvailable so a missed run (machine off at 03:00) executes at the next opportunity. An execution time limit was set so a hung script cannot block future runs.",
 "For a strict calendar-monthly schedule, export the task XML and set a CalendarTrigger with ScheduleByMonth - the 30-day repetition drifts slowly relative to month boundaries.",
 (True,"next run shows 1 Sept as expected")),
# ---------------------------------------------------------------- 8 delete task
("task.delete","Task Scheduler",
 "Delete that backup task I set up last week",
 {"taskName":"Chanakya-BackupDocuments"},
 [], None, "medium", True,
 "About to DELETE scheduled task 'Chanakya-BackupDocuments'.\n  Currently: Ready, last ran 8/10 22:00 (result 0 - success)\n  Action it performs: robocopy C:\\Users\\jdoe\\Documents -> D:\\Backups\\Documents /MIR\n  After deletion no further backups will run. Existing backup files are NOT touched.\n\nConfirm deletion?",
 [("Get-ScheduledTask -TaskName 'Chanakya-BackupDocuments' | Select-Object TaskName, State",False,0,"TaskName                 State\n--------                 -----\nChanakya-BackupDocuments Ready","",None),
  ("Get-ScheduledTaskInfo -TaskName 'Chanakya-BackupDocuments' | Select-Object LastRunTime, LastTaskResult",False,0,"LastRunTime          LastTaskResult\n-----------          --------------\n8/10/2026 10:00:02 PM              0","",None),
  ("(Get-ScheduledTask -TaskName 'Chanakya-BackupDocuments').Actions | Select-Object Execute, Arguments",False,0,"Execute      : robocopy.exe\nArguments    : \"C:\\Users\\jdoe\\Documents\" \"D:\\Backups\\Documents\" /MIR ...","",None),
  ("<awaiting confirmation of deletion>",True,0,"","","Deleting a working backup schedule - user should see what it does before it is removed"),
  ("Unregister-ScheduledTask -TaskName 'Chanakya-BackupDocuments' -Confirm:$false",False,0,"","",None)],
 [("Get-ScheduledTask -TaskName 'Chanakya-BackupDocuments' -ErrorAction SilentlyContinue","(no output - task removed)")],
 "Re-create with the original definition (captured above) if this was a mistake.",
 True,
 "The task was inspected before removal so its purpose and last result could be shown, and the exact command it ran was captured first. It had been succeeding, which is worth surfacing before deleting a working backup.",
 "Backups already written to D:\\Backups remain in place. If you only wanted to pause it, Disable-ScheduledTask would have been reversible - deletion is not.",
 (True,"confirmed, I moved to a different backup tool")),
("task.delete","Task Scheduler",
 "Remove all the scheduled tasks on this machine, it's cluttered",
 {"scope":"all"},
 ["confirmedScope"],
 "I will not delete all scheduled tasks - most belong to Windows itself and removing them breaks updates, maintenance and defragmentation. I can show only the non-Microsoft tasks and you can pick which to remove. Shall I list those?",
 "high", True,
 "REFUSED as stated. Proposed instead:\n  1. List tasks NOT under \\Microsoft\\ (user and third-party only)\n  2. You select which to remove\n  3. Each removal confirmed individually",
 [("Get-ScheduledTask | Measure-Object | Select-Object Count",False,0,"Count\n-----\n  283","",None),
  ("Get-ScheduledTask | Where-Object TaskPath -notlike '\\Microsoft\\*' | Select-Object TaskName, TaskPath, State",False,0,"TaskName              TaskPath State\n--------              -------- -----\nChanakya-DailyReport  \\        Ready\nVendorUpdater         \\        Ready\nGoogleUpdateTaskUser  \\        Ready","",None),
  ("<blocked: refusing bulk deletion of system tasks>",True,0,"","","283 tasks exist, most are Windows components; bulk deletion would break OS maintenance")],
 [], None, False,
 "The request as phrased would delete 283 tasks, the large majority of which are Windows components responsible for updates, defrag, telemetry cleanup and system maintenance. The scope was narrowed to the 3 non-Microsoft tasks and returned for selection instead of executing.",
 "Only tasks outside \\Microsoft\\ are safe to review for removal, and even those may belong to installed software that will recreate them. Disable rather than delete when unsure.",
 (False,"did not realise most were Windows' own - just removed the vendor updater")),
# ---------------------------------------------------------------- 9 startup apps
("startup.manage","startup",
 "Stop Spotify and Teams from starting up with Windows",
 {"applications":["Spotify","Teams"]},
 [], None, "low", True,
 "Disable at startup:\n  - Spotify   (found in: HKCU Run key)\n  - Teams     (found in: HKCU Run key)\nMethod: set the Approved value so they appear as Disabled in Task Manager, rather than deleting the entries.\nThis is reversible and the apps themselves are not touched.",
 [("Get-CimInstance Win32_StartupCommand | Select-Object Name, Location, Command",False,0,"Name    Location                                                Command\n----    --------                                                -------\nSpotify HKU\\...\\Run                                             C:\\Users\\jdoe\\AppData\\Roaming\\Spotify\\Spotify.exe\nTeams   HKU\\...\\Run                                             C:\\Users\\jdoe\\AppData\\Local\\Microsoft\\Teams\\Update.exe","",None),
  ("Get-ScheduledTask | Where-Object { $_.TaskName -match 'Spotify|Teams' } | Select-Object TaskName, State",False,1,"","(no startup tasks found for these apps)",None),
  ("<awaiting confirmation>",True,0,"","","Modifying startup behaviour for two applications"),
  ("Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' -Name 'Spotify' -Value ([byte[]](3,0,0,0,0,0,0,0,0,0,0,0))",False,0,"","",None),
  ("Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' -Name 'Teams' -Value ([byte[]](3,0,0,0,0,0,0,0,0,0,0,0))",False,0,"","",None)],
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' | Select-Object Spotify, Teams","Spotify : {3, 0, 0, 0...}\nTeams   : {3, 0, 0, 0...}")],
 "Set the same values back to 02 00 00 00... to re-enable, or toggle them in Task Manager > Startup.",
 True,
 "Both apps start from the HKCU Run key rather than a scheduled task or the Startup folder, so the Approved value was set instead of deleting the Run entries. That matches what Task Manager's Disable button does and is fully reversible.",
 "Startup entries can also live in the Startup folder, HKLM Run keys and scheduled tasks - all four were checked here. Teams may recreate its entry after an update, so re-check if it reappears.",
 (True,"both show as Disabled in Task Manager now")),
# ---------------------------------------------------------------- 10 reminder
("schedule.reminder","Task Scheduler",
 "Remind me to submit my timesheet every Friday at 4pm",
 {"message":"Submit your timesheet","day":"Friday","time":"16:00"},
 [], None, "low", False,
 "Create scheduled task 'Chanakya-TimesheetReminder'\n  Runs: Fridays at 16:00 in your session\n  Action: display a desktop notification with the text 'Submit your timesheet'\n  No system state is changed.",
 [("Get-Module -ListAvailable BurntToast | Measure-Object | Select-Object Count",False,0,"Count\n-----\n    0","",None),
  ("$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command \"Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(20000,''Reminder'',''Submit your timesheet'',''Info''); Start-Sleep 25\"'; $t=New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At 16:00; Register-ScheduledTask -TaskName 'Chanakya-TimesheetReminder' -Action $a -Trigger $t",False,0,"TaskName                    State\n--------                    -----\nChanakya-TimesheetReminder  Ready","",None)],
 [("Get-ScheduledTask -TaskName 'Chanakya-TimesheetReminder' | Select-Object State","State : Ready"),
  ("Start-ScheduledTask -TaskName 'Chanakya-TimesheetReminder'","(notification appeared - test run)")],
 "Unregister-ScheduledTask -TaskName 'Chanakya-TimesheetReminder' -Confirm:$false",
 True,
 "No notification module was installed, so a native balloon tip was used rather than adding a dependency. This task only displays a message and changes nothing, so it was created without a confirmation gate and test-fired immediately to prove it works.",
 "The task must run in your interactive session to be visible - it will not show if you are signed out. For richer notifications install the BurntToast module and swap the action.",
 (True,"got the popup on the test run")),
# ---------------------------------------------------------------- 11 periodic diagnostic
("schedule.diagnostic","Task Scheduler",
 "Run a health check every 4 hours and save the results somewhere I can look at",
 {"frequency":"every 4 hours","output":"C:\\HealthLogs"},
 [], None, "low", True,
 "Create scheduled task 'Chanakya-HealthCheck'\n  Runs: every 4 hours, starting now\n  Collects: disk free space, top 5 processes by memory, failed services, last 10 system errors\n  Writes: C:\\HealthLogs\\health-yyyyMMdd-HHmm.txt\n  Read-only checks - nothing on the system is modified.",
 [("Test-Path 'C:\\HealthLogs'",False,1,"False","",None),
  ("New-Item -ItemType Directory -Path 'C:\\HealthLogs' -Force | Out-Null",False,0,"","",None),
  ("<awaiting confirmation>",True,0,"","","Creating a recurring task and a new folder for its output"),
  ("$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -Command \"$f=\\\"C:\\HealthLogs\\health-$(Get-Date -f yyyyMMdd-HHmm).txt\\\"; Get-Volume | Out-File $f; Get-Process | Sort WorkingSet64 -Desc | Select -First 5 | Out-File $f -Append; Get-Service | Where Status -eq Stopped | Where StartType -eq Automatic | Out-File $f -Append\"'; $t=New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 4); Register-ScheduledTask -TaskName 'Chanakya-HealthCheck' -Action $a -Trigger $t -RunLevel Highest",False,0,"TaskName             State\n--------             -----\nChanakya-HealthCheck Ready","",None)],
 [("Start-ScheduledTask -TaskName 'Chanakya-HealthCheck'; Start-Sleep 8; Get-ChildItem 'C:\\HealthLogs' | Select-Object Name, Length","Name                      Length\n----                      ------\nhealth-20260811-1930.txt    2841")],
 "Unregister-ScheduledTask -TaskName 'Chanakya-HealthCheck' -Confirm:$false; Remove-Item C:\\HealthLogs -Recurse",
 True,
 "The output folder did not exist and was created first, then the task was registered with a 4-hour repetition. It was test-fired immediately and produced a 2.8 KB report, proving the whole chain works rather than assuming it does.",
 "Add a retention step so the folder does not grow indefinitely - deleting reports older than 30 days inside the same script is the simplest approach. All checks here are read-only, so this task is safe to leave running.",
 (True,"first report generated straight away")),
# ---------------------------------------------------------------- 12 event log collection
("schedule.eventlog.collect","Event Viewer",
 "Automatically save the system error logs each day so I have a history",
 {"logs":["System"],"level":"Error","frequency":"daily","output":"C:\\EventArchive"},
 [], None, "low", True,
 "Create scheduled task 'Chanakya-EventArchive'\n  Runs: daily at 23:30\n  Exports: System log entries at Error/Critical level from the last 24 hours\n  Writes: C:\\EventArchive\\system-yyyyMMdd.csv\n  Reads the log only - it is NOT cleared.",
 [("Get-WinEvent -ListLog System | Select-Object LogName, RecordCount, MaximumSizeInBytes",False,0,"LogName RecordCount MaximumSizeInBytes\n------- ----------- ------------------\nSystem        18422           20971520","",None),
  ("New-Item -ItemType Directory -Path 'C:\\EventArchive' -Force | Out-Null",False,0,"","",None),
  ("<awaiting confirmation>",True,0,"","","Creating a recurring export task"),
  ("$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -Command \"Get-WinEvent -FilterHashtable @{LogName=''System''; Level=1,2; StartTime=(Get-Date).AddDays(-1)} -ErrorAction SilentlyContinue | Select TimeCreated,Id,ProviderName,Message | Export-Csv \\\"C:\\EventArchive\\system-$(Get-Date -f yyyyMMdd).csv\\\" -NoTypeInformation\"'; $t=New-ScheduledTaskTrigger -Daily -At 23:30; Register-ScheduledTask -TaskName 'Chanakya-EventArchive' -Action $a -Trigger $t -RunLevel Highest",False,0,"TaskName               State\n--------               -----\nChanakya-EventArchive  Ready","",None)],
 [("Start-ScheduledTask -TaskName 'Chanakya-EventArchive'; Start-Sleep 10; Get-ChildItem C:\\EventArchive | Select-Object Name, Length","system-20260811.csv   14206")],
 "Unregister-ScheduledTask -TaskName 'Chanakya-EventArchive' -Confirm:$false",
 True,
 "The System log holds 18,422 records with a 20 MB cap, meaning older entries are already being overwritten - which is exactly why a daily export preserves history. The task exports only Error and Critical levels so the files stay small.",
 "The log rolls at 20 MB, so raise MaximumSizeInBytes if you need more in-place history as well. Never add wevtutil cl to this task - clearing logs destroys the evidence you are trying to keep.",
 (True,"first CSV exported with yesterday's errors")),
# ---------------------------------------------------------------- 13 disk monitor
("monitor.diskspace","Task Scheduler",
 "Warn me when C drive drops below 10% free",
 {"drive":"C","threshold":"10%","action":"notify"},
 [], None, "low", True,
 "Create scheduled task 'Chanakya-DiskSpaceMonitor'\n  Runs: every 30 minutes\n  Checks: free space on C:\n  If below 10%: shows a desktop notification\n  Takes no corrective action on its own - notification only.",
 [("Get-Volume -DriveLetter C | Select-Object Size, SizeRemaining, @{N='PctFree';E={[math]::Round($_.SizeRemaining/$_.Size*100,1)}}",False,0,"          Size  SizeRemaining PctFree\n          ----  ------------- -------\n  511101108224    92341829632    18.1","",None),
  ("<awaiting confirmation>",True,0,"","","Creating a recurring monitoring task"),
  ("$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command \"$v=Get-Volume -DriveLetter C; if(($v.SizeRemaining/$v.Size) -lt 0.10){Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Warning; $n.Visible=$true; $n.ShowBalloonTip(30000,''Low disk space'',\\\"C: has $([math]::Round($v.SizeRemaining/1GB,1)) GB free\\\",''Warning''); Start-Sleep 35}\"'; $t=New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30); Register-ScheduledTask -TaskName 'Chanakya-DiskSpaceMonitor' -Action $a -Trigger $t",False,0,"TaskName                  State\n--------                  -----\nChanakya-DiskSpaceMonitor Ready","",None)],
 [("Get-ScheduledTaskInfo -TaskName 'Chanakya-DiskSpaceMonitor' | Select-Object LastTaskResult, NextRunTime","LastTaskResult : 0\nNextRunTime    : 8/11/2026 8:00:00 PM")],
 "Unregister-ScheduledTask -TaskName 'Chanakya-DiskSpaceMonitor' -Confirm:$false",
 True,
 "C: is currently at 18.1% free, above the requested threshold, so the monitor was built to notify rather than act. The task deliberately performs no cleanup - automatic deletion triggered by a threshold is how backups and user data get destroyed unattended.",
 "If you later want it to act, have it run a dry-run cleanup and report what it WOULD remove rather than deleting directly. A notification-only monitor is safe to leave running indefinitely.",
 (True,"tested by filling the drive, notification fired")),
# ---------------------------------------------------------------- 14 folder monitor
("monitor.folder","Task Scheduler",
 "When a PDF lands in my Scans folder, move it into the archive automatically",
 {"watchFolder":"C:\\Scans","filter":"*.pdf","action":"move","destination":"D:\\Archive\\Scans"},
 [], None, "medium", True,
 "Create scheduled task 'Chanakya-ScanWatcher'\n  Trigger: every 5 minutes (polling)\n  Action: move *.pdf from C:\\Scans to D:\\Archive\\Scans\n  Skips files modified in the last 60 seconds so partially-written scans are not moved mid-write.\n\nNote: Windows has no reliable built-in 'run on file creation' trigger for a folder, so polling is used. A true FileSystemWatcher would need a service to stay resident.",
 [("Test-Path 'C:\\Scans'",False,0,"True","",None),
  ("Test-Path 'D:\\Archive\\Scans'",False,1,"False","",None),
  ("New-Item -ItemType Directory -Path 'D:\\Archive\\Scans' -Force | Out-Null",False,0,"","",None),
  ("Get-ChildItem 'C:\\Scans' -Filter '*.pdf' | Measure-Object | Select-Object Count",False,0,"Count\n-----\n    7","",None),
  ("<awaiting confirmation: 7 existing PDFs will move on the first run>",True,0,"","","Files will be moved, not copied - user should confirm the destination and the 7 existing files"),
  ("$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -Command \"Get-ChildItem C:\\Scans -Filter *.pdf | Where-Object LastWriteTime -lt (Get-Date).AddSeconds(-60) | Move-Item -Destination D:\\Archive\\Scans -Force\"'; $t=New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5); Register-ScheduledTask -TaskName 'Chanakya-ScanWatcher' -Action $a -Trigger $t -RunLevel Highest",False,0,"TaskName             State\n--------             -----\nChanakya-ScanWatcher Ready","",None)],
 [("Start-ScheduledTask -TaskName 'Chanakya-ScanWatcher'; Start-Sleep 10; Get-ChildItem 'D:\\Archive\\Scans' -Filter '*.pdf' | Measure-Object | Select-Object Count","Count : 7"),
  ("Get-ChildItem 'C:\\Scans' -Filter '*.pdf' | Measure-Object | Select-Object Count","Count : 0")],
 "Move the files back from D:\\Archive\\Scans to C:\\Scans and unregister the task.",
 True,
 "The destination did not exist and was created first. Seven PDFs were already waiting, so the user was told they would move on the first run rather than discovering it afterwards. The 60-second age filter prevents grabbing a scan while the scanner is still writing it.",
 "Polling every 5 minutes is the reliable approach for a scheduled task. If you need instant reaction, a small resident service using FileSystemWatcher is the correct architecture - a scheduled task cannot subscribe to file-system events directly.",
 (True,"all 7 moved, new scans get archived within 5 minutes")),
# ---------------------------------------------------------------- 15 shutdown
("schedule.shutdown","power management",
 "Shut the PC down automatically at midnight every day",
 {"action":"shutdown","time":"00:00","frequency":"daily"},
 [], None, "high", True,
 "Create scheduled task 'Chanakya-NightlyShutdown'\n  Runs: daily at 00:00 as SYSTEM\n  Action: shutdown.exe /s /t 300 /c \"Automatic shutdown in 5 minutes - save your work\"\n\nA 5-minute warning is included rather than an immediate shutdown, so unsaved work can be rescued. Forced shutdown (/f) is NOT used - applications get the chance to prompt.",
 [("Get-CimInstance Win32_OperatingSystem | Select-Object LastBootUpTime",False,0,"LastBootUpTime\n--------------\n8/11/2026 8:14:02 AM","",None),
  ("Get-ScheduledTask | Where-Object { $_.Actions.Execute -match 'shutdown' } | Select-Object TaskName",False,1,"","(no existing shutdown task)",None),
  ("<awaiting confirmation: daily forced power-off>",True,0,"","","A recurring shutdown can interrupt long-running jobs and cause data loss if work is left open"),
  ("$a=New-ScheduledTaskAction -Execute 'shutdown.exe' -Argument '/s /t 300 /c \"Automatic shutdown in 5 minutes - save your work\"'; $t=New-ScheduledTaskTrigger -Daily -At 00:00; Register-ScheduledTask -TaskName 'Chanakya-NightlyShutdown' -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest",False,0,"TaskName                  State\n--------                  -----\nChanakya-NightlyShutdown  Ready","",None)],
 [("Get-ScheduledTask -TaskName 'Chanakya-NightlyShutdown' | Select-Object State","State : Ready"),
  ("(Get-ScheduledTask -TaskName 'Chanakya-NightlyShutdown').Actions.Arguments","/s /t 300 /c \"Automatic shutdown in 5 minutes - save your work\"")],
 "Unregister-ScheduledTask -TaskName 'Chanakya-NightlyShutdown' -Confirm:$false  |  cancel a shutdown in progress with: shutdown /a",
 True,
 "No existing shutdown task was present. A 300-second warning was built into the action instead of an instant power-off, and /f was deliberately omitted so applications can still prompt to save. This is the difference between an automation that is safe to run unattended and one that destroys work.",
 "Note shutdown /a cancels a countdown already in progress if you are still working. If the machine must stay on for backups, schedule those before midnight or use Sleep instead of shutdown.",
 (True,"the 5 minute warning saved me twice already")),
# ---------------------------------------------------------------- 16 windows maintenance
("schedule.maintenance","system configuration",
 "Make Windows do its automatic maintenance at 2am instead of during my workday",
 {"time":"02:00","wakeToRun":True},
 [], None, "low", True,
 "Reconfigure Windows Automatic Maintenance\n  New start time: 02:00\n  Wake the computer to run: enabled\n  This changes when built-in maintenance (defrag, update scan, diagnostics) runs. It does not disable it.",
 [("Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\TaskScheduler\\' -TaskName 'Regular Maintenance' | Select-Object TaskName, State",False,0,"TaskName            State\n--------            -----\nRegular Maintenance Ready","",None),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\Maintenance' -ErrorAction SilentlyContinue | Select-Object Activation*, WakeUp",False,0,"(no custom values - defaults in use, maintenance runs at 03:00 without wake)","",None),
  ("<awaiting confirmation>",True,0,"","","Modifying machine-wide maintenance policy"),
  ("New-Item 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\Maintenance' -Force | Out-Null",False,0,"","",None),
  ("Set-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\Maintenance' -Name 'ActivationBoundary' -Value '2000-01-01T02:00:00' -Type String",False,0,"","",None),
  ("Set-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\Maintenance' -Name 'WakeUp' -Value 1 -Type DWord",False,0,"","",None)],
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\Maintenance' | Select-Object ActivationBoundary, WakeUp","ActivationBoundary : 2000-01-01T02:00:00\nWakeUp             : 1")],
 "Remove-Item 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\Maintenance' -Recurse  (restores Windows defaults)",
 True,
 "Maintenance was running on the default 03:00 schedule with no wake permission, so on a machine that sleeps it was effectively never completing during off hours. The activation boundary was moved to 02:00 and wake enabled so it can actually run.",
 "Wake-to-run only works if the machine sleeps rather than shuts down, and if wake timers are permitted in the active power plan. Verify after a few days that Task Scheduler shows maintenance completing rather than being repeatedly deferred.",
 (True,"maintenance now completes overnight instead of interrupting me")),
# ---------------------------------------------------------------- edge cases
("task.create","Task Scheduler",
 "Create the report task again - I think I already made one last month",
 {"taskName":"Chanakya-DailyReport"},
 [], None, "medium", True,
 "A task with this name ALREADY EXISTS.\n  Current: daily 07:00, runs C:\\Scripts\\DailyReport.ps1, last result 0 (success)\n\nOptions:\n  A) Leave it as is (recommended - it is working)\n  B) Update its schedule or action\n  C) Delete and recreate\n\nI have not changed anything. Which would you like?",
 [("Get-ScheduledTask -TaskName 'Chanakya-DailyReport' -ErrorAction SilentlyContinue | Select-Object TaskName, State",False,0,"TaskName             State\n--------             -----\nChanakya-DailyReport Ready","",None),
  ("Get-ScheduledTaskInfo -TaskName 'Chanakya-DailyReport' | Select-Object LastRunTime, LastTaskResult, NextRunTime",False,0,"LastRunTime          LastTaskResult NextRunTime\n-----------          -------------- -----------\n8/11/2026 7:00:01 AM              0 8/12/2026 7:00:00 AM","",None),
  ("<blocked: task already exists and is healthy>",True,0,"","","Registering over an existing task would silently replace a working schedule")],
 [], None, True,
 "The task already exists and its last run succeeded. Registering again would have silently overwritten a working schedule, so existence was checked first and the choice returned to the user rather than assuming intent.",
 "Always check for an existing task before registering. If you do want to change it, Set-ScheduledTask modifies in place and preserves run history, whereas unregister-and-recreate loses it.",
 (True,"forgot I had it - left it alone")),
("schedule.script.powershell","Task Scheduler",
 "Schedule this script to run as admin every hour",
 {"script":"C:\\Scripts\\Collect.ps1","frequency":"hourly","runLevel":"Highest"},
 [], None, "medium", True,
 "Cannot proceed: this session is not elevated.\n\nRegistering a task with -RunLevel Highest requires administrator rights. The plan is ready and will be executed once you re-run from an elevated PowerShell session.\n\nPlanned: hourly, powershell.exe -NoProfile -NonInteractive -File \"C:\\Scripts\\Collect.ps1\", RunLevel Highest",
 [("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",False,0,"False","",None),
  ("Test-Path 'C:\\Scripts\\Collect.ps1'",False,0,"True","",None),
  ("Register-ScheduledTask -TaskName 'Chanakya-Collect' -Action $a -Trigger $t -RunLevel Highest",False,1,"","Register-ScheduledTask : Access is denied.",None),
  ("<blocked: elevation required>",True,0,"","","Task registration with Highest run level needs an elevated session")],
 [], None, False,
 "Elevation was checked before attempting registration, and the attempt confirmed Access is denied. Rather than silently downgrading to a non-elevated task - which would run but fail whenever the script needs admin rights - the requirement was surfaced.",
 "Re-run from an elevated PowerShell session. Do not work around this by dropping RunLevel Highest: the task would register successfully and then fail at runtime, which is harder to diagnose than an upfront refusal.",
 (False,"re-ran as admin and it created fine")),
("schedule.cleanup","Task Scheduler",
 "Set up a task to delete everything in my Downloads folder every week",
 {"target":"C:\\Users\\jdoe\\Downloads","frequency":"weekly"},
 ["ageThreshold","confirmedScope"],
 "Downloads usually contains files people still need, and this would delete them permanently on a schedule with no warning. Before I build anything: should it delete everything, or only files older than a set number of days? And should items go to the Recycle Bin so they are recoverable?",
 "high", True,
 "NOT CREATED. A dry run shows what the request would remove:\n  1,284 files, 41.7 GB\n  Includes 62 files modified in the last 7 days\n  Oldest file: 2023-04-11\n\nProposed safer version:\n  - only files older than 30 days\n  - moved to Recycle Bin rather than deleted permanently\n  - would affect 1,102 files instead of 1,284",
 [("Get-ChildItem 'C:\\Users\\jdoe\\Downloads' -Recurse -File | Measure-Object Length -Sum | Select-Object Count, @{N='GB';E={[math]::Round($_.Sum/1GB,1)}}",False,0,"Count   GB\n-----   --\n 1284 41.7","",None),
  ("Get-ChildItem 'C:\\Users\\jdoe\\Downloads' -Recurse -File | Where-Object LastWriteTime -gt (Get-Date).AddDays(-7) | Measure-Object | Select-Object Count",False,0,"Count\n-----\n   62","",None),
  ("<blocked: refusing unconditional recurring deletion of user data>",True,0,"","","Deleting all of Downloads weekly would remove 62 files touched in the last week, permanently and unattended")],
 [], None, False,
 "A dry run quantified the request: 1,284 files totalling 41.7 GB, including 62 modified within the last week. Downloads is user data rather than a disposable cache, so no task was created and a safer bounded alternative was proposed instead.",
 "If you accept the safer version, the age threshold and Recycle Bin routing make it recoverable. An unconditional weekly wipe of a user folder is the kind of automation that causes real data loss - I would not build it without an explicit acknowledgement of that.",
 (False,"went with the 30-day version instead - did not realise how much was in there")),
("schedule.backup.folder","Task Scheduler",
 "Check whether my backup task actually ran last night",
 {"taskName":"Chanakya-BackupDocuments"},
 [], None, "low", False,
 "Read-only check - no changes will be made.\n  Reading task run history, last result, and the backup log.",
 [("Get-ScheduledTaskInfo -TaskName 'Chanakya-BackupDocuments' | Select-Object LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns",False,0,"LastRunTime          LastTaskResult NextRunTime          NumberOfMissedRuns\n-----------          -------------- -----------          ------------------\n8/10/2026 10:00:02 PM              0 8/11/2026 10:00:00 PM                 0","",None),
  ("Get-Content 'D:\\Backups\\backup.log' -Tail 6",False,0,"   Files :      2841      2841         0         0         0         0\n   Bytes :  4.812 g   4.812 g         0         0         0         0\n   Ended : Monday, 10 August 2026 22:04:18","",None),
  ("Get-ChildItem 'D:\\Backups\\Documents' -Recurse -File | Measure-Object | Select-Object Count",False,0,"Count\n-----\n 2841","",None)],
 [("(Get-ChildItem 'D:\\Backups\\Documents' -Recurse -File | Measure-Object).Count -eq 2841","True")],
 None,
 True,
 "The task ran at 22:00 with result 0 and no missed runs. The robocopy log shows 2,841 files and 4.8 GB copied with zero failures, and the destination contains exactly 2,841 files - the log and the file system agree, so the backup genuinely completed.",
 "Checking the destination file count against the log is worth doing periodically - a task can report success while robocopy silently skips files it cannot read. Result 0 alone is not proof that data arrived.",
 (True,"good to have it confirmed against the actual folder")),
("startup.manage","startup",
 "Something is starting with Windows and I don't know what - can you show me everything?",
 {"scope":"all startup locations"},
 [], None, "low", False,
 "Read-only enumeration of all four startup mechanisms:\n  1. Run keys (HKCU + HKLM)\n  2. Startup folders (user + all users)\n  3. Scheduled tasks with logon triggers\n  4. Services set to Automatic\nNothing will be changed.",
 [("Get-CimInstance Win32_StartupCommand | Select-Object Name, Location | Format-Table -AutoSize",False,0,"Name          Location\n----          --------\nSpotify       HKU\\...\\Run\nVendorUpdater HKLM\\...\\Run\nOneDrive      HKU\\...\\Run","",None),
  ("Get-ChildItem \"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\",\"$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\" -ErrorAction SilentlyContinue | Select-Object Name",False,0,"Name\n----\nScannerAgent.lnk","",None),
  ("Get-ScheduledTask | Where-Object { $_.Triggers.CimClass.CimClassName -contains 'MSFT_TaskLogonTrigger' -and $_.TaskPath -notlike '\\Microsoft\\*' } | Select-Object TaskName, State",False,0,"TaskName              State\n--------              -----\nGoogleUpdateTaskUser  Ready\nChanakya-LaunchOutlook Ready","",None)],
 [], None, True,
 "Six startup entries were found across three different mechanisms: three Run-key entries, one Startup-folder shortcut, and two logon-triggered scheduled tasks. Task Manager's Startup tab only shows the first two categories, which is why the scheduled tasks were invisible to the user.",
 "ScannerAgent and GoogleUpdateTaskUser are the likely candidates if you want to reduce logon time. Tell me which to disable and I will do it reversibly - I have not changed anything yet.",
 (True,"the scheduled task ones were the ones I could never find")),
]

sess, lines = [], []
base = datetime(2026, 8, 12, 9, 0, 0)
for i, (intent, sub, goal, params, missing, clar, risk, confirm, plan, steps, verif, rollback,
        resolved, summary, rec, fb) in enumerate(R):
    created = base + timedelta(minutes=11*i)
    st = [{"command": c, "blocked": b, "exitCode": e, "stdout": o, "stderr": er, "reason": rs}
          for c, b, e, o, er, rs in steps]
    sess.append({
        "id": str(uuid.uuid4()),
        "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "type": "automation",
        "goal": goal,
        "intent": intent,
        "domain": "automation",
        "subdomain": sub,
        "parameters": params,
        "missingParameters": missing,
        "clarification": clar,
        "riskLevel": risk,
        "requiresConfirmation": confirm,
        "plannedAction": plan,
        "steps": st,
        "verification": [{"command": c, "expected": e} for c, e in verif],
        "rollback": rollback,
        "resolved": resolved,
        "summary": summary,
        "recommendation": rec,
        "feedback": {"worked": fb[0], "note": fb[1],
                     "at": (created+timedelta(minutes=6)).strftime("%Y-%m-%dT%H:%M:%S.000Z")},
    })
    # assistant turn mirrors the agent's real behaviour: plan -> gate -> execute -> verify
    parts = [f"INTENT: {intent}",
             "PARAMETERS: " + json.dumps(params, ensure_ascii=False)]
    if missing:
        parts.append("MISSING: " + ", ".join(missing))
        parts.append("I need to ask before proceeding:\n" + clar)
    parts.append(f"RISK: {risk}   CONFIRMATION REQUIRED: {'yes' if confirm else 'no'}")
    parts.append("PLANNED ACTION:\n" + plan)
    ex = [s for s in steps if not s[1]]
    gate = [s for s in steps if s[1]]
    if ex:
        parts.append("STEPS:\n" + "\n".join(
            f"- {s[0]}" + (f"  [FAILED: {s[4][:70]}]" if s[2] else "") for s in ex))
    if gate:
        parts.append("STOPPED FOR CONFIRMATION: " + (gate[0][5] or "user approval required"))
    if verif:
        parts.append("VERIFICATION:\n" + "\n".join(f"- {c}  -> expect: {e}" for c, e in verif))
    if rollback:
        parts.append("ROLLBACK: " + rollback)
    parts.append("RESULT: " + summary)
    parts.append("RECOMMENDATION: " + rec)
    if not resolved:
        parts.append("NOTE: not executed - awaiting your decision.")
    lines.append(json.dumps({"messages": [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": goal},
        {"role": "assistant", "content": "\n\n".join(parts)},
    ]}, ensure_ascii=False) + "\n")

json.dump(sess, open(SESS, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
open(JSNL, "w", encoding="utf-8").writelines(lines)

print(f"automation records : {len(sess)}")
print(f"distinct intents   : {len(set(r['intent'] for r in sess))}")
print(f"needing clarification : {sum(1 for r in sess if r['missingParameters'])}")
print(f"requiring confirmation: {sum(1 for r in sess if r['requiresConfirmation'])}")
print(f"blocked (gate hit)    : {sum(1 for r in sess if any(s['blocked'] for s in r['steps']))}")
print(f"not executed          : {sum(1 for r in sess if not r['resolved'])}")
print(f"high risk             : {sum(1 for r in sess if r['riskLevel']=='high')}")
print(f"with rollback path    : {sum(1 for r in sess if r['rollback'])}")
print(f"\nwrote {SESS} and {JSNL}")
