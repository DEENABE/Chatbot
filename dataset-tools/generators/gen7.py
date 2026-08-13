import json
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

NEW = [
# ---------- Basic/common error codes users hit in PowerShell ----------
("powershell","PowerShell says 'The term ... is not recognized as the name of a cmdlet, function, script file, or operable program'",
 "This error means PowerShell couldn't find the command in any module on the PSModulePath or in PATH -- here the command comes from a module (ActiveDirectory) that was never installed on this machine, not a typo.",
 [("Get-Command Get-ADUser -ErrorAction SilentlyContinue","(no output -- command not found)",""),
  ("Get-Module -ListAvailable ActiveDirectory","(no output -- module not installed)","")],
 "Install the module that provides the command -- for AD cmdlets: 'Add-WindowsCapability -Online -Name Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0'; for gallery modules: 'Install-Module <name>'. For a mistyped local script, prefix with '.\\' since PowerShell doesn't run scripts from the current directory by default."),
("powershell","PowerShell script fails with 'File cannot be loaded because running scripts is disabled on this system' (0x800A03EC-style policy block)",
 "The execution policy is Restricted, PowerShell's out-of-the-box default that blocks all script files while still allowing interactive commands -- a policy setting, not file corruption.",
 [("Get-ExecutionPolicy -List","Scope         ExecutionPolicy\n-----         ---------------\nCurrentUser   Undefined\nLocalMachine  Restricted","")],
 "Run 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned' -- local scripts then run while downloaded ones need unblocking ('Unblock-File script.ps1' after review). Avoid 'Unrestricted' or Bypass system-wide."),
("powershell","PowerShell remoting fails with 'WinRM cannot process the request ... error 0x80090311' (Kerberos)",
 "0x80090311 means WinRM couldn't authenticate via Kerberos -- the target was addressed by IP address, and Kerberos requires a resolvable hostname/SPN; IP connections silently need different auth (NTLM/TrustedHosts).",
 [("Test-WSMan 192.168.1.50","Test-WSMan : ... error 0x80090311 ... Kerberos authentication failed",""),
  ("Test-WSMan fileserver01","wsmid : http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd (success)","")],
 "Connect using the hostname instead of the IP; if IP is unavoidable, add it to TrustedHosts ('Set-Item WSMan:\\localhost\\Client\\TrustedHosts 192.168.1.50') and use -Credential, understanding this downgrades to NTLM."),
("powershell","Enter-PSSession fails with 'Access is denied' even using a local admin account on the target",
 "The account is a local (not domain) admin on the target, and Windows' remote UAC token-filtering strips administrative rights from local accounts connecting over the network, so WinRM sees a standard user.",
 [("Enter-PSSession SRV02 -Credential SRV02\\localadmin","Enter-PSSession : ... Access is denied",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name LocalAccountTokenFilterPolicy -ErrorAction SilentlyContinue","(value not present -- remote UAC filtering active)","")],
 "Use a domain account with admin rights on the target (preferred), or on the target set LocalAccountTokenFilterPolicy=1 to disable token filtering for local accounts -- weigh the security trade-off first."),
("powershell","Install-Module fails with 'Unable to resolve package source' / 'No match was found for the specified search criteria'",
 "PowerShellGet on this older Windows build still speaks TLS 1.0 by default, and the PowerShell Gallery now requires TLS 1.2, so the repository is unreachable -- a protocol mismatch, not a missing module.",
 [("Find-Module PSWindowsUpdate -ErrorAction SilentlyContinue","WARNING: Unable to resolve package source 'https://www.powershellgallery.com/api/v2'",""),
  ("[Net.ServicePointManager]::SecurityProtocol","Ssl3, Tls","")],
 "Enable TLS 1.2 for the session: '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12', then 'Install-PackageProvider NuGet -Force' and retry; make it permanent via the SchUseStrongCrypto registry values for .NET."),
("powershell","A script that works interactively fails as 'cannot be loaded. The file ... is not digitally signed' under AllSigned policy",
 "The machine enforces the AllSigned execution policy via GPO, and the script has no Authenticode signature, so PowerShell blocks it in every context -- interactive testing worked only on a different machine with RemoteSigned.",
 [("Get-ExecutionPolicy -List","Scope         ExecutionPolicy\n-----         ---------------\nMachinePolicy AllSigned",""),
  ("Get-AuthenticodeSignature .\\deploy.ps1 | Select-Object Status","Status\n------\nNotSigned","")],
 "Sign the script with a code-signing certificate trusted by the organization ('Set-AuthenticodeSignature'), since MachinePolicy comes from GPO and can't be overridden locally -- signing is the compliant path."),
("powershell","Comparing versions in PowerShell gives wrong results, e.g. '10.0.9' treated as greater than '10.0.10'",
 "The script compares versions as strings, and string comparison is character-by-character ('9' > '1'), so semantic ordering breaks -- a data-type bug that silently produces wrong branch decisions rather than an error.",
 [("'10.0.9' -gt '10.0.10'","True",""),
  ("[version]'10.0.9' -gt [version]'10.0.10'","False","")],
 "Cast to [version] before comparing ('[version]$a -gt [version]$b') so each numeric component compares properly; the same trap applies to sorting -- use 'Sort-Object {[version]$_.Ver}'."),
# ---------- Basic/common CMD error codes ----------
("cmd","CMD says \"'xyz' is not recognized as an internal or external command, operable program or batch file\"",
 "The executable exists on disk but its folder isn't in the PATH environment variable for this session -- installers sometimes update PATH only for new sessions, or the app was installed per-user while the terminal runs elevated as a different context.",
 [("where xyz","INFO: Could not find files for the given pattern(s).",""),
  ("echo %PATH%","(PATH does not include C:\\Program Files\\XYZ\\bin)","")],
 "Open a NEW terminal after installs (PATH is read at process start), or add the folder to PATH: 'setx PATH \"%PATH%;C:\\Program Files\\XYZ\\bin\"' then reopen the terminal; verify with 'where xyz'."),
("cmd","Batch script fails with 'Access is denied' on commands that work when typed manually in an elevated prompt",
 "The scheduled/double-clicked batch runs non-elevated even though the user is an administrator -- UAC gives interactive admins a filtered token by default, and only an explicitly elevated console has the full token the commands need.",
 [("whoami /groups | findstr /i \"S-1-16\"","Mandatory Label\\Medium Mandatory Level (script context) vs High Mandatory Level (manual elevated prompt)","")],
 "Run the batch elevated: right-click > Run as administrator, or for scheduled tasks tick 'Run with highest privileges'; a self-elevating stub at the top of the script can request UAC elevation automatically."),
("cmd","robocopy exits with code 8 or higher and the wrapper script treats even successful runs as failures",
 "Robocopy's exit codes 0-7 are success/informational (1 = files copied) and only 8+ indicate real failures -- the wrapper treats any nonzero code as an error, misreading robocopy's convention.",
 [("robocopy C:\\Src D:\\Dst /MIR & echo Exit: %ERRORLEVEL%","Exit: 1 (files copied successfully)","")],
 "In wrappers, treat robocopy exit codes below 8 as success: 'if %ERRORLEVEL% GEQ 8 (echo FAIL) else (echo OK)'; codes 8 (failures) and 16 (fatal) are the genuinely failing values."),
("cmd","xcopy/copy in a batch file fails with 'The system cannot find the path specified' though the path exists",
 "The path contains spaces and isn't quoted, so CMD parses it as multiple arguments -- the command searches for a truncated path that genuinely doesn't exist; typing it interactively worked only because tab-completion added quotes.",
 [("xcopy C:\\Users\\John Doe\\Docs D:\\Backup /E","The system cannot find the path specified.",""),
  ("xcopy \"C:\\Users\\John Doe\\Docs\" D:\\Backup /E","(copies successfully)","")],
 "Quote every path that may contain spaces in batch files, and prefer robocopy for backup jobs -- it handles long paths and retries far better than xcopy."),
("cmd","net use returns 'System error 1219: Multiple connections to a server or shared resource by the same user' ",
 "Windows allows only one credential set per server per session; an existing connection to the server under different credentials blocks the new mapping -- the error is about the conflicting session, not the new credentials being wrong.",
 [("net use","Status       Local   Remote\n-------------------------------\nOK           Z:      \\\\fs01\\public (connected as CORP\\jdoe)","")],
 "Disconnect the existing mappings to that server first ('net use \\\\fs01 /delete' or 'net use * /delete'), then connect with the intended credentials; alternatively address the server by IP or FQDN alias to create a distinct session."),
("cmd","sfc /scannow aborts with 'Windows Resource Protection could not perform the requested operation'",
 "SFC needs the TrustedInstaller service and writable access to the servicing infrastructure; here the PendingRenames registry backlog from a stuck update blocks it -- SFC can't proceed while the servicing stack has an incomplete transaction.",
 [("Get-Service TrustedInstaller | Select-Object Status","Status\n------\nRunning",""),
  ("DISM /Online /Cleanup-Image /CheckHealth","The component store is repairable.","")],
 "Run 'DISM /Online /Cleanup-Image /RestoreHealth' first to clear the servicing corruption, reboot, then re-run 'sfc /scannow'; if it still aborts, run SFC from Safe Mode or offline via Recovery."),
("cmd","chkdsk on C: says 'Cannot lock current drive ... because the volume is in use by another process'",
 "The system volume can never be locked while Windows is running from it -- chkdsk's message is expected behavior for C:, offering the dirty-bit schedule instead, not an error condition to fix.",
 [("chkdsk C: /f","Chkdsk cannot run because the volume is in use by another process. Would you like to schedule this volume to be checked the next time the system restarts? (Y/N)","")],
 "Answer Y to schedule the check at next reboot (autochk runs before Windows mounts the volume), or run 'chkdsk /f /x' against non-system volumes directly; 'chkdsk C: /scan' performs an online scan without locking."),
# ---------- More Event IDs ----------
("eventlog","Security Event ID 4625 logon failures with Status 0xC000006D and Sub Status 0xC0000064 -- what's the difference?",
 "4625's sub-status pinpoints the failure kind: 0xC0000064 means the username itself doesn't exist (typo or probing for account names), unlike 0xC000006A (wrong password for a real account) -- these events show someone enumerating nonexistent usernames.",
 [("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625} -MaxEvents 5 | Select-Object -ExpandProperty Message","Sub Status: 0xC0000064 (username does not exist), Account Name: admin, administrator, root, test...","")],
 "Sequential attempts against nonexistent generic usernames indicate scanning -- block the source IP at the firewall, disable direct internet exposure of the logon service (RDP/SMB), and alert on 4625 bursts with 0xC0000064."),
("eventlog","Security Event ID 4648 'A logon was attempted using explicit credentials' appearing for unexpected accounts",
 "4648 fires when a process uses 'RunAs'-style explicit credentials; the events here show a helpdesk tool legitimately using its service credential -- but the same event is also the signature for pass-the-hash-style lateral movement, so source/target context matters.",
 [("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4648} -MaxEvents 5 | Select-Object -ExpandProperty Message","Subject: CORP\\helpdesk-tool, Target Account: CORP\\svc-remote, Process: C:\\Program Files\\HelpDesk\\agent.exe","")],
 "Baseline which processes legitimately generate 4648 (management agents, backup tools); investigate 4648 events whose source process is unusual (cmd.exe, powershell.exe) or whose target account is privileged."),
("eventlog","Security Event ID 4672 'Special privileges assigned to new logon' floods the log -- is it a problem?",
 "4672 logs every time an account holding admin-equivalent privileges signs in, including SYSTEM's constant service logons -- volume alone isn't suspicious; the value is in watching for 4672 attached to accounts that shouldn't be privileged.",
 [("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4672} -MaxEvents 5 | Select-Object -ExpandProperty Message","Account: NT AUTHORITY\\SYSTEM (majority), CORP\\jdoe-admin (interactive logons)","")],
 "No action for SYSTEM-generated volume. Alert instead on 4672 for accounts outside the known admin group list -- that combination means an account has picked up privileges it shouldn't have."),
("eventlog","System log shows Event ID 7031 'The ... service terminated unexpectedly ... corrective action: Restart the service' loops",
 "7031 records the crash and the recovery action; this service crashes and gets auto-restarted every few minutes, and its Application-log pair points to a corrupted configuration file read at startup -- an infinite crash-restart loop.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=7031} -MaxEvents 5 | Select-Object TimeCreated","5 crash/restart cycles in 20 minutes",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000} -MaxEvents 2 | Select-Object -ExpandProperty Message","Faulting application: syncsvc.exe -- access violation reading config.xml","")],
 "Restore or delete the corrupted config.xml (the service recreates defaults), and cap recovery attempts (services.msc > Recovery) so a future bad config doesn't churn endlessly in the background."),
("eventlog","Event ID 36887 Schannel 'The following fatal alert was received: 40' when browsing internal sites",
 "Schannel 36887 alert 40 is a TLS handshake_failure received from the server; these correlate with one legacy internal appliance that only offers cipher suites Windows no longer enables -- the client and that server share no common cipher.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=36887} -MaxEvents 5 | Select-Object -ExpandProperty Message","The following fatal alert was received: 40. (repeatedly, timestamps matching visits to https://legacy-appliance)","")],
 "Upgrade the appliance's firmware to support modern TLS 1.2 cipher suites -- re-enabling weak ciphers client-side via GPO would fix the symptom but weakens every other connection, so patch the server side."),
