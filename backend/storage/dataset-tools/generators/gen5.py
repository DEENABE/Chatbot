import json, re
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

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

# ============ PART 1: backfill jsonl-only entries into JSON ============
parsed = [json.loads(l) for l in jsonl_lines]
backfilled = 0
base_time = datetime(2026, 7, 29, 18, 0, 0)

for obj in parsed:
    sys_msg = obj["messages"][0]["content"]
    goal = obj["messages"][1]["content"]
    asst = obj["messages"][2]["content"]
    if goal in existing_goals:
        continue
    m = re.match(r"You are a Windows repair expert specializing in (.+?) problems\.", sys_msg)
    domain = m.group(1) if m else "windows"
    # parse assistant content: summary \n Commands used:\n- ... \n Recommendation: ...
    summary, commands, recommendation = asst, [], ""
    cm = re.search(r"\nCommands used:\n(.*?)(?:\nRecommendation: (.*))?$", asst, re.S)
    if cm:
        summary = asst[:cm.start()].strip()
        cmds_block = cm.group(1).strip()
        commands = [c[2:].strip() for c in cmds_block.splitlines() if c.startswith("- ")]
        recommendation = (cm.group(2) or "").strip()
    created = base_time + timedelta(minutes=3 * backfilled)
    steps = [{"command": c, "blocked": False, "exitCode": 0, "stdout": "", "stderr": "", "reason": None} for c in commands]
    entry = {
        "id": next_id(),
        "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal,
        "domain": domain,
        "plan": [f"Diagnose the {domain} issue with read-only checks", "Apply the appropriate safe fix or give a clear recommendation"],
        "steps": steps,
        "resolved": True,
        "summary": summary,
        "recommendation": recommendation,
        "feedback": {"worked": True, "note": "", "at": (created + timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}
    }
    data.append(entry)
    existing_goals.add(goal)
    backfilled += 1

print("Backfilled into JSON:", backfilled)

# ============ PART 2: error-code scenarios ============
NEW = [
("errorcode","Getting error 0x80070005 'Access is denied' when installing Windows updates",
 "Error 0x80070005 during updates means the update process lacked permission to write to a required folder or registry key, most often because security-software restrictions or broken ACLs on the SoftwareDistribution/Catroot2 folders are blocking TrustedInstaller.",
 [("Get-Acl 'C:\\Windows\\SoftwareDistribution' | Select-Object Owner","Owner\n-----\nBUILTIN\\Administrators (TrustedInstaller ownership missing)",""),
  ("Get-Service TrustedInstaller | Select-Object Status","Status\n------\nRunning","")],
 "Run the update as the SYSTEM context does (no manual elevation fixes this): restore default ACLs with 'icacls C:\\Windows\\SoftwareDistribution /reset /t', temporarily disable third-party antivirus, and retry."),
("errorcode","An app fails with error 0x80004005 'Unspecified error' when accessing a network share",
 "0x80004005 is a catch-all failure, but paired with a network share it almost always maps to an SMB authentication/protocol negotiation failure -- here the client had insecure guest auth disabled while the share only allows guest access.",
 [("Get-SmbClientConfiguration | Select-Object EnableInsecureGuestLogons","EnableInsecureGuestLogons\n--------------------------\n                    False","")],
 "The secure fix is enabling authenticated access on the share (add a real user account on the NAS/server); enabling insecure guest logons on the client works but reintroduces a security risk."),
("errorcode","Blue screen with stop code 0xC000021A (STATUS_SYSTEM_PROCESS_TERMINATED) after an update",
 "0xC000021A means a critical user-mode subsystem process (winlogon/csrss) died, typically after a file mismatch introduced by an interrupted update or a third-party service DLL injected into the logon path.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WER-SystemErrorReporting'} -MaxEvents 1","Bugcheck 0xc000021a recorded immediately after the last update attempt","")],
 "Boot to Recovery and run 'sfc /scannow /offbootdir=C:\\ /offwindir=C:\\Windows' followed by 'DISM /Image:C:\\ /Cleanup-Image /RestoreHealth'; if a third-party credential/logon tool was recently installed, uninstall it from Safe Mode."),
