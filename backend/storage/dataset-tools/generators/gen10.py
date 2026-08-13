import json
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

# Failure-path scenarios: (domain, goal, summary, [(cmd, exitCode, stdout, stderr)], recommendation)
NEW = [
("recovery","Wi-Fi fix failed at first because the adapter wasn't named 'Wi-Fi' -- how the repair recovered",
 "The initial restart command failed because this laptop's adapter is named 'WLAN', not the default 'Wi-Fi'. Discovering the real adapter name with Get-NetAdapter and retrying with it completed the fix.",
 [("Restart-NetAdapter -Name 'Wi-Fi'",1,"","Restart-NetAdapter : No MSFT_NetAdapter objects found with property 'Name' equal to 'Wi-Fi'"),
  ("Get-NetAdapter | Select-Object Name, Status",0,"Name  Status\n----  ------\nWLAN  Up\nEthernet Disconnected",""),
  ("Restart-NetAdapter -Name 'WLAN'",0,"","")],
 "Never assume adapter names -- enumerate with Get-NetAdapter first; adapter naming varies by OEM, language, and how many adapters were ever installed."),
("recovery","Service fix failed with 'Access is denied' until elevation -- recovery flow",
 "Set-Service failed because the session wasn't elevated. After confirming the missing Administrator token, relaunching PowerShell as admin allowed the same command to succeed.",
 [("Set-Service bthserv -StartupType Automatic",1,"","Set-Service : Service 'bthserv' cannot be configured due to the following error: Access is denied"),
  ("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",0,"False",""),
  ("Start-Process powershell -Verb RunAs # relaunch elevated, then:",0,"",""),
  ("Set-Service bthserv -StartupType Automatic; Start-Service bthserv",0,"","")],
 "Check elevation before service/registry/disk operations; a quick IsInRole test avoids confusing 'Access denied' failures halfway through a repair."),
("recovery","AD query failed because RSAT wasn't installed -- recovery flow",
 "Get-ADUser failed since the ActiveDirectory module wasn't present on this workstation. Installing the RSAT capability provided the module, after which the original query ran normally.",
 [("Get-ADUser jdoe -Properties LockedOut",1,"","Get-ADUser : The term 'Get-ADUser' is not recognized as the name of a cmdlet"),
  ("Get-WindowsCapability -Online -Name 'Rsat.ActiveDirectory*' | Select-Object Name, State",0,"Name: Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0  State: NotPresent",""),
  ("Add-WindowsCapability -Online -Name 'Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0'",0,"Online : True\nRestartNeeded : False",""),
  ("Get-ADUser jdoe -Properties LockedOut | Select-Object LockedOut",0,"LockedOut\n---------\n     True","")],
 "When a cmdlet is 'not recognized', check the owning module/capability before assuming a typo -- RSAT tools are not installed by default on workstations."),
("recovery","Drive letter assumed wrong -- chkdsk ran against the wrong volume and was redone correctly",
 "The user said 'my external drive D:' but D: was actually the DVD drive; chkdsk failed accordingly. Enumerating volumes identified the external drive as F:, where the scan then found and fixed errors.",
 [("chkdsk D:",1,"","Cannot open volume for direct access."),
  ("Get-Volume | Select-Object DriveLetter, FileSystemLabel, DriveType",0,"DriveLetter FileSystemLabel DriveType\nC           System          Fixed\nD                           CD-ROM\nF           MyPassport      Removable",""),
  ("chkdsk F:",0,"Windows has scanned the file system and found no problems.","")],
 "Verify which letter maps to which physical device before disk operations -- user descriptions and actual letters frequently disagree."),
("recovery","DISM RestoreHealth failed offline (0x800f0906) and succeeded with an explicit source",
 "RestoreHealth couldn't download repair files because WSUS policy blocks Windows Update access. Mounting matching install media and pointing DISM at its WIM completed the repair offline.",
 [("DISM /Online /Cleanup-Image /RestoreHealth",1,"","Error: 0x800f0906 - The source files could not be downloaded"),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate' -Name UseWUServer",0,"UseWUServer : 1",""),
  ("DISM /Online /Cleanup-Image /RestoreHealth /Source:WIM:E:\\sources\\install.wim:1 /LimitAccess",0,"The restore operation completed successfully.","")],
 "On WSUS-managed machines, keep matching-build install media handy; /Source with /LimitAccess repairs without touching Windows Update at all."),
("recovery","Defender scan cmdlet failed because a third-party AV had Defender disabled -- recovery flow",
 "Start-MpScan errored since Defender was in passive/disabled mode under a third-party antivirus. The correct action was to scan with the active product instead of forcing Defender.",
 [("Start-MpScan -ScanType QuickScan",1,"","Start-MpScan : Operation failed with the following error: 0x800106ba"),
  ("Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object displayName, productState",0,"displayName     productState\nESET Security   266240",""),
  ("Get-MpComputerStatus | Select-Object AMRunningMode",0,"AMRunningMode\n--------------\nPassive Mode","")],
 "When Defender cmdlets throw 0x800106ba, check SecurityCenter2 for the active AV first -- run scans through the installed product or uninstall it to hand control back to Defender."),
("recovery","Network reset commands failed in a constrained session -- recovery via full console",
 "netsh winsock reset failed inside the restricted remote session (Constrained Language + no elevation). Running it from a local elevated console completed the reset and the reboot cleared the issue.",
 [("netsh winsock reset",1,"","The requested operation requires elevation (Run as administrator)."),
  ("$ExecutionContext.SessionState.LanguageMode",0,"ConstrainedLanguage",""),
  ("# On the local machine, elevated console:\nnetsh winsock reset",0,"Successfully reset the Winsock Catalog.\nYou must restart the computer in order to complete the reset.","")],
 "Know your session's limits: JEA/constrained remote sessions can't do everything -- some repairs must run from a local elevated console by design."),
("recovery","Printer cmdlet failed because the Spooler was stopped -- fixing the dependency first",
 "Get-Printer failed outright because the Print Spooler service itself was stopped -- the cmdlet needs the service running. Starting the Spooler first allowed the queue inspection and the stuck job removal.",
 [("Get-Printer",1,"","Get-Printer : The spooler service is not reachable."),
  ("Get-Service Spooler | Select-Object Status",0,"Status\n------\nStopped",""),
  ("Start-Service Spooler",0,"",""),
  ("Get-Printer | Select-Object Name, PrinterStatus",0,"Name           PrinterStatus\nHP LaserJet    Normal","")],
 "Diagnostic cmdlets have service dependencies too -- if a query itself fails oddly, check whether its backing service is even running."),
("recovery","Registry fix targeted a missing key -- created the path before setting the value",
 "Set-ItemProperty failed because the policy key didn't exist yet on this machine. Creating the key path first, then setting the value, applied the fix.",
 [("Set-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System' -Name EnableActivityFeed -Value 0",1,"","Set-ItemProperty : Cannot find path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System' because it does not exist."),
  ("New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System' -Force | Out-Null",0,"",""),
  ("Set-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System' -Name EnableActivityFeed -Value 0",0,"","")],
 "Policy registry paths often don't exist until first use -- create missing key paths with New-Item -Force before writing values."),
("recovery","Hyper-V cmdlets absent on Windows Home -- explaining the edition limit instead of retrying",
 "Get-VM failed because Hyper-V isn't available on Windows Home at all -- no retry can fix an edition limitation, so the correct 'repair' was recommending alternatives.",
 [("Get-VM",1,"","Get-VM : The term 'Get-VM' is not recognized as the name of a cmdlet"),
  ("Get-CimInstance Win32_OperatingSystem | Select-Object Caption",0,"Caption\n-------\nMicrosoft Windows 11 Home","")],
 "Recognize unfixable-by-command situations: Hyper-V needs Pro/Enterprise. On Home, use VirtualBox/VMware Workstation Player, or upgrade the edition."),
("recovery","Get-WinEvent returned 'No events were found' -- widening the filter instead of concluding no issue",
 "The exact-ID query returned nothing because the provider name differed on this OS version. Querying by log and time window found the events under a slightly different provider, avoiding a false 'all clear'.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WER-SystemErrorReporting'; Id=1001}",1,"","Get-WinEvent : No events were found that match the specified selection criteria."),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddDays(-2)} -MaxEvents 50 | Group-Object ProviderName | Sort-Object Count -Descending | Select-Object -First 5 Name, Count",0,"Name                              Count\nMicrosoft-Windows-Kernel-Power        6\nEventLog                              4","")],
 "An empty event query proves nothing by itself -- widen to a time window and group by provider before declaring a system clean; provider names shift between Windows versions."),
