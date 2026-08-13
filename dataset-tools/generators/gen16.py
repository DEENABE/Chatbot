import json, collections
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

# ===========================================================================
# PART 1: fix the real issues the verification report found on a real machine
# ===========================================================================
CMD_FIXES = {
  # -Profile is not a parameter of Set-NetFirewallProfile; -All / -Name is.
  "Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True":
    "Set-NetFirewallProfile -All -Enabled True",
  # -AcceptLicense only exists in PowerShellGet 2.x; inbox PS 5.1 has 1.0.0.1
  "Install-Module PSWindowsUpdate -Scope AllUsers -Force -AcceptLicense":
    "Install-Module PSWindowsUpdate -Scope AllUsers -Force",
  # -SkipCertificateCheck is PowerShell 7+ only; make it 5.1-safe
  "(Invoke-WebRequest https://rdgw.company.com -SkipCertificateCheck).BaseResponse.RequestMessage.RequestUri":
    "$r=[Net.HttpWebRequest]::Create('https://rdgw.company.com'); $r.GetResponse(); $r.ServicePoint.Certificate.Subject",
}

with open(JSON_PATH, encoding="utf-8") as f: data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f: jsonl_lines = [l for l in f if l.strip()]

fixed_json = 0
for d in data:
    for s in d["steps"]:
        if s["command"] in CMD_FIXES:
            s["command"] = CMD_FIXES[s["command"]]; fixed_json += 1

fixed_jsonl = 0
tmp = []
for l in jsonl_lines:
    o = json.loads(l)
    c = o["messages"][2]["content"]
    for old, new in CMD_FIXES.items():
        if old in c:
            c = c.replace(old, new); fixed_jsonl += 1
    o["messages"][2]["content"] = c
    tmp.append(json.dumps(o, ensure_ascii=False) + "\n")
jsonl_lines = tmp
print(f"[FIX] verified-real issues corrected: {fixed_json} json steps, {fixed_jsonl} jsonl")

# ===========================================================================
# PART 2: new data
# ===========================================================================
NEW = [
# ---- Task Scheduler ----
("taskscheduler","A scheduled task shows 'Running' forever and never completes",
 "The task launched a process that waits on input; Task Scheduler has no timeout configured, so the instance stays Running indefinitely and blocks the next scheduled run.",
 [("Get-ScheduledTask -TaskName 'DailyExport' | Get-ScheduledTaskInfo | Select-Object LastRunTime, LastTaskResult, NumberOfMissedRuns",0,"LastRunTime: 8/1/2026 2:00 AM  LastTaskResult: 267009  NumberOfMissedRuns: 3",""),
  ("Get-ScheduledTask -TaskName 'DailyExport' | Select-Object -ExpandProperty Settings | Select-Object ExecutionTimeLimit",0,"ExecutionTimeLimit : PT0S (no limit)","")],
 "Result 267009 means 'task is currently running'. Set an ExecutionTimeLimit (e.g. PT1H) so stuck instances are killed, and add -NonInteractive/-NoProfile to PowerShell actions so they never wait on input."),
("taskscheduler","Task result 0x41303 -- 'Task has not yet run' even though the trigger time passed",
 "0x41303 means the task never actually started; its trigger is enabled but the task is configured to run only when a specific user is logged on, and nobody was signed in at that time.",
 [("Get-ScheduledTask -TaskName 'Cleanup' | Get-ScheduledTaskInfo | Select-Object LastTaskResult, NextRunTime",0,"LastTaskResult: 267011  NextRunTime: 8/5/2026 2:00 AM",""),
  ("Get-ScheduledTask -TaskName 'Cleanup' | Select-Object -ExpandProperty Principal | Select-Object LogonType, UserId",0,"LogonType: Interactive  UserId: CORP\\jdoe","")],
 "Change the principal to 'Run whether user is logged on or not' (Password or S4U logon type); Interactive tasks silently skip when the user isn't signed in."),
("taskscheduler","Task returns 0x2 'The system cannot find the file specified' though the script exists",
 "The action's program path is correct but the 'Start in' field is empty, so relative paths inside the script resolve against system32 and the referenced file isn't found there.",
 [("Get-ScheduledTask -TaskName 'Report' | Select-Object -ExpandProperty Actions | Select-Object Execute, Arguments, WorkingDirectory",0,"Execute: powershell.exe  Arguments: -File .\\report.ps1  WorkingDirectory: (empty)","")],
 "Use absolute paths in the Arguments and set WorkingDirectory explicitly; 0x2 from a task that runs fine manually is almost always a working-directory assumption."),
# ---- More Event IDs ----
("eventlog","Event ID 1076 asks for a shutdown reason after every unexpected restart",
 "Shutdown Event Tracker is enabled (default on Server), so Windows records Event 1076 with whatever reason is supplied after an unplanned restart -- it's an audit record, not a fault.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1076} -MaxEvents 3 | Select-Object TimeCreated",0,"3 entries following unplanned restarts",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\Reliability' -Name ShutdownReasonUI -ErrorAction SilentlyContinue",0,"ShutdownReasonUI : 1","")],
 "Keep it on servers for change auditing; on workstations it can be disabled via the 'Display Shutdown Event Tracker' policy. Pair 1076 with Event 41 to separate crashes from clean but unplanned restarts."),
("eventlog","Event ID 6013 shows uptime -- using it to prove whether a server actually rebooted",
 "Event 6013 is logged daily with the system uptime in seconds; comparing consecutive entries shows exactly when uptime reset, which proves a reboot happened even if nothing else was logged.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=6013} -MaxEvents 4 | Select-Object TimeCreated, Message",0,"The system uptime is 259200 seconds / previous entry 172800 seconds",""),
  ("(Get-CimInstance Win32_OperatingSystem).LastBootUpTime",0,"8/1/2026 3:14:22 AM","")],
 "Use 6013 for uptime history when Event 41/1074 were cleared; a sudden drop in the reported uptime between daily entries is unambiguous proof of a restart in that window."),