("errorcode","Windows Update fails repeatedly with 0x80070490 'Element not found'",
 "0x80070490 indicates a corrupted entry in the component-based servicing (CBS) store or a damaged system file the update depends on -- the update engine literally can't find a manifest element it expects.",
 [("DISM /Online /Cleanup-Image /ScanHealth","The component store is repairable.",""),
  ("sfc /scannow","Windows Resource Protection found corrupt files and successfully repaired them.","")],
 "Run DISM RestoreHealth then SFC (in that order), reboot, and retry the update; if it still fails, install the update manually from the Microsoft Update Catalog."),
("errorcode","MSI installer fails with error 1603 'A fatal error occurred during installation'",
 "Error 1603 is a generic MSI failure, and the verbose MSI log here shows the real cause: the installer tried writing to a folder redirected/locked by policy, so the transaction rolled back.",
 [("Get-Content \"$env:TEMP\\msi_install.log\" -Tail 20 -ErrorAction SilentlyContinue","Return value 3. CustomAction InstallFiles returned actual error code 1603 -- Access denied writing to target folder","")],
 "Re-run with verbose logging ('msiexec /i app.msi /L*v log.txt') to confirm the failing action, clear the target folder's lock/permission problem, ensure no other MSI is in progress, and retry."),
("errorcode","Enabling .NET Framework 3.5 fails with error 0x800F081F 'source files could not be found'",
 "0x800F081F means the on-demand feature payload isn't in the local component store and Windows couldn't fetch it (commonly blocked by WSUS policy that redirects feature-on-demand requests away from Windows Update).",
 [("DISM /Online /Get-Features | Select-String -Context 1 'NetFx3'","Feature Name : NetFx3\nState : Disabled","")],
 "Enable it with an explicit source from matching install media: 'DISM /Online /Enable-Feature /FeatureName:NetFx3 /All /Source:D:\\sources\\sxs /LimitAccess', or have IT enable the 'Specify settings for optional component installation' GPO to allow direct Windows Update fetch."),
("errorcode","Windows 10 to 11 feature update fails with 0xC1900101 and rolls back",
 "0xC1900101 is a driver-related rollback code: setup's compatibility log shows a storage/AV filter driver failing migration, which aborts the upgrade and rolls back to the previous build every time.",
 [("Get-Content 'C:\\$WINDOWS.~BT\\Sources\\Panther\\setuperr.log' -Tail 10 -ErrorAction SilentlyContinue","0xC1900101 - 0x20017: driver migration failure referencing a third-party storage filter driver","")],
 "Update or temporarily uninstall the specific driver/security product named in setuperr.log, disconnect nonessential peripherals, and retry the feature update; reinstall the software afterward."),
("errorcode","Installing from a USB/ISO fails with error 0x80070570 'The file or directory is corrupted and unreadable'",
 "0x80070570 during install points to corrupted source media or failing RAM -- the installer read data that didn't match its checksums, and here the ISO's hash doesn't match Microsoft's published value.",
 [("Get-FileHash 'D:\\Win11_23H2.iso' -Algorithm SHA256","(hash mismatch versus the official published SHA256)","")],
 "Re-download the ISO and re-create the USB with the official Media Creation Tool; if a verified-good USB still throws 0x80070570, run MemTest86 because failing RAM produces this same error."),
("errorcode","Windows Update error 0x8007000D 'The data is invalid' on every update attempt",
 "0x8007000D means the update datastore or a downloaded package is malformed -- the update engine is parsing invalid data, usually from a corrupted download cache rather than the update itself.",
 [("Get-Service wuauserv, bits, cryptsvc | Select-Object Name, Status","Name     Status\n----     ------\nwuauserv Running\nbits     Running\ncryptsvc Running","")],
 "Stop wuauserv/bits/cryptsvc, rename both 'SoftwareDistribution' and 'System32\\catroot2', restart the services, and re-check for updates so everything re-downloads cleanly."),