("recovery","Appx repair failed with 'deployment failed ... resource in use' -- closing the app first",
 "Reset-AppxPackage failed while the target app was still running. Stopping the app's processes let the reset complete.",
 [("Get-AppxPackage Microsoft.WindowsCalculator | Reset-AppxPackage",1,"","Reset-AppxPackage : Deployment failed with HRESULT: 0x80073D02, The package could not be installed because resources it modifies are currently in use."),
  ("Get-Process Calculator* | Stop-Process -Force",0,"",""),
  ("Get-AppxPackage Microsoft.WindowsCalculator | Reset-AppxPackage",0,"","")],
 "0x80073D02 means the package's processes are running -- stop them (including background instances) before reset/reinstall operations."),
("recovery","BitLocker unlock failed with a mistyped recovery key -- validating format before retry",
 "The first unlock failed because the 48-digit key had a transposed group. Validating the key format/groups and retrying with the corrected key unlocked the volume.",
 [("manage-bde -unlock D: -RecoveryPassword 123456-654321-111111-222222-333333-444444-555555-666665",1,"","The password failed to unlock volume D:."),
  ("manage-bde -protectors -get D: | findstr /i 'ID:'",0,"ID: {8A7B...} (confirmed against the printed recovery sheet's key ID)",""),
  ("manage-bde -unlock D: -RecoveryPassword 123456-654321-111111-222222-333333-444444-555555-666656",0,"The password successfully unlocked volume D:.","")],
 "Match the recovery key to the protector ID shown on the volume first -- users often have multiple saved keys, and the ID tells you which sheet/account entry is the right one."),