("eventlog","Event ID 6005/6006 pairs help identify how long a machine was actually down",
 "6005 (Event Log service started) and 6006 (stopped) bracket each session; the gap between a 6006 and the next 6005 is the true downtime, and a missing 6006 means the shutdown was not clean.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=6005,6006} -MaxEvents 6 | Select-Object TimeCreated, Id | Sort-Object TimeCreated",0,"6006 at 22:14, 6005 at 22:19 (5 min downtime); later 6005 with no preceding 6006","")],
 "A 6005 without a matching 6006 before it indicates an unclean shutdown -- correlate with Event 41 and 1001 to determine whether it was power loss or a bugcheck."),
("eventlog","Event ID 4732 shows someone was added to the local Administrators group",
 "4732 records group membership additions including who did it and which group; here a non-IT account added itself to Administrators, which warrants investigation rather than a routine fix.",
 [("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4732} -MaxEvents 3 | Select-Object -ExpandProperty Message",0,"Group: Administrators  Member: CORP\\contractor1  Subject: CORP\\contractor1",""),
  ("Get-LocalGroupMember -Group Administrators | Select-Object Name, PrincipalSource",0,"CORP\\contractor1  ActiveDirectory","")],
 "Remove the unauthorized member, then investigate how that account obtained the rights to add itself (check 4672/4624 around the same time); treat self-elevation as a potential compromise indicator."),
("eventlog","Event ID 104 shows an event log was cleared -- a common anti-forensics signal",
 "Event 104 (or 1102 for the Security log) records log clearing along with the account that did it; unexplained clearing is a recognized indicator of attempted evidence removal.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=104} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"The System log file was cleared. Subject: WORKSTATION\\localadmin",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=1102} -MaxEvents 2 -ErrorAction SilentlyContinue",0,"The audit log was cleared","")],
 "If nobody authorized the clearing, treat it as an incident: preserve remaining logs, check for forwarded copies on a SIEM, and audit that account's recent activity -- 104/1102 survive the clear itself by design."),