("errorcode","Corporate PC shows update error 0x80244022 whenever checking for updates",
 "0x80244022 (WU_E_PT_HTTP_STATUS_503) means the configured WSUS server responded 'Service Unavailable' -- the client-side is healthy and the update failure is entirely the WSUS server's IIS app pool being down.",
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate' -Name WUServer","WUServer : http://wsus01.corp.local:8530",""),
  ("Test-NetConnection wsus01.corp.local -Port 8530","TcpTestSucceeded : True (but HTTP returns 503)","")],
 "Report to IT: the WsusPool IIS application pool on the WSUS server needs restarting (and usually a private-memory limit increase to stop it recycling under load)."),
("errorcode","An application crashes repeatedly with exception code 0xC0000005 (Access Violation)",
 "0xC0000005 is a memory access violation inside the app; the crash dumps consistently blame the same third-party DLL injected into the process (a shell/overlay hook), not the application's own code.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'} -MaxEvents 3","Faulting module: overlay_hook64.dll (third-party overlay), exception 0xc0000005","")],
 "Update or uninstall the software owning the faulting DLL (screen-overlay/RGB/antivirus injectors are common); if unclear, run the app with overlays disabled to confirm."),
("errorcode","Windows Update error 0x8024402C 'proxy or firewall configuration problem'",
 "0x8024402C means the update client couldn't resolve/reach the update endpoints, and here a stale WinHTTP proxy (separate from the browser proxy) is black-holing the system-level HTTPS traffic.",
 [("netsh winhttp show proxy","Proxy Server(s): 127.0.0.1:8888 (stale entry from removed software)","")],
 "Run 'netsh winhttp reset proxy', confirm no manual proxy remains in Settings > Network > Proxy, then retry Windows Update."),
("errorcode","Blue screen DRIVER_POWER_STATE_FAILURE (0x9F) when sleeping or waking the laptop",
 "0x9F means a driver failed to complete a power-state transition in time; the recorded blocked IRP points at the wireless adapter's driver hanging during suspend.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=41} -MaxEvents 2","Two unexpected restarts, both immediately after sleep was initiated","")],
 "Update the Wi-Fi adapter driver (the usual culprit for 0x9F on laptops), and as a stopgap disable 'Allow the computer to turn off this device' on that adapter so suspend doesn't hang on it."),
("errorcode","Blue screen CRITICAL_PROCESS_DIED (0xEF) shortly after logging in",
 "0xEF fires when a process Windows marks as critical exits unexpectedly; correlating times shows svchost.exe hosting a critical service was being terminated by a third-party 'RAM optimizer' utility at each login.",
 [("Get-CimInstance Win32_StartupCommand | Select-Object Name, Command","Name        Command\n----        -------\nRAMBooster  C:\\Program Files\\RAMBooster\\boost.exe -aggressive","")],
 "Uninstall the process-killing 'optimizer' utility -- terminating protected svchost processes directly causes CRITICAL_PROCESS_DIED; also run 'sfc /scannow' to verify no system files were damaged."),
("errorcode","Blue screen PAGE_FAULT_IN_NONPAGED_AREA (0x50) at random moments",
 "0x50 means the kernel referenced invalid memory in the nonpaged pool -- with crashes at random (not tied to one driver or action) and mismatched RAM speeds installed, unstable memory is the leading cause.",
 [("Get-CimInstance Win32_PhysicalMemory | Select-Object BankLabel, ConfiguredClockSpeed","BankLabel ConfiguredClockSpeed\n--------- ---------------------\nBANK0                     3600\nBANK1                     3200","")],
 "Run Windows Memory Diagnostic/MemTest86; set both DIMMs to the same (lower) speed in BIOS or replace the mismatched kit with a matched pair."),
("errorcode","Error 0x80070002 'The system cannot find the file specified' during Windows backup or update",
 "0x80070002 means a file the operation's manifest references is missing on disk -- here update staging references files that were cleaned out of SoftwareDistribution mid-cycle by a disk-cleanup tool.",
 [("Test-Path 'C:\\Windows\\SoftwareDistribution\\Download'","True (folder present but nearly empty despite pending updates)","")],
 "Stop wuauserv, clear the SoftwareDistribution folder completely so tracking matches reality, restart the service, and re-scan; exclude that folder from aggressive cleanup tools going forward."),