("eventlog","Event ID 20 (WindowsUpdateClient) 'Installation Failure: Windows failed to install the following update with error 0x800f0922'",
 "Event 20 preserves each update's failing error code; 0x800f0922 specifically means the update couldn't service the System Reserved/EFI partition -- here it's a nearly full 100 MB System Reserved partition from an old install.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WindowsUpdateClient'; Id=20} -MaxEvents 3","Installation Failure ... error 0x800f0922: KB5034... (repeated)",""),
  ("Get-Partition | Where-Object IsSystem | Select-Object Size","Size\n----\n104857600 (100 MB, ~95% used)","")],
 "Free space on the System Reserved partition (delete stale $WINDOWS.~BT boot files, or shrink C: slightly and extend the reserved partition with a partition tool); 0x800f0922 clears once the partition has room."),
("eventlog","Event ID 1008 (Perflib) 'The Open Procedure for service ... failed' logged at every boot",
 "Perflib 1008 means a performance-counter DLL registered by an application fails to load -- typically leftover counter registrations from uninstalled software; it pollutes the log but only breaks that app's own counters.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-Perflib'; Id=1008} -MaxEvents 3 | Select-Object -ExpandProperty Message","The Open Procedure for service 'OldAppPerf' in DLL 'C:\\Program Files\\OldApp\\perfcounters.dll' failed. (file no longer exists)","")],
 "Remove the orphaned counter registration: 'unlodctr OldAppPerf' cleanly deregisters it; alternatively rebuild all counters with 'lodctr /R' if multiple orphans exist. Purely cosmetic otherwise."),