# ---- Everyday practical ----
("network","Ethernet negotiates only 100 Mbps on a gigabit switch and port",
 "The link trained at 100 Mbps full duplex despite gigabit capability at both ends, which almost always means one or more pairs in the cable are faulty -- gigabit needs all four pairs, 100 Mbps needs only two.",
 [("Get-NetAdapter -Name Ethernet | Select-Object LinkSpeed, FullDuplex",0,"LinkSpeed: 100 Mbps  FullDuplex: True",""),
  ("Get-NetAdapterAdvancedProperty -Name Ethernet -DisplayName 'Speed*' | Select-Object DisplayValue",0,"DisplayValue : Auto Negotiation","")],
 "Replace the patch cable with a known-good Cat5e/Cat6 and try another switch port; forcing 1 Gbps in the driver on a damaged cable produces link flapping rather than a working gigabit link."),
("network","Internet works but is very slow only on this PC while other devices are fine",
 "Receive Window Auto-Tuning was disabled by an old 'speed tweak', capping TCP throughput on high-latency connections while other devices with defaults perform normally.",
 [("netsh int tcp show global",0,"Receive Window Auto-Tuning Level : disabled",""),
  ("Get-NetTCPSetting -SettingName Internet | Select-Object AutoTuningLevelLocal",0,"AutoTuningLevelLocal : Disabled","")],
 "Restore the default with 'netsh int tcp set global autotuninglevel=normal'; disabling auto-tuning is an old Windows XP-era tip that actively harms modern connections."),
("performance","Machine is slow right after login for a few minutes then becomes fine",
 "Startup applications plus a Defender scheduled scan both run at logon and compete for the same disk, and the machine recovers as soon as they finish -- the steady state is healthy.",
 [("Get-CimInstance Win32_StartupCommand | Measure-Object | Select-Object Count",0,"Count : 17",""),
  ("Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\Windows Defender\\' | Get-ScheduledTaskInfo | Select-Object TaskName, LastRunTime",0,"Windows Defender Scheduled Scan  (runs at logon)","")],
 "Trim startup apps in Task Manager and move the Defender scheduled scan to a fixed idle time rather than logon; on an HDD this pattern is normal and an SSD upgrade removes it entirely."),
("storage","SSD is nearly full and the whole system becomes slow",
 "The drive is above ~95% used, which leaves the SSD controller almost no spare blocks for wear leveling and garbage collection, causing write amplification and severe slowdowns.",
 [("Get-Volume -DriveLetter C | Select-Object Size, SizeRemaining",0,"Size: 476 GB  SizeRemaining: 9 GB",""),
  ("Get-PhysicalDisk | Select-Object MediaType, HealthStatus",0,"SSD  Healthy","")],
 "Free space until at least 10-15% remains free; SSD performance degradation from a nearly-full drive is expected controller behavior, not a fault, and it reverses as soon as space is freed."),
("windows","Windows Search finds apps but not file contents",
 "Content indexing is limited to the default locations, and the folders being searched aren't in the index -- filenames still match because Explorer falls back to a direct scan, but content search requires the index.",
 [("Get-Service WSearch | Select-Object Status",0,"Status : Running",""),
  ("Get-CimInstance -Namespace root/cimv2 -ClassName Win32_Volume -Filter \"DriveLetter='D:'\" | Select-Object IndexingEnabled",0,"IndexingEnabled : False","")],
 "Add the folders under Indexing Options > Modify and enable 'Index this drive' on the volume, then allow the initial index build to complete before judging results."),
("printer","Printer prints a blank page before or after every document",
 "The driver's separator/banner page setting is enabled, so the spooler emits an extra page per job by design rather than the printer misfeeding.",
 [("Get-Printer -Name 'HP LaserJet' | Select-Object Name, SeparatorPageFile",0,"SeparatorPageFile : C:\\Windows\\System32\\sysprint.sep","")],
 "Clear the separator page in Printer Properties > Advanced > Separator Page; if the extra page persists with no separator configured, it's a PostScript/PCL driver mismatch instead."),
("audio","Microphone volume automatically drops during calls",
 "An application has exclusive-mode control and is applying automatic gain control, lowering the input level; Windows honors the app's request because exclusive mode is permitted on this device.",
 [("Get-CimInstance Win32_SoundDevice | Select-Object Name, Status",0,"Realtek(R) Audio  OK","")],
 "Uncheck 'Allow applications to take exclusive control of this device' in the microphone's Advanced properties, and disable the calling app's own automatic microphone adjustment setting."),