("errorcode","Microsoft Store or activation fails with 0x80072F8F 'A security error occurred'",
 "0x80072F8F is a TLS handshake failure, and the root cause here is the system clock being off by several days -- certificate validity checks fail when local time falls outside the cert's window.",
 [("w32tm /stripchart /computer:time.windows.com /samples:1 /dataonly","local clock is 4 days, 02:11:08 behind server time","")],
 "Start W32Time and resync ('Start-Service W32Time; w32tm /resync'); with a correct clock the TLS errors disappear. If the clock drifts again after shutdowns, replace the CMOS battery."),
("errorcode","Windows activation fails with 0x803FA067 after reinstalling Windows",
 "0x803FA067 means the digital license lookup didn't match: the machine was reinstalled with a different edition (Pro media over a Home digital license), so activation correctly refuses the mismatched edition.",
 [("Get-CimInstance SoftwareLicensingProduct -Filter \"PartialProductKey IS NOT NULL\" | Select-Object Name, LicenseStatus","Name                     LicenseStatus\n----                     -------------\nWindows(R), Professional             0","")],
 "Either reinstall the edition matching the original digital license (Home), or purchase/enter a valid Pro key; the edition must match what the hardware's digital license was issued for."),
("errorcode","Volume-licensed office PC shows activation error 0xC004F074 'Key Management Service is unavailable'",
 "0xC004F074 means no KMS host answered: the client's KMS SRV lookup succeeds but the KMS host itself is unreachable on port 1688 from this network segment.",
 [("nslookup -type=srv _vlmcs._tcp.corp.local","_vlmcs._tcp.corp.local SRV service location: kms01.corp.local:1688",""),
  ("Test-NetConnection kms01.corp.local -Port 1688","TcpTestSucceeded : False","")],
 "Report to IT that port 1688 to the KMS host is blocked from this subnet (or the KMS host is down); once reachable, activate immediately with 'slmgr /ato'."),
("errorcode","Service operations fail with 0x800706BA 'The RPC server is unavailable' against a remote machine",
 "0x800706BA against a remote host means the RPC endpoint mapper (TCP 135) or the dynamic RPC ports are blocked -- the remote host is up but its firewall only permits ping, not RPC.",
 [("Test-NetConnection fileserver01 -Port 135","TcpTestSucceeded : False",""),
  ("Test-Connection fileserver01 -Count 1 -Quiet","True","")],
 "Enable the 'Remote Service Management' / 'Windows Management Instrumentation' firewall rule groups on the remote host (or the equivalent GPO), which open TCP 135 plus the dynamic RPC range."),
("errorcode","Accessing a share fails with 0x80070035 'The network path was not found' though ping works",
 "0x80070035 with successful ping means name resolution works but SMB (TCP 445) is unreachable -- the target machine has file sharing disabled or its firewall is blocking the File and Printer Sharing rule group.",
 [("Test-NetConnection fileserver01 -Port 445","TcpTestSucceeded : False","")],
 "On the target machine, enable 'File and Printer Sharing' in the firewall for the correct network profile, and confirm the 'Server' (LanmanServer) service is running."),
("errorcode","Blue screen DPC_WATCHDOG_VIOLATION (0x133) mainly during heavy disk activity",
 "0x133 means a deferred procedure call ran too long at high IRQL; on this machine it correlates with an SSD running legacy storage drivers, a classic combination for DPC watchdog timeouts under I/O load.",
 [("Get-CimInstance Win32_PnPSignedDriver | Where-Object DeviceName -like '*storahci*' | Select-Object DeviceName, DriverVersion","DeviceName                     DriverVersion\n----------                     -------------\nStandard SATA AHCI Controller  10.0.19041.1","")],
 "Update the storage controller driver (vendor IRST/NVMe driver where applicable) and the SSD's firmware; both are the standard fixes for 0x133 tied to disk activity."),