("eventlog","Event ID 1530 vs 1533 vs 1511 in the User Profile Service log -- profile won't unload and folders won't delete",
 "The sequence tells the story: 1530 (hive still in use at logoff) leads to 1533 (cannot delete profile directory) on this machine using mandatory profile cleanup -- a per-user process holding the hive blocks the entire delete-at-logoff flow.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-User Profiles Service'} -MaxEvents 6 | Select-Object Id, TimeCreated","Ids in order per logoff: 1530 -> 1533 (every cycle)","")],
 "Identify the hive-holding process named inside the 1530 event detail and stop it running post-logoff (convert it to a machine service or remove from Run key); the 1533 deletion failures stop once the hive unloads cleanly."),
("eventlog","Event ID 4198 or 4199 'The system detected an address conflict for IP address ...' in the System log",
 "TCPIP events 4198/4199 log IP address conflicts including the conflicting MAC address -- the MAC recorded here belongs to a printer with a hardcoded static IP inside the router's DHCP range, which periodically collides with DHCP assignments.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Tcpip'} -MaxEvents 3 | Select-Object -ExpandProperty Message","The system detected an address conflict for IP address 192.168.1.53 with the system having network hardware address 00-1B-A9-XX-XX-XX.","")],
 "Look up the conflicting MAC's vendor prefix to identify the device (here a printer), then either give it a DHCP reservation or move its static IP outside the DHCP pool; the event's MAC field removes the guesswork."),