("security","Defender exclusions were added by someone else and nobody knows what they cover",
 "Reviewing the exclusion lists shows broad path exclusions covering entire drives, which effectively disables real-time protection for those locations -- a common malware persistence technique as well as a misconfiguration.",
 [("Get-MpPreference | Select-Object -ExpandProperty ExclusionPath",0,"C:\\\nD:\\Downloads",""),
  ("Get-MpPreference | Select-Object -ExpandProperty ExclusionProcess",0,"powershell.exe","")],
 "Remove overly broad exclusions immediately (a whole-drive exclusion and a powershell.exe process exclusion are both red flags), then run a full offline scan and audit who added them via Event 5007."),
("boot","Dual-boot menu disappeared after a Windows update and it boots straight into Windows",
 "The update rewrote the boot manager's default entry and set the timeout to zero, so the other OS entry still exists but the menu is never displayed.",
 [("bcdedit /enum",0,"Windows Boot Manager: timeout 0; two osloader entries present",""),
  ("bcdedit /timeout 10",0,"The operation completed successfully.","")],
 "Restore the timeout as shown and set the preferred default with 'bcdedit /default {identifier}'; the second OS was never removed, only hidden by a zero timeout."),
("hardware","Laptop screen flickers only on battery power",
 "Panel Self Refresh / display power saving activates on battery and this panel-driver combination flickers when it engages -- it disappears on AC because the feature is disabled there.",
 [("powercfg /getactivescheme",0,"Balanced",""),
  ("Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion",0,"Intel Iris Xe  31.0.101.4502","")],
 "Disable Panel Self Refresh / 'Display Power Saving Technology' in the GPU vendor's control panel, and update the graphics driver -- this is a known panel/driver interaction rather than failing hardware."),
# ---- More error codes ----
("errorcode","App install fails with error 0x80070666 'Another version of this product is already installed'",
 "0x80070666 means an MSI with the same upgrade code is present, and the new package isn't configured to upgrade it -- the existing install must be removed first.",
 [("Get-CimInstance Win32_Product -Filter \"Name LIKE '%AppName%'\" | Select-Object Name, Version, IdentifyingNumber",0,"AppName 3.1.0  {A1B2C3D4-...}","")],
 "Uninstall the existing version first (use the vendor's uninstaller or 'msiexec /x {ProductCode}'), then install; note Win32_Product queries trigger MSI reconfiguration, so prefer the registry Uninstall keys for inventory."),
("errorcode","Windows Update fails with 0x800f0922 on a machine with plenty of free space",
 "0x800f0922 usually means the System Reserved partition is too small, but here it's caused by the update being unable to reach the endpoints it needs while a VPN is active.",
 [("Get-Partition | Where-Object IsSystem | Select-Object Size",0,"Size : 524288000 (500 MB, adequate)",""),
  ("Test-NetConnection windowsupdate.microsoft.com -Port 443",1,"","TcpTestSucceeded : False")],
 "Disconnect the VPN (or exclude Windows Update endpoints from it) and retry; when the reserved partition is adequate, 0x800f0922 points to connectivity to the update/CBS endpoints instead."),
("errorcode","Copy fails with 0x800700DF 'The file size exceeds the limit allowed'",
 "0x800700DF comes from the WebDAV redirector's file-size limit when copying to a mapped WebDAV/SharePoint drive -- the default cap is 50 MB regardless of available space.",
 [("Get-Service WebClient | Select-Object Status",0,"Status : Running",""),
  ("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters' -Name FileSizeLimitInBytes -ErrorAction SilentlyContinue",0,"FileSizeLimitInBytes : 50000000","')")],
 "Raise FileSizeLimitInBytes (max 0xFFFFFFFF) and restart the WebClient service, or better, upload large files through the SharePoint/OneDrive client rather than the WebDAV drive mapping."),
("errorcode","Service install fails with error 1072 'The specified service has been marked for deletion'",
 "1072 means a delete request is pending because a handle to the service is still open -- typically services.msc or a monitoring tool holding it, which blocks reinstalling under the same name.",
 [("Get-Service AppAgent -ErrorAction SilentlyContinue | Select-Object Status",0,"Status : Stopped",""),
  ("Get-Process mmc -ErrorAction SilentlyContinue | Select-Object Id, MainWindowTitle",0,"5120  Services","')")],
 "Close every services.msc/MMC window and any monitoring console holding the service, then retry; if it persists, a reboot completes the pending deletion and frees the name."),