("errorcode","Windows installation fails with 0x80300024 'Windows is unable to install to the selected location'",
 "0x80300024 means setup can't use the chosen disk -- with multiple drives connected, setup put boot files on a different disk than the install target, creating a conflict.",
 [("(From setup command prompt) diskpart: list disk","Disk 0: 476 GB (target SSD)\nDisk 1: 931 GB (old HDD with an existing boot partition)","")],
 "Temporarily disconnect all drives except the intended target, install Windows, then reconnect the other drives; this guarantees boot files land on the right disk."),
("errorcode","Store apps fail to update with error 0x80073CF9",
 "0x80073CF9 is a package deployment failure, and here the AppX staging folder has broken ACLs after a profile migration, so packages can't be extracted during install/update.",
 [("Get-AppxLog -ErrorAction SilentlyContinue | Select-Object -Last 3 ActivityId, ErrorCode","ErrorCode : 0x80073CF9 (deployment failed while staging package)","")],
 "Reset the Store cache with 'wsreset.exe', then re-register the Store: 'Get-AppxPackage Microsoft.WindowsStore | Foreach {Add-AppxPackage -DisableDevelopmentMode -Register \"$($_.InstallLocation)\\AppXManifest.xml\"}'; check ACLs on 'C:\\Program Files\\WindowsApps' if it persists."),
("errorcode","Outlook/Microsoft 365 sign-in fails with error 0x80190001",
 "0x80190001 is an HTTP failure during Azure AD token retrieval -- TLS inspection by a proxy is intercepting the authentication traffic, breaking certificate pinning for the Microsoft 365 endpoints.",
 [("Test-NetConnection login.microsoftonline.com -Port 443","TcpTestSucceeded : True",""),
  ("netsh winhttp show proxy","Proxy Server(s): proxy.corp.local:8080","")],
 "Have IT exclude Microsoft 365 authentication endpoints (login.microsoftonline.com and related URLs from Microsoft's published list) from TLS/SSL inspection on the proxy."),
("errorcode","SCCM/Intune app deployment fails on clients with error 0x87D00668",
 "0x87D00668 means the client received the deployment but the software change returned 'requirement not met' -- the deployment's requirement rule (minimum OS build) excludes these machines, so the agent correctly skips installation.",
 [("Get-Content 'C:\\Windows\\CCM\\Logs\\AppDiscovery.log' -Tail 5","Requirement 'OperatingSystem >= 10.0.22000' evaluated to False on this client","")],
 "Either update the targeted machines to the required OS build, or adjust the application's requirement rules in SCCM/Intune to include the older builds intentionally."),
("errorcode","Windows Hello for Business enrollment fails with 0x801C03ED",
 "0x801C03ED means the device registration completed but the directory hasn't synced the device object yet -- enrollment is racing ahead of Azure AD Connect's sync cycle, so the server rejects the not-yet-visible device.",
 [("dsregcmd /status | Select-String 'AzureAdJoined|DeviceId'","AzureAdJoined : YES\nDeviceId : (present)","")],
 "Wait for (or trigger) an Azure AD Connect delta sync so the device object reaches Azure AD, then retry enrollment; recurring cases usually mean the sync interval is set too long."),
("errorcode","Remote Desktop fails with 'CredSSP encryption oracle remediation' error (0x800706BE variant)",
 "The client and server have mismatched CredSSP patch levels: one side enforces the hardened CredSSP protocol while the other is unpatched, so the connection is rejected by policy rather than a network fault.",
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\CredSSP\\Parameters' -Name AllowEncryptionOracle -ErrorAction SilentlyContinue","(value not present -- default enforcement active)","")],
 "Patch the unpatched side (preferred) with current Windows updates; only as a temporary bridge, relax enforcement via the 'Encryption Oracle Remediation' GPO, and revert once both sides are patched."),
("errorcode","Windows Search/Outlook search broken, event log full of ESENT error 455 about a missing log file",
 "ESENT 455 means a database engine log file was deleted while its database was still marked dirty -- a cleanup tool removed Windows.edb transaction logs, leaving the search index unable to recover.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='ESENT'; Id=455} -MaxEvents 2","Error -1811 opening logfile C:\\ProgramData\\Microsoft\\Search\\Data\\...\\edb00042.log","")],
 "Stop WSearch, delete the search Data folder contents so the index rebuilds from scratch, restart the service, and exclude the search database path from cleanup tools."),