("eventlog","Event ID 5152/5157 (Filtering Platform) show packets being blocked but Windows Firewall rules look correct",
 "5152/5157 are WFP (Windows Filtering Platform) block events, and the filter ID logged doesn't belong to Windows Firewall at all -- a third-party VPN's kernel filter driver is silently dropping this app's traffic even with firewall rules allowing it.",
 [("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=5157} -MaxEvents 3 | Select-Object -ExpandProperty Message","The Windows Filtering Platform has blocked a connection. Filter Run-Time ID: 89123",""),
  ("netsh wfp show filters file=filters.xml; Select-String -Path filters.xml -Pattern '89123' -Context 3","Filter 89123 belongs to provider 'ThirdPartyVPN LWF'","")],
 "Map the blocking filter ID from the event to its owning provider with 'netsh wfp show filters' -- then adjust that product's (here the VPN's) split-tunneling/firewall settings; Windows Firewall itself was never the blocker."),
("eventlog","ESENT Event ID 623 'The version store for this instance ... has reached its maximum size' with failing Windows Search or WSUS",
 "ESENT 623 means a long-running transaction pinned the version store until it hit its cap, aborting other transactions -- on this WSUS server it fires during the huge monthly sync transaction, killing the sync partway.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='ESENT'; Id=623} -MaxEvents 2 | Select-Object -ExpandProperty Message","The version store for this instance (SUS20ClientDataStore) has reached its maximum size of 512 MB.","")],
 "For WSUS: run the Server Cleanup Wizard/decline superseded updates so sync transactions shrink, and add RAM (version store scales with available memory); for Windows Search hitting 623, rebuild the index."),