("errorcode","Network drive mapping fails with error 1219 after a password change",
 "The saved credential for that server no longer matches, and Windows refuses a second credential set to the same server, so the mapping fails with a conflict rather than a bad-password error.",
 [("net use",0,"OK  Z:  \\\\fs01\\data  (using old cached credential)",""),
  ("cmdkey /list | Select-String 'fs01'",0,"Target: Domain:target=fs01","')")],
 "Delete the stale credential ('cmdkey /delete:fs01'), disconnect the old mapping ('net use Z: /delete'), then reconnect so the current password is stored."),
("errorcode","Application fails with 0x8007007E 'The specified module could not be found'",
 "0x8007007E means a DLL the application loads at startup is missing from its search path -- here a Visual C++ runtime dependency was never installed on this machine.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000} -MaxEvents 1 | Select-Object -ExpandProperty Message",0,"Faulting module path: MSVCP140.dll (not found)",""),
  ("Get-ChildItem C:\\Windows\\System32\\MSVCP140.dll -ErrorAction SilentlyContinue",1,"","(file not present)")],
 "Install the matching Visual C++ Redistributable (x64 and x86 both, if unsure); 0x8007007E from an app launch is nearly always a missing runtime rather than a corrupted install."),
("errorcode","Remote PowerShell fails with 0x80338012 'The WinRM client cannot complete the operation within the specified time'",
 "0x80338012 is a WinRM timeout; the target is reachable but its WinRM service is slow to respond because it's under heavy load, so the default 60-second operation timeout is exceeded.",
 [("Test-NetConnection srv07 -Port 5985",0,"TcpTestSucceeded : True",""),
  ("Test-WSMan srv07 -ErrorAction SilentlyContinue",1,"","The WinRM client cannot complete the operation within the time specified")],
 "Raise the client timeout for that session ('New-PSSessionOption -OperationTimeout 180000') and investigate why the target is loaded; a WinRM timeout with a healthy TCP connect is a server-side responsiveness problem."),
("errorcode","Windows activation fails with 0xC004C003 'The activation server determined the specified product key has been blocked'",
 "0xC004C003 means Microsoft's activation service has blocked this key -- typically a key that was resold, leaked, or exceeded its activation count, not a technical fault on the machine.",
 [("slmgr /dlv",0,"Partial Product Key: XXXXX  License Status: Notification",""),
  ("Get-CimInstance SoftwareLicensingProduct -Filter \"PartialProductKey IS NOT NULL\" | Select-Object LicenseStatus, LicenseStatusReason",0,"LicenseStatus : 5 (Notification)","")],
 "No local fix exists -- obtain a legitimate key through a Microsoft-authorized channel; repeatedly retrying activation or using activation 'tools' will not clear a server-side block."),
# ---- Advanced multi-signal ----
("performance-advanced","A file server's SMB clients see slow transfers only for small files, large files are fast",
 "Throughput is fine, so bandwidth isn't the constraint -- the bottleneck is per-operation latency, and the metadata round trips required for many small files multiply that latency while a single large file amortizes it.",
 [("Get-SmbClientNetworkInterface | Select-Object LinkSpeed, RssSupport, RdmaCapable",0,"10 Gbps  True  False",""),
  ("Test-NetConnection fileserver -Port 445 -InformationLevel Detailed",0,"PingReplyDetails RoundtripTime : 24 ms","")],
 "24 ms RTT is the real limit for small-file workloads. Use robocopy /MT for parallelism, enable SMB Multichannel, or stage small files into an archive before transfer -- more bandwidth won't help latency-bound patterns."),
