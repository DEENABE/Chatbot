import json, collections
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

NEW = [
# ---- Windows 11 modern features ----
("windows","Windows Recall is missing or greyed out on a supported machine",
 "Recall requires a Copilot+ PC with an NPU plus device encryption and Windows Hello enrolled; the NPU is present but Hello enrolment is missing, so the feature stays unavailable.",
 [("Get-CimInstance Win32_Processor | Select-Object Name",0,"Snapdragon X Elite",""),
  ("Get-BitLockerVolume -MountPoint C: | Select-Object ProtectionStatus",0,"ProtectionStatus : Off","")],
 "Enable device encryption/BitLocker and enrol Windows Hello, then Recall becomes selectable; on non-Copilot+ hardware it is not available at all regardless of settings."),
("windows","Dev Drive cannot be created -- the option is unavailable in Settings",
 "Dev Drive requires the ReFS-based storage feature and a minimum free space; here the build predates Dev Drive support, so the creation flow never appears.",
 [("Get-CimInstance Win32_OperatingSystem | Select-Object BuildNumber",0,"BuildNumber : 22621",""),
  ("Get-Volume | Where-Object FileSystem -eq 'ReFS' | Measure-Object | Select-Object Count",0,"Count : 0","")],
 "Update to a build that supports Dev Drive (22H2 with the relevant update or later), ensure at least 50 GB free, then create it from Settings > System > Storage > Disks & volumes."),
("windows","The new sudo command in Windows is not recognized",
 "Sudo for Windows is an opt-in developer feature; the binary exists on supported builds only after it is enabled in Settings, so the shell reports it as unknown until then.",
 [("Get-Command sudo -ErrorAction SilentlyContinue",1,"","(not found)"),
  ("Get-CimInstance Win32_OperatingSystem | Select-Object BuildNumber",0,"BuildNumber : 26100","")],
 "Enable it under Settings > System > For developers > Enable sudo; on older builds use 'Start-Process -Verb RunAs' instead, which achieves the same elevation."),
("windows","Copilot button opens a web page instead of the app",
 "The Copilot app package is not installed for this user, so the shell falls back to launching the web experience in the default browser.",
 [("Get-AppxPackage -Name '*Copilot*' -ErrorAction SilentlyContinue | Select-Object Name, Version",0,"(no package returned)","")],
 "Install the Copilot app from the Microsoft Store; in managed environments the package may be blocked by policy, in which case the web fallback is intentional."),
("windows","Windows Backup app will not back up settings for a work account",
 "The Windows Backup app syncs to a personal Microsoft account only; with a work/school account signed in as primary, the settings backup section is unavailable by design.",
 [("dsregcmd /status | Select-String 'AzureAdJoined|WorkplaceJoined'",0,"AzureAdJoined : YES","")],
 "Use Enterprise State Roaming or Intune configuration profiles for work devices; personal-account settings backup is not intended for organization-joined machines."),
("windows","Phone Link cannot send messages though calls work",
 "Messaging requires the companion app to hold SMS permission on the phone; calls use a separate Bluetooth profile, which is why one works while the other does not.",
 [("Get-AppxPackage -Name 'Microsoft.YourPhone' | Select-Object Name, Status",0,"Microsoft.YourPhone  Ok",""),
  ("Get-PnpDevice -Class Bluetooth | Where-Object FriendlyName -like '*Pixel*' | Select-Object Status",0,"Status : OK","")],
 "Grant SMS permission to the Link to Windows app on the phone and exclude it from battery optimization; the Bluetooth pairing alone only enables calling."),
# ---- Printing modern ----
("printer","Universal Print jobs stay queued and never reach the printer",
 "The client submits to the cloud service successfully, but the printer's connector has lost its registration, so nothing pulls the job down to the device.",
 [("Get-Printer | Where-Object Name -like '*UP*' | Select-Object Name, PrinterStatus, PortName",0,"HQ-Printer (UP)  Normal  UniversalPrint",""),
  ("Test-NetConnection print.print.microsoft.com -Port 443",0,"TcpTestSucceeded : True","")],
 "Re-register the Universal Print connector on the host machine and confirm the printer is still shared in the Universal Print portal; client-side reinstalls will not help when the connector is the broken link."),
("printer","IPP printing to a modern printer fails while the same printer works over its vendor driver",
 "The IPP Everywhere class driver negotiates a feature set the printer's firmware advertises but does not implement, so jobs fail at rendering rather than transmission.",
 [("Get-Printer -Name 'Office-IPP' | Select-Object DriverName, PortName",0,"DriverName : IPP Class Driver  PortName : http://10.0.3.20:631/ipp/print",""),
  ("Test-NetConnection 10.0.3.20 -Port 631",0,"TcpTestSucceeded : True","")],
 "Update the printer firmware, or install the vendor's own driver which matches its actual capabilities; IPP class driver problems are firmware-side and cannot be fixed on the client."),
("printer","Printer disappears from all clients after the print server is renamed",
 "Client connections store the server name, so a rename invalidates every mapped connection at once; the printers still exist on the server under the new name.",
 [("Get-Printer | Where-Object Name -like '\\\\*' | Select-Object Name, PrinterStatus",0,"\\\\OLDSRV\\HP-Floor2  Error",""),
  ("Test-NetConnection OLDSRV -Port 445",1,"","TcpTestSucceeded : False")],
 "Deploy the printers again by the new server name (Group Policy printer deployment handles this cleanly), and keep a DNS CNAME for the old name during transition to avoid mass breakage."),
# ---- Networking advanced ----
("network","Wired 802.1X authentication fails while wireless with the same credentials works",
 "The Wired AutoConfig service that performs 802.1X on Ethernet is stopped; wireless uses WLAN AutoConfig instead, which is why only the wired path fails.",
 [("Get-Service dot3svc | Select-Object Status, StartType",0,"Status : Stopped  StartType : Manual",""),
  ("Get-Service Wlansvc | Select-Object Status",0,"Status : Running","")],
 "Set dot3svc to Automatic and start it, then confirm the wired network profile has the correct authentication method; without this service the port simply never attempts 802.1X."),
("network","IPsec-protected traffic fails between two servers after a policy change",
 "The IKE and AuthIP service is running on both, but no matching security association is being established because the two sides now propose different authentication methods.",
 [("Get-Service IKEEXT | Select-Object Status",0,"Status : Running",""),
  ("Get-NetIPsecMainModeSA -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count : 0","")],
 "Compare the connection security rules on both hosts (Get-NetIPsecRule) - IPsec requires a matching proposal on both ends, and a one-sided policy change breaks the negotiation entirely."),
("network","A server is reachable by IP but its DNS name resolves to an old address",
 "A stale A record persists because the host's dynamic registration is failing, so DNS keeps serving the previous address until the record ages out.",
 [("Resolve-DnsName app01.corp.local | Select-Object Name, IPAddress",0,"app01.corp.local  10.0.2.15 (old)",""),
  ("Get-NetIPAddress -AddressFamily IPv4 | Where-Object InterfaceAlias -eq 'Ethernet' | Select-Object IPAddress",0,"10.0.2.61 (current)","")],
 "Force re-registration with 'ipconfig /registerdns' on the host and confirm the DNS zone allows secure dynamic updates from that account; enable scavenging so stale records expire automatically."),
("network","Only one machine on the LAN cannot reach the internet, and it has two default gateways",
 "Two adapters each supply a default route with the same metric, so traffic is load-balanced onto a path that has no internet access half the time.",
 [("Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object InterfaceAlias, NextHop, RouteMetric",0,"Ethernet 10.0.0.1 25 / Wi-Fi 192.168.1.1 25","")],
 "Remove the default gateway from the adapter that should not carry internet traffic, or raise its interface metric so the correct path always wins; two equal-metric default routes are never a stable configuration."),
# ---- Identity / directory ----
("activedirectory","Local Administrator Password Solution passwords are not rotating",
 "LAPS is configured by policy but the managed account is not being updated because the policy targets an account name that does not exist on these machines.",
 [("Get-LapsADPassword -Identity PC01 -ErrorAction SilentlyContinue | Select-Object Account, PasswordUpdateTime",0,"Account : LocalAdmin  PasswordUpdateTime : (never)",""),
  ("Get-LocalUser | Select-Object Name, Enabled",0,"Administrator  False / helpdesk  True","")],
 "Point the LAPS policy at an account that actually exists (or have it create the managed account), then force a policy refresh; LAPS silently does nothing when the target account is absent."),
("activedirectory","A service using a group Managed Service Account fails to start after a host rebuild",
 "The rebuilt host is no longer in the gMSA's PrincipalsAllowedToRetrieveManagedPassword list, so it cannot retrieve the password and the service fails authentication at startup.",
 [("Test-ADServiceAccount -Identity 'svc_app$'",0,"False",""),
  ("Get-ADServiceAccount 'svc_app' -Properties PrincipalsAllowedToRetrieveManagedPassword | Select-Object -ExpandProperty PrincipalsAllowedToRetrieveManagedPassword",0,"CN=OLD-HOST,...","")],
 "Add the new host to PrincipalsAllowedToRetrieveManagedPassword, reboot it so the ticket refreshes, then re-test with Test-ADServiceAccount before starting the service."),
("azuread","Users can sign in to some Microsoft 365 apps but not others",
 "The account is licensed but individual service plans are disabled, so apps whose plan is off reject the sign-in while others succeed normally.",
 [("Get-MgUserLicenseDetail -UserId jdoe@corp.com | Select-Object -ExpandProperty ServicePlans | Where-Object ProvisioningStatus -ne 'Success' | Select-Object ServicePlanName, ProvisioningStatus",0,"EXCHANGE_S_ENTERPRISE  Disabled","")],
 "Enable the required service plan on the assigned license in the admin centre; a per-app sign-in failure with a valid license is almost always a disabled service plan rather than an authentication fault."),
# ---- Security ----
("security","Attack Surface Reduction rules are blocking a legitimate line-of-business macro",
 "An ASR rule that blocks Office applications from creating child processes is matching the macro's behaviour; the block is by design and requires an exclusion rather than disabling the rule.",
 [("Get-MpPreference | Select-Object -ExpandProperty AttackSurfaceReductionRules_Ids",0,"D4F940AB-401B-4EFC-AADC-AD5F3C50688A",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1121} -MaxEvents 2",0,"ASR rule blocked Office from creating a child process","")],
 "Add a per-rule exclusion for the specific application path with Add-MpPreference -AttackSurfaceReductionOnlyExclusions, keeping the rule enforced for everything else."),
("security","Windows Firewall allows traffic that a rule should block",
 "An allow rule with higher precedence matches first; Windows Firewall evaluates block rules before allow rules only within the same scope, and this allow rule is more specific.",
 [("Get-NetFirewallRule -Enabled True -Direction Inbound | Where-Object DisplayName -like '*App*' | Select-Object DisplayName, Action",0,"Allow App  Allow / Block App Legacy  Block","")],
 "Delete or narrow the conflicting allow rule rather than adding more blocks; enumerate effective rules with Get-NetFirewallRule piped to Get-NetFirewallPortFilter to see exactly which one matches."),
("security","Credential Guard is on but LSA protection shows as not running",
 "These are separate protections: Credential Guard isolates secrets in VBS, while RunAsPPL protects the LSASS process itself, and only the former was enabled.",
 [("Get-CimInstance -Namespace root/Microsoft/Windows/DeviceGuard -ClassName Win32_DeviceGuard | Select-Object SecurityServicesRunning",0,"SecurityServicesRunning : {1}",""),
  ("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa' -Name RunAsPPL -ErrorAction SilentlyContinue",1,"","(value not present)")],
 "Enable RunAsPPL via policy for defence in depth, after confirming no legitimate security tooling needs to inject into LSASS - some older agents will stop working."),
# ---- Storage advanced ----
("storage","Data Deduplication savings drop to zero on a file server volume",
 "The optimization job has not run recently because its schedule was disabled, so newly written data is never deduplicated and reported savings stagnate.",
 [("Get-DedupStatus -Volume D: | Select-Object SavedSpace, LastOptimizationTime",0,"SavedSpace : 0  LastOptimizationTime : 2026-05-02",""),
  ("Get-DedupSchedule | Select-Object Name, Enabled, Type",0,"BackgroundOptimization  False  Optimization","")],
 "Re-enable the optimization schedule (or run Start-DedupJob -Type Optimization manually) and confirm the volume still meets dedup requirements; savings recover over subsequent job runs."),
("storage","Storage tiering never promotes hot data to the SSD tier",
 "The tier optimization task is disabled, so the heat map is collected but never acted on, leaving all data on the capacity tier regardless of access frequency.",
 [("Get-StorageTier | Select-Object FriendlyName, MediaType, Size",0,"SSD_Tier  SSD  480GB / HDD_Tier  HDD  8TB",""),
  ("Get-ScheduledTask -TaskName '*Storage Tiers Optimization*' | Select-Object State",0,"State : Disabled","")],
 "Enable the Storage Tiers Optimization scheduled task and run it once manually; tiering is a scheduled batch operation, not a real-time cache, so nothing moves without it."),
("storage","A volume reports free space that File Explorer and du disagree about",
 "Shadow copies and the recycle bin hold space that is allocated but not visible as files, which is why directory-based tools under-report usage against the volume's own figures.",
 [("Get-Volume -DriveLetter D | Select-Object Size, SizeRemaining",0,"Size : 2TB  SizeRemaining : 180GB",""),
  ("vssadmin list shadowstorage",0,"Used Shadow Copy Storage space: 412 GB","")],
 "Account for shadow storage and the per-user recycle bins when reconciling; cap shadow storage if it has grown beyond its intended share of the volume."),
# ---- Virtual desktop / cloud PC ----
("virtualization","An Azure Virtual Desktop session host stops accepting new sessions",
 "The host was put into drain mode during maintenance and never returned to normal, so the broker skips it while the host itself remains healthy.",
 [("Get-Service RDAgentBootLoader | Select-Object Status",0,"Status : Running",""),
  ("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections",0,"fDenyTSConnections : 0","")],
 "Clear drain mode on the session host in the AVD host pool (Set-AzWvdSessionHost -AllowNewSession $true); a healthy agent plus enabled RDP means the block is at the broker level."),
("virtualization","A Windows 365 Cloud PC disconnects repeatedly on a good connection",
 "The client is negotiating a transport that the network path drops; UDP-based shortpath is being blocked, so the session falls back and repeatedly re-establishes.",
 [("Test-NetConnection rdweb.wvd.microsoft.com -Port 443",0,"TcpTestSucceeded : True",""),
  ("Get-NetUDPEndpoint -LocalPort 3390 -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count : 0","")],
 "Allow UDP 3390 outbound for RDP Shortpath, or disable Shortpath so the session stays on TCP; intermittent disconnects with healthy TCP are the signature of a half-open UDP path."),
# ---- More BSOD ----
("bsod","Blue screen SYSTEM_PTE_MISUSE stop code 0x000000DA",
 "0xDA means a driver misused system page table entries, typically by mapping memory incorrectly; the parameters point at a virtual storage filter driver from backup software.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 1 | Select-Object -ExpandProperty Message",0,"0x000000da (..., vhdflt.sys)",""),
  ("Get-CimInstance Win32_SystemDriver | Where-Object Name -match 'vhdflt' | Select-Object Name, State, PathName",0,"vhdflt  Running","")],
 "Update or remove the named filter driver's product; 0xDA is almost always a third-party driver defect rather than a hardware or Windows fault."),