("eventlog","Event ID 157 'Disk X has been surprise removed' for a drive that's still physically connected",
 "Event 157 means the OS lost the disk without a clean removal; for an always-connected internal drive this indicates the link dropping (failing cable/port/power) or a USB enclosure bridge resetting -- the disk vanishes and re-enumerates.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=157} -MaxEvents 5 | Select-Object -ExpandProperty Message","Disk 2 has been surprise removed. (five times today, same disk)","")],
 "Swap the SATA/USB cable and connector first, try a different port/enclosure, and check 'Allow the computer to turn off this device' on USB hubs; recurring 157 after cabling fixes means the drive or enclosure electronics are failing."),
("eventlog","CAPI2 Event ID 4107 'Failed extract of third-party root list from auto update cab' with certificate errors",
 "CAPI2 4107 means the automatic root-certificate list update failed signature validation -- on this machine because the system clock was days off, making the downloaded CTL appear expired/not-yet-valid.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-CAPI2'; Id=4107} -MaxEvents 2","Failed extract of third-party root list from auto update cab ... A required certificate is not within its validity period.",""),
  ("w32tm /query /status","Last Successful Sync Time: 5 days ago; clock offset ~-96 hours","")],
 "Fix time sync first (start W32Time, 'w32tm /resync'); the root-list update self-heals on the next attempt with a correct clock. Persistent 4107 with good time points to a proxy intercepting ctldl.windowsupdate.com."),
("eventlog","DriverFrameworks-UserMode Event ID 10110 'A problem has occurred with one or more user-mode drivers' with USB device resets",
 "UMDF 10110 records a user-mode driver host crash; the device instance here is a USB smartcard reader whose driver host dies each time the machine resumes from sleep, taking the reader offline until replug.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=10110} -MaxEvents 3 | Select-Object -ExpandProperty Message","A problem has occurred with one or more user-mode drivers and the hosting process has been terminated. Device: USB\\VID_072F...(smartcard reader)","")],
 "Update the smartcard reader's driver from the vendor, and disable USB selective suspend for its hub as a workaround; UMDF crashes at resume are almost always fixed in newer driver builds."),