("security-incident","A scheduled task, a service, and a Run key all point at the same unknown executable",
 "Three independent persistence mechanisms referencing one binary is not a coincidence; that redundancy pattern is characteristic of malware ensuring it survives partial cleanup.",
 [("Get-ScheduledTask | Where-Object {$_.Actions.Execute -match 'winupd'} | Select-Object TaskName",0,"TaskName : SystemUpdateHelper",""),
  ("Get-CimInstance Win32_Service | Where-Object PathName -match 'winupd' | Select-Object Name, PathName",0,"WinUpdSvc  C:\\ProgramData\\winupd.exe",""),
  ("Get-CimInstance Win32_StartupCommand | Where-Object Command -match 'winupd' | Select-Object Name, Location",0,"winupd  HKCU\\...\\Run","")],
 "Treat as an active incident: isolate the machine first, capture the binary and all three persistence artifacts for analysis, then rebuild rather than clean -- partial removal of redundant persistence usually fails."),
("dns-advanced","Some clients resolve an internal name correctly while others get the public address",
 "The clients getting the public answer are using a different DNS server that has no internal zone, so they fall through to public resolution -- a split-horizon inconsistency rather than a record error.",
 [("Resolve-DnsName portal.company.com -Server 10.0.0.10",0,"IPAddress : 10.0.5.40 (internal)",""),
  ("Resolve-DnsName portal.company.com -Server 8.8.8.8",0,"IPAddress : 203.0.113.55 (public)",""),
  ("Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, ServerAddresses",0,"Wi-Fi  {8.8.8.8}","")],
 "Point all internal clients at the internal DNS servers via DHCP rather than hardcoded public resolvers; split-horizon DNS only works when every internal client queries the internal zone."),
("hyperv","VM performance degrades sharply when host memory is overcommitted",
 "Dynamic Memory is reclaiming pages from running VMs because assigned memory across all VMs exceeds physical RAM, so guests page to disk while the host reports healthy CPU.",
 [("Get-VM | Select-Object Name, MemoryAssigned, MemoryDemand, State",0,"VM1 4GB/6GB demand; VM2 8GB/9GB demand (host has 16GB)",""),
  ("Get-Counter '\\Hyper-V Dynamic Memory Balancer(*)\\Available Memory' -MaxSamples 1",0,"Available Memory : 210 MB","")],
 "Reduce the number of running VMs or lower their maximum memory so total demand fits physical RAM with headroom for the host; Dynamic Memory redistributes pressure, it cannot create memory."),
("iis","Application pool recycles constantly and users lose sessions",
 "The pool is recycling on its private-memory limit far more often than the configured interval, so in-process sessions are discarded each time -- a memory-limit problem, not a scheduled recycle.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WAS'; Id=5117} -MaxEvents 5 | Select-Object TimeCreated",0,"5 recycles in the last hour",""),
  ("Get-ItemProperty 'IIS:\\AppPools\\AppPool01' -Name Recycling.periodicRestart.privateMemory",0,"Value : 512000 (500 MB)","")],
 "Raise the private-memory limit to match the app's real working set and move session state out-of-process (SQL/Redis) so recycles stop destroying sessions; investigate the memory growth separately."),
("activedirectory","Group membership changes don't take effect until the user signs out and back in",
 "Group memberships are written into the access token at logon, so a token issued before the change simply doesn't contain the new group -- this is by design, not a replication delay.",
 [("whoami /groups | Select-String 'FinanceTeam'",1,"","(group not present in current token)"),
  ("Get-ADUser jdoe -Properties MemberOf | Select-Object -ExpandProperty MemberOf",0,"CN=FinanceTeam,OU=Groups,DC=corp,DC=local","")],
 "Sign out and back in (or reboot for computer-group changes); 'gpupdate /force' refreshes policy but never rebuilds an existing token, which is why it appears not to help."),
("wsl","Files created in WSL have wrong permissions when accessed from Windows",
 "The distro's mount options don't set metadata support, so Linux permission bits aren't stored on the Windows file system and everything appears as 777 from Linux and default ACLs from Windows.",
 [("wsl cat /etc/wsl.conf",1,"","(no wsl.conf present)"),
  ("wsl ls -la /mnt/c/projects",0,"drwxrwxrwx 1 root root ... (all files 777)","")],
 "Create /etc/wsl.conf with '[automount]\\noptions = \"metadata,umask=22,fmask=11\"' and run 'wsl --shutdown'; keep Linux-heavy project files inside the Linux filesystem (~/) for correct permissions and much better performance."),