("recovery","sfc failed from a normal prompt but ran from Safe Mode -- pending servicing blocked it",
 "sfc aborted with 'pending repair' because a stuck servicing transaction existed. Clearing it with DISM's RevertPendingActions from Recovery let SFC complete normally afterward.",
 [("sfc /scannow",1,"","Windows Resource Protection could not perform the requested operation. There is a system repair pending which requires reboot to complete."),
  ("DISM /Online /Cleanup-Image /RevertPendingActions",1,"","Error: 3017 ... this operation must be performed from the recovery environment"),
  ("# From WinRE command prompt:\nDISM /Image:C:\\ /Cleanup-Image /RevertPendingActions",0,"The operation completed successfully.",""),
  ("sfc /scannow",0,"Windows Resource Protection did not find any integrity violations.","")],
 "'System repair pending' means a servicing transaction blocks SFC -- revert or complete it (reboot first; then RevertPendingActions from WinRE if it persists) before retrying."),
("recovery","Set-DnsClientServerAddress failed on the wrong interface index -- resolving the right index first",
 "The DNS change failed because the InterfaceAlias didn't exist; listing interfaces revealed the VPN-modified alias, and using its InterfaceIndex applied the setting.",
 [("Set-DnsClientServerAddress -InterfaceAlias 'Ethernet' -ServerAddresses 1.1.1.1",1,"","Set-DnsClientServerAddress : No MSFT_DNSClientServerAddress objects found with property 'InterfaceAlias' equal to 'Ethernet'"),
  ("Get-NetIPInterface -AddressFamily IPv4 | Select-Object InterfaceIndex, InterfaceAlias",0,"InterfaceIndex InterfaceAlias\n            12 Ethernet 2\n            34 CorpVPN Tunnel",""),
  ("Set-DnsClientServerAddress -InterfaceIndex 12 -ServerAddresses 1.1.1.1",0,"","")],
 "Prefer InterfaceIndex over alias strings in scripts -- aliases mutate ('Ethernet 2') after driver reinstalls and VPN installs; indexes are unambiguous per session."),
("recovery","Stop-Process on a hung app failed -- the process was protected, used taskkill with elevation",
 "Stop-Process couldn't kill the hung elevated app from a non-elevated shell. From an elevated console, taskkill /F ended the process tree including its stuck child.",
 [("Stop-Process -Name legacyapp -Force",1,"","Stop-Process : Cannot stop process 'legacyapp' because of the following error: Access is denied"),
  ("# elevated console:\ntaskkill /F /T /IM legacyapp.exe",0,"SUCCESS: The process with PID 4412 (child of PID 4200) has been terminated.","")],
 "Killing elevated/hung processes needs an elevated context and often /T for the whole tree -- a stuck child can keep respawning the parent's window otherwise."),
("recovery","wevtutil clear-log failed on a protected log -- exporting then clearing the right way",
 "Clearing the Security log failed without the SeSecurityPrivilege; running elevated with the privilege let the log be archived-then-cleared properly, preserving evidence.",
 [("wevtutil cl Security",1,"","Failed to clear log Security. Access is denied."),
  ("# elevated console:\nwevtutil cl Security /bu:C:\\Logs\\Security-archive.evtx",0,"","")],
 "Security log operations require elevation plus the security privilege; always archive (/bu) before clearing -- especially during incident investigations."),