("eventlog","Group Policy Event ID 1058 'The processing of Group Policy failed ... could not read file \\\\domain\\SYSVOL\\...\\gpt.ini'",
 "GP 1058 means the client couldn't read a GPO's gpt.ini from SYSVOL; here DFS referrals hand the client a domain controller whose SYSVOL replica is missing this new GPO's folder -- a replication lag/failure symptom surfacing on clients.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-GroupPolicy'; Id=1058} -MaxEvents 3","The processing of Group Policy failed... file \\\\corp.local\\SYSVOL\\corp.local\\Policies\\{NEW-GPO-GUID}\\gpt.ini",""),
  ("dfsrdiag backlog /rgname:\"Domain System Volume\" /rfname:\"SYSVOL Share\" /smem:DC01 /rmem:DC02","Backlog File Count: 87","")],
 "Fix SYSVOL replication between the DCs (drain the DFSR backlog; check for journal-wrap events on the lagging DC); client-side 1058 clears automatically once every DC serves the complete Policies folder."),
("eventlog","Kernel-Power Event ID 105 'Power source change' spams hundreds of times a day on a laptop",
 "Event 105 logs each AC/battery transition; hundreds per day means the machine is rapidly flapping between AC and battery -- physical evidence of a failing adapter, connector, or cable delivering intermittent power, not a Windows issue.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; Id=105} -MaxEvents 10 | Select-Object TimeCreated","10 AC/DC transitions within 4 minutes","")],
 "Test with a different compatible charger and check the DC jack for looseness; constant power flapping also degrades the battery, so treat the adapter/jack repair as urgent rather than cosmetic."),
("eventlog","Application Popup Event ID 26 'Windows - Low On Registry Space' or odd popup text logged",
 "Application Popup 26 records any system modal popup text into the log -- the recorded popup here reveals a driver's out-of-memory dialog appearing on a headless server where nobody sees the screen, explaining 'silent' hangs awaiting a click.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Application Popup'; Id=26} -MaxEvents 3 | Select-Object -ExpandProperty Message","Application popup: legacybackup.exe - Out of Memory: Not enough memory to complete operation. (dialog awaiting OK on console)","")],
 "Event 26 is how you discover invisible dialogs on servers -- fix the underlying app fault (here the legacy backup's memory limit) and configure services to run non-interactively so they can never block on a popup."),
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
base_time = datetime(2026, 7, 30, 18, 0, 0)
i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goals:
        skipped.append(goal)
        continue
    created = base_time + timedelta(minutes=5 * i)
    i += 1
    steps = [{"command": c, "blocked": False, "exitCode": 0, "stdout": o, "stderr": e, "reason": None} for c, o, e in commands]
    entry = {
        "id": next_id(),
        "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal,
        "domain": domain,
        "plan": [f"Reproduce/inspect the error with read-only {domain} checks", "Interpret the specific error code or event data", "Apply the appropriate fix or explain expected behavior"],
        "steps": steps,
        "resolved": True,
        "summary": summary,
        "recommendation": recommendation,
        "feedback": {"worked": True, "note": "", "at": (created + timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}
    }
    data.append(entry)
    existing_goals.add(goal)

    cmd_lines = "\n".join(f"- {c[0]}" for c in commands)
    assistant_content = f"{summary}\nCommands used:\n{cmd_lines}\nRecommendation: {recommendation}"
    chat = {"messages": [
        {"role": "system", "content": f"You are a Windows repair expert specializing in {domain} problems. Diagnose with read-only commands first, then apply safe fixes."},
        {"role": "user", "content": goal},
        {"role": "assistant", "content": assistant_content}
    ]}
    jsonl_lines.append(json.dumps(chat, ensure_ascii=False) + "\n")

with open(JSON_PATH, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
with open(JSONL_PATH, "w", encoding="utf-8") as f:
    f.writelines(jsonl_lines)

print("Added:", i, "Skipped:", skipped)
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
print("All validation passed: no duplicates, files fully mirrored")