("bsod","Blue screen REFERENCE_BY_POINTER stop code 0x00000018",
 "0x18 means an object's reference count was decremented incorrectly, corrupting kernel object tracking - typically a driver releasing a handle it does not own.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"0x00000018 (repeat, no consistent module named)",""),
  ("verifier /standard /all",0,"Driver Verifier enabled for all drivers; reboot required","")],
 "Enable Driver Verifier across third-party drivers to force attribution on the next crash, then update or remove the identified driver and reset Verifier with 'verifier /reset'."),
("bsod","Blue screen SECURE_KERNEL_ERROR stop code 0x0000018B",
 "0x18B originates inside the VBS secure kernel; it is commonly triggered by a driver incompatible with memory integrity (HVCI) rather than by VBS itself being faulty.",
 [("Get-CimInstance -Namespace root/Microsoft/Windows/DeviceGuard -ClassName Win32_DeviceGuard | Select-Object VirtualizationBasedSecurityStatus, SecurityServicesRunning",0,"VirtualizationBasedSecurityStatus : 2  SecurityServicesRunning : {2}",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 1 | Select-Object -ExpandProperty Message",0,"0x0000018b","")],
 "Check Core Isolation for incompatible drivers listed by Windows Security, update them, and only disable memory integrity temporarily to confirm attribution - it is a significant protection to leave off."),
# ---- More error codes ----
("errorcode","Windows Update fails with 0x8007371B 'One or more required members of the transaction are not present'",
 "0x8007371B is a servicing transaction error meaning the component store is missing part of a pending transaction, so the update cannot complete or roll back cleanly.",
 [("DISM /Online /Cleanup-Image /ScanHealth",0,"The component store is repairable.",""),
  ("Test-Path 'C:\\Windows\\WinSxS\\pending.xml'",0,"True","")],
 "Run 'DISM /Online /Cleanup-Image /RestoreHealth' to repair the store; if pending.xml blocks it, revert the pending actions from WinRE first and then retry the repair."),
("errorcode","Service fails to install with error 1073 'The specified service already exists'",
 "1073 means a service with that name is registered even though it may be invisible in services.msc, typically left behind by an incomplete uninstall.",
 [("Get-Service AppAgent -ErrorAction SilentlyContinue",1,"","(not listed)"),
  ("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\AppAgent' -ErrorAction SilentlyContinue | Select-Object PSChildName",0,"AppAgent (registry key present)","")],
 "Remove the orphaned service registration with 'sc delete AppAgent' and reboot before reinstalling; the registry key is authoritative even when the service does not appear in the console."),
("errorcode","Application fails with 0x8007000E 'Not enough memory resources are available'",
 "0x8007000E is an out-of-memory HRESULT; the process is 32-bit and has exhausted its 2 GB address space while the machine still has ample free RAM.",
 [("Get-Process LegacyApp | Select-Object @{N='MB';E={[int]($_.WorkingSet64/1MB)}}",0,"MB : 1890",""),
  ("Get-CimInstance Win32_OperatingSystem | Select-Object @{N='FreeGB';E={[math]::Round($_.FreePhysicalMemory/1MB,1)}}",0,"FreeGB : 18.2","")],
 "Use a 64-bit build of the application if one exists, or reduce the working set (smaller datasets, fewer open documents); adding RAM cannot raise a 32-bit process's address space limit."),
("errorcode","Scheduled task fails with result 0x800710E0 'The operator or administrator has refused the request'",
 "0x800710E0 means the task was blocked by a condition rather than an error - here the 'Start only if on AC power' condition prevented it running on battery.",
 [("Get-ScheduledTask -TaskName 'NightlySync' | Select-Object -ExpandProperty Settings | Select-Object DisallowStartIfOnBatteries, StopIfGoingOnBatteries",0,"DisallowStartIfOnBatteries : True","")],
 "Clear the battery conditions on the task if it must run regardless of power state; 0x800710E0 is a condition refusal, not a failure of the task's own action."),
("errorcode","Copying to a network share fails with 0x800704B3 'The network path was either typed incorrectly or does not exist'",
 "0x800704B3 indicates no network provider accepted the path; the Workstation service is stopped, so the SMB redirector cannot handle UNC paths at all.",
 [("Get-Service LanmanWorkstation | Select-Object Status",0,"Status : Stopped",""),
  ("Test-NetConnection fileserver -Port 445",0,"TcpTestSucceeded : True","")],
 "Start the Workstation service and set it to Automatic; reachable port 445 with an unusable UNC path is the signature of a stopped or broken redirector rather than a network problem."),
# ---- More services / internals ----
("services","Windows Push Notification service failures break toast notifications for all apps",
 "WpnService delivers every toast; with it stopped, apps generate notifications successfully but nothing is displayed, which looks like an app problem across the board.",
 [("Get-Service WpnService | Select-Object Status, StartType",0,"Status : Stopped  StartType : Automatic",""),
  ("Get-Service WpnUserService* | Select-Object Name, Status",0,"WpnUserService_4a2f1  Stopped","")],
 "Start WpnService and its per-user instance; if it will not start, the notification platform database under the user profile may need rebuilding by recreating the profile."),
("services","Storage Service being stopped breaks Settings pages and Storage Sense",
 "StorSvc backs the storage-related Settings surfaces; with it stopped those pages fail to render data and Storage Sense never runs, though the disks themselves are fine.",
 [("Get-Service StorSvc | Select-Object Status, StartType",0,"Status : Stopped  StartType : Manual",""),
  ("Get-Volume | Select-Object DriveLetter, HealthStatus",0,"C  Healthy","")],
 "Start StorSvc (it is trigger-started by design, so leave it on Manual) and reopen Settings; disks reporting healthy while the UI is blank points at the service, not the storage."),
("internals","Windows Search indexer runs constantly and never reaches an idle state",
 "The index keeps restarting because a folder in scope contains files the indexer repeatedly fails to parse, so it never completes a full pass.",
 [("Get-Service WSearch | Select-Object Status",0,"Status : Running",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-Search'} -MaxEvents 3",0,"The protocol handler could not be loaded for a file in the indexed scope","")],
 "Exclude the problematic folder from indexing (or install the correct iFilter for that file type), then rebuild the index; an indexer that never idles is nearly always looping on unparseable content."),
# ---- Backup / recovery ----
("backup","Windows Server Backup completes with warnings and some files are always skipped",
 "The skipped files are open with exclusive locks that VSS cannot snapshot through, so the job continues and reports a warning rather than failing outright.",
 [("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Backup'; Id=19} -MaxEvents 2",0,"Backup completed with warnings; some files were skipped",""),
  ("vssadmin list writers | Select-String 'State'",0,"State: [1] Stable (all writers)","")],
 "Identify the locking application and exclude its data from the file-level backup, backing it up instead through its own application-aware method (SQL/Exchange writers, or an application export)."),
("backup","Restoring files from a backup fails with access denied even as an administrator",
 "The backed-up files carry ACLs referencing SIDs from the original domain; restoring preserves those ACLs, so the current account has no rights to the restored data.",
 [("whoami /user",0,"CORP\\admin S-1-5-21-NEW-500",""),
  ("icacls 'D:\\Restored\\Finance' | Select-Object -First 3",0,"S-1-5-21-OLD-1105:(OI)(CI)(F)  (unresolved SID)","")],
 "Take ownership and reapply permissions on the restored tree (takeown /r then icacls /reset /t), or restore without ACLs when the source domain no longer exists."),
# ---- Application / compatibility ----
("appcompat","An installer fails only when run from a network share",
 "The installer is blocked by the security zone applied to network paths; local execution succeeds because the local zone has different trust settings.",
 [("Get-Item '\\\\deploy\\pkg\\setup.exe' -Stream Zone.Identifier -ErrorAction SilentlyContinue | Select-Object Stream",0,"Zone.Identifier","")],
 "Copy the installer locally and unblock it, or add the deployment share to the Local Intranet zone; running installers directly from untrusted network paths is correctly restricted by default."),
("appcompat","A desktop app renders with wrong colours only on the second monitor",
 "The monitors have different colour profiles and the app is not colour-management aware, so it renders using the primary display's profile on both screens.",
 [("Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorID | Measure-Object | Select-Object Count",0,"Count : 2","")],
 "Set both displays to the same colour profile if colour accuracy across screens matters, or use a colour-managed application; non-aware apps cannot adapt per-monitor."),
# ---- Dev / AI machines ----
("aidev","Python virtual environment activation fails with an execution policy error",
 "The venv activation script is a PowerShell script, so it is blocked by the same execution policy that blocks any unsigned local script.",
 [("Get-ExecutionPolicy -List | Where-Object Scope -eq 'CurrentUser' | Select-Object ExecutionPolicy",0,"ExecutionPolicy : Undefined",""),
  ("Test-Path '.\\.venv\\Scripts\\Activate.ps1'",0,"True","")],
 "Set 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned' once, or use the .bat activation script in cmd.exe; do not use Bypass system-wide just for venvs."),
("aidev","pip installs succeed but the package is not importable in the same environment",
 "Two Python installations are present and pip resolved to a different one than the interpreter being used, so the package landed in the other environment's site-packages.",
 [("Get-Command python, pip -All | Select-Object Name, Source",0,"python  C:\\Python311\\python.exe / python  ...\\WindowsApps\\python.exe",""),
  ("python -c \"import sys; print(sys.executable)\"",0,"C:\\Users\\jdoe\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe","")],
 "Always install with 'python -m pip install' so pip matches the interpreter, and remove the Microsoft Store Python alias from PATH if a full installation is also present."),
("aidev","A CUDA training job fails partway with an out-of-memory error on a GPU with free memory",
 "Memory is fragmented across allocations from earlier runs held by a lingering process, so the largest contiguous block is far smaller than the reported free total.",
 [("nvidia-smi --query-gpu=memory.total,memory.used,memory.free --format=csv",0,"12288 MiB, 9120 MiB, 3168 MiB",""),
  ("nvidia-smi --query-compute-apps=pid,used_memory --format=csv",0,"7744, 8800 MiB (orphaned python process)","")],
 "End the orphaned process holding GPU memory, and in long-running notebooks free tensors and call the framework's cache-release between runs rather than relying on the reported free figure."),
("aidev","Ollama models download but fail to load with a memory error",
 "The model's parameter count requires more RAM than the machine has available once the OS and other applications are accounted for, so loading fails despite the download succeeding.",
 [("Get-CimInstance Win32_OperatingSystem | Select-Object @{N='TotalGB';E={[math]::Round($_.TotalVisibleMemorySize/1MB,1)}}, @{N='FreeGB';E={[math]::Round($_.FreePhysicalMemory/1MB,1)}}",0,"TotalGB : 15.9  FreeGB : 4.1",""),
  ("Get-ChildItem \"$env:USERPROFILE\\.ollama\\models\" -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum | Select-Object @{N='GB';E={[math]::Round($_.Sum/1GB,1)}}",0,"GB : 38.4","")],
 "Use a smaller or more heavily quantized model variant that fits available memory, close other applications before loading, or move the workload to a machine with more RAM/VRAM."),
]

with open(JSON_PATH, encoding="utf-8") as f: data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f: jsonl_lines = [l for l in f if l.strip()]

existing_ids = set(d["id"] for d in data)
existing_goals = set(d["goal"] for d in data)
prefix_index = collections.defaultdict(list)
for g in existing_goals: prefix_index[' '.join(g.lower().split()[:4])].append(g)

n = 1
def next_id():
    global n
    while True:
        cand = f"new-win-repair-{n:03d}"; n += 1
        if cand not in existing_ids: existing_ids.add(cand); return cand

skipped, near = [], []
base_time = datetime(2026, 8, 7, 9, 0, 0); i = 0
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
print(f"Added: {i} | dups: {len(skipped)} | near: {len(near)}")
for a,b in near: print("  NEAR:", a[:55], "<>", b[:55])
print("Total:", len(data))