("errorcode","Scheduled task fails with 0x1 exit code but runs fine manually",
 "Exit code 0x1 from a scheduled task that works interactively almost always means an environment difference: the task runs as SYSTEM with no network drive mappings, and the script references a mapped drive letter only the interactive user has.",
 [("Get-ScheduledTask -TaskName 'NightlyExport' | Select-Object -ExpandProperty Principal | Select-Object UserId, LogonType","UserId  LogonType\n------  ---------\nSYSTEM  ServiceAccount","")],
 "Replace mapped drive letters with full UNC paths in the script, and set the task's 'Start in' directory explicitly; grant the run-as account NTFS access to the UNC target."),
("errorcode","Printing fails with error 0x0000011B on a shared network printer",
 "0x0000011B stems from the PrintNightmare-era RPC authentication hardening: the print server enforces packet privacy while the client-side connection was established before the fix, so the mismatch rejects the job.",
 [("Get-Printer '\\\\printsrv\\HP-Floor2' | Select-Object Name, PrinterStatus","Name                     PrinterStatus\n----                     -------------\n\\\\printsrv\\HP-Floor2     Error","")],
 "Update both client and print server fully with current Windows updates, then remove and re-add the printer connection; avoid registry workarounds that disable RPC authentication hardening."),
("errorcode","Windows Backup (wbadmin) fails with 0x8078002A on a large external drive",
 "0x8078002A occurs when block-level backup hits a target using 4K-native sectors that the backup engine can't handle -- the external drive reports 4096-byte logical sectors, which wbadmin's VHD format doesn't support.",
 [("Get-Disk 2 | Select-Object FriendlyName, LogicalSectorSize, PhysicalSectorSize","FriendlyName LogicalSectorSize PhysicalSectorSize\n------------ ------------------ -------------------\nSeagate Exp.               4096                4096","")],
 "Use a 512-byte-emulation (512e) drive as the backup target, check the drive vendor's tool for a sector-emulation mode, or switch to File History/a third-party imaging tool that supports 4Kn targets."),
("errorcode","Domain join fails with error 0x6D9 'There are no more endpoints available from the endpoint mapper'",
 "0x6D9 during domain join means the client reached the DC for the initial lookup but the follow-up RPC connection to the domain controller's dynamic ports was blocked by a firewall between them.",
 [("Test-NetConnection dc01.corp.local -Port 135","TcpTestSucceeded : True",""),
  ("Test-NetConnection dc01.corp.local -Port 49155","TcpTestSucceeded : False","")],
 "Open the dynamic RPC port range (49152-65535 by default) between client and domain controllers on the intervening firewall, or configure a static RPC port range per Microsoft's guidance if broad ranges aren't allowed."),
]

skipped = []
base_time2 = datetime(2026, 7, 30, 9, 0, 0)
i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goals:
        skipped.append(goal)
        continue
    created = base_time2 + timedelta(minutes=5 * i)
    i += 1
    steps = [{"command": c, "blocked": False, "exitCode": 0, "stdout": o, "stderr": e, "reason": None} for c, o, e in commands]
    entry = {
        "id": next_id(),
        "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal,
        "domain": domain,
        "plan": ["Identify what the specific error code means in this context", "Confirm the root cause with read-only checks", "Apply the appropriate fix or escalation"],
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

print("Error-code entries added:", i, "Skipped:", skipped)
print("Total JSON entries:", len(data))
print("Total JSONL lines:", len(jsonl_lines))

# Full validation
ids = [d["id"] for d in data]
assert len(ids) == len(set(ids)), "dup ids"
goals = [d["goal"] for d in data]
assert len(goals) == len(set(goals)), "dup goals"
with open(JSONL_PATH, encoding="utf-8") as f:
    ulines = [json.loads(l) for l in f if l.strip()]
users = [o["messages"][1]["content"] for o in ulines]
assert len(users) == len(set(users)), "dup prompts"
json_goals = set(goals)
missing = set(users) - json_goals
print("jsonl prompts missing from json:", len(missing))
print("json goals missing from jsonl:", len(json_goals - set(users)))
print("All validation passed")