("aidev","GPU is detected but training runs far slower than expected on Windows",
 "The framework is running but falling back to a slower execution path because the GPU's compute capability isn't supported by the installed build, so operations execute on a compatibility kernel.",
 [("nvidia-smi --query-gpu=name,compute_cap --format=csv",0,"NVIDIA GeForce GTX 1650, 7.5",""),
  ("python -c \"import torch; print(torch.cuda.get_device_capability())\"",0,"(7, 5)","")],
 "Install a framework build compiled for your compute capability, close other GPU consumers (browser hardware acceleration is a common one), and verify the GPU is in the high-performance power mode rather than optimal-power."),
("backup","Restoring a single file from a system image is far harder than expected",
 "System images are block-level VHDX containers, so they restore whole volumes rather than individual files -- extracting one file requires mounting the VHDX manually.",
 [("Get-ChildItem 'E:\\WindowsImageBackup\\PC01\\Backup*' -Filter '*.vhdx' -Recurse | Select-Object Name, Length",0,"c8f3...vhdx  248 GB","")],
 "Mount the VHDX (Disk Management > Attach VHD, read-only) and copy the file out; for regular single-file recovery use File History or a file-level backup tool instead of system images."),
]

existing_ids = set(d["id"] for d in data)
existing_goals = set(d["goal"] for d in data)
prefix_index = collections.defaultdict(list)
for g in existing_goals: prefix_index[' '.join(g.lower().split()[:4])].append(g)

n = 1
def next_id():
    global n
    while True:
        cand = f"new-win-repair-{n:03d}"; n += 1
        if cand not in existing_ids:
            existing_ids.add(cand); return cand

skipped, near = [], []
base_time = datetime(2026, 8, 4, 14, 0, 0); i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goals: skipped.append(goal); continue
    key = ' '.join(goal.lower().split()[:4])
    if key in prefix_index: near.append((goal, prefix_index[key][0]))
    created = base_time + timedelta(minutes=5*i); i += 1
    steps = [{"command": c, "blocked": False, "exitCode": ec, "stdout": o, "stderr": e, "reason": None} for c, ec, o, e in commands]
    data.append({
        "id": next_id(), "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal, "domain": domain,
        "plan": ["Collect the evidence this class of problem produces",
                 "Separate the true root cause from surface symptoms",
                 "Apply the correct fix or explain the expected behavior"],
        "steps": steps, "resolved": True, "summary": summary, "recommendation": recommendation,
        "feedback": {"worked": True, "note": "", "at": (created+timedelta(minutes=3)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}})
    existing_goals.add(goal); prefix_index[key].append(goal)
    cmd_lines = "\n".join(f"- {c[0]}" + ("  [FAILED: "+c[3][:70]+"]" if c[1]!=0 else "") for c in commands)
    jsonl_lines.append(json.dumps({"messages":[
        {"role":"system","content":f"You are a Windows repair expert specializing in {domain} problems. Diagnose with read-only commands first, then apply safe fixes. When a command fails, interpret the error and adapt."},
        {"role":"user","content":goal},
        {"role":"assistant","content":f"{summary}\nCommands used:\n{cmd_lines}\nRecommendation: {recommendation}"}]}, ensure_ascii=False)+"\n")

with open(JSON_PATH,"w",encoding="utf-8") as f: json.dump(data,f,indent=2,ensure_ascii=False); f.write("\n")
with open(JSONL_PATH,"w",encoding="utf-8") as f: f.writelines(jsonl_lines)

print(f"[ADD] new entries: {i} | exact dups skipped: {len(skipped)} | near collisions: {len(near)}")
for a,b in near: print("   NEAR:", a[:60], "<>", b[:60])
print("Total JSON:", len(data), "| Total JSONL:", len(jsonl_lines))
ids=[d["id"] for d in data]; assert len(ids)==len(set(ids))
goals=[d["goal"] for d in data]; assert len(goals)==len(set(goals))
users=[json.loads(l)["messages"][1]["content"] for l in jsonl_lines]
assert len(users)==len(set(users)) and set(users)==set(goals)
print("Validation passed: unique + mirrored")