("recovery","Format attempt was refused -- the correct outcome, because the disk was a recovery partition",
 "The format failed with access denied because the target was the OEM recovery partition, protected by the OS. The refusal itself was correct; the real fix was assigning the user's intended USB drive letter properly.",
 [("Format-Volume -DriveLetter E -FileSystem NTFS",1,"","Format-Volume : Access denied ... The volume is protected"),
  ("Get-Partition | Select-Object DriveLetter, Type, Size",0,"DriveLetter Type       Size\nC           Basic      475 GB\nE           Recovery   980 MB\n(no letter)  Basic      59 GB (USB)",""),
  ("Get-Disk | Where-Object BusType -eq 'USB' | Get-Partition | Set-Partition -NewDriveLetter G",0,"","")],
 "Treat refusals as information: protected/recovery partitions block formats for good reason. Re-identify the intended target by bus type/size before destructive operations."),
("recovery","Scheduled task creation failed with 0x80070005 under a Group Policy lockdown -- deploying via GPO instead",
 "Register-ScheduledTask failed because task creation is restricted by policy on this managed machine. The repair path was creating the task through Group Policy Preferences, which succeeded and applied on refresh.",
 [("Register-ScheduledTask -TaskName 'CacheClean' -Action $a -Trigger $t",1,"","Register-ScheduledTask : Access is denied. (0x80070005) -- task creation restricted by policy"),
  ("gpresult /r /scope:computer | findstr /i 'TaskScheduler'",0,"Applied GPO includes 'Restrict local scheduled task creation'","")],
 "On managed endpoints, work with the management layer instead of around it -- deploy tasks/services via GPO/Intune where local creation is restricted."),
("recovery","icacls reset failed on files with paths over 260 chars -- retried with long-path syntax",
 "The ACL reset skipped deep files with 'path too long' errors. Re-running with the \\\\?\\ long-path prefix processed the full tree.",
 [("icacls 'D:\\Projects\\deep' /reset /t",1,"","D:\\Projects\\deep\\...\\file.txt: The filename or extension is too long. Successfully processed 8231 files; Failed processing 47 files"),
  ("icacls '\\\\?\\D:\\Projects\\deep' /reset /t",0,"Successfully processed 8278 files; Failed processing 0 files","")],
 "For deep trees, use the \\\\?\\ prefix (or enable LongPathsEnabled) so ACL/copy tools reach beyond 260 characters; partial failures leave inconsistent permissions."),
]

with open(JSON_PATH, encoding="utf-8") as f:
    data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f:
    jsonl_lines = [l for l in f if l.strip()]

existing_ids = set(d["id"] for d in data)
existing_goals = set(d["goal"] for d in data)
n = 1
def next_id():
    global n
    while True:
        cand = f"new-win-repair-{n:03d}"
        n += 1
        if cand not in existing_ids:
            existing_ids.add(cand)
            return cand

skipped = []
base_time = datetime(2026, 8, 1, 10, 0, 0)
i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goals:
        skipped.append(goal); continue
    created = base_time + timedelta(minutes=6 * i); i += 1
    steps = [{"command": c, "blocked": False, "exitCode": ec, "stdout": o, "stderr": e, "reason": None} for c, ec, o, e in commands]
    data.append({
        "id": next_id(), "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal, "domain": domain,
        "plan": ["Attempt the standard fix", "Interpret the failure output correctly", "Adapt (discover real names, elevate, install prerequisites) and retry or reroute"],
        "steps": steps, "resolved": True, "summary": summary, "recommendation": recommendation,
        "feedback": {"worked": True, "note": "", "at": (created + timedelta(minutes=3)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}})
    existing_goals.add(goal)
    cmd_lines = "\n".join(f"- {c[0]}" + ("  [FAILED: " + c[3][:80] + "]" if c[1] != 0 else "") for c in commands)
    chat = {"messages": [
        {"role": "system", "content": "You are a Windows repair expert. Diagnose with read-only commands first, then apply safe fixes. When a command fails, interpret the error and adapt rather than giving up."},
        {"role": "user", "content": goal},
        {"role": "assistant", "content": f"{summary}\nCommands used:\n{cmd_lines}\nRecommendation: {recommendation}"}]}
    jsonl_lines.append(json.dumps(chat, ensure_ascii=False) + "\n")

with open(JSON_PATH, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False); f.write("\n")
with open(JSONL_PATH, "w", encoding="utf-8") as f:
    f.writelines(jsonl_lines)

print("Failure-path entries added:", i, "Skipped:", skipped)
print("Total JSON entries:", len(data))
print("Total JSONL lines:", len(jsonl_lines))

ids = [d["id"] for d in data]
assert len(ids) == len(set(ids))
goals = [d["goal"] for d in data]
assert len(goals) == len(set(goals))
with open(JSONL_PATH, encoding="utf-8") as f:
    ulines = [json.loads(l) for l in f if l.strip()]
users = [o["messages"][1]["content"] for o in ulines]
assert len(users) == len(set(users))
assert set(users) == set(goals)
print("All validation passed")
