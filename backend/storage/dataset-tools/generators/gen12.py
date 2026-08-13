import json, collections
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

NEW = [
# ================= BACKUP & RESTORE =================
("backup","System Restore points keep disappearing -- no restore points available when needed",
 "Shadow copy storage for the system volume was capped at a size too small to retain more than one snapshot, so each new restore point silently evicted the previous ones.",
 [("vssadmin list shadowstorage",0,"Used Shadow Copy Storage space: 1.02 GB\nMaximum Shadow Copy Storage space: 1.5 GB (0%)",""),
  ("Get-ComputerRestorePoint | Measure-Object",0,"Count : 1","")],
 "Raise the shadow storage cap ('vssadmin resize shadowstorage /for=C: /on=C: /maxsize=15GB'); also confirm no disk-cleanup tool or third-party optimizer is deleting restore points on a schedule."),
("backup","System Restore fails with 'Restore Point could not be created' error 0x81000203",
 "The System Protection feature is disabled on the target volume, so restore point creation is refused at the API level -- the error code specifically indicates the protection state, not a shadow copy failure.",
 [("Checkpoint-Computer -Description 'test'",1,"","Checkpoint-Computer : Failed with 0x81000203"),
  ("Get-CimInstance -Namespace root/default -ClassName SystemRestoreConfig -ErrorAction SilentlyContinue",0,"(protection not enabled for C:)","")],
 "Enable System Protection for the volume (System Properties > System Protection > Configure > Turn on, allocate 5-10% disk space), then retry; on Server SKUs, System Restore is not available at all -- use backups instead."),
("backup","wbadmin backup fails with 'The specified backup disk cannot be found' though the drive is connected",
 "The backup target's disk signature changed after the enclosure was swapped, and the saved backup policy still references the old signature -- so the scheduled job can't locate a disk that is physically present.",
 [("wbadmin get disks",0,"Disk name: Backup4TB  Disk identifier: {NEW-GUID}",""),
  ("wbadmin get items -version:07/28/2026-02:00",1,"","The specified backup disk cannot be found.")],
 "Re-create the backup schedule against the current disk identifier ('wbadmin enable backup -addtarget:{current-GUID}'); disk signatures change with enclosure/controller swaps, so re-target rather than reformatting."),
("backup","File History stopped backing up silently -- last backup is weeks old with no error shown",
 "File History's target drive was disconnected long enough for the service to give up; it caches locally then stops without a visible notification once the cache limit is reached.",
 [("Get-Service fhsvc | Select-Object Status",0,"Status\n------\nRunning",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-FileHistory-Engine/BackupLog'} -MaxEvents 3",0,"Backup target not found; File History has been paused","")],
 "Reconnect the target drive and resume File History from Settings; for laptops that roam, prefer a network target or OneDrive backup so an unplugged USB drive doesn't silently stop protection."),
("backup","Restoring a system image to different hardware fails at boot with INACCESSIBLE_BOOT_DEVICE",
 "The restored image contains the original machine's storage controller driver binding; the new hardware uses a different controller mode, so Windows can't load the boot device driver on first start.",
 [("Get-CimInstance Win32_SCSIController | Select-Object Name",0,"Name: Intel RST VMD Controller (new hardware)","")],
 "Boot the recovery environment and enable the matching controller mode in BIOS (AHCI vs RAID/VMD) to match the image, or inject the new controller driver offline with 'DISM /Image:C:\\ /Add-Driver'; bare-metal image restores are hardware-sensitive by design."),
# ================= WINDOWS SERVER ROLES =================
("server-roles","DHCP server service starts then stops immediately on a new server",
 "The DHCP server is unauthorized in Active Directory; the service intentionally shuts down to prevent a rogue DHCP server from serving addresses on a domain network.",
 [("Get-Service DHCPServer | Select-Object Status",0,"Status\n------\nStopped",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-DHCP-Server'} -MaxEvents 2",0,"The DHCP/BINL service ... is not authorized and has stopped servicing clients","")],
 "Authorize the server in AD ('Add-DhcpServerInDC -DnsName dhcp01.corp.local -IPAddress 10.0.0.5') with Enterprise Admin rights, then start the service; the shutdown behavior is a deliberate rogue-DHCP protection."),
("server-roles","File Server Resource Manager quota blocks writes but users see only a generic 'disk full' error",
 "FSRM enforces a hard quota on the share's folder, which surfaces to clients as a disk-full condition even though the volume has plenty of free space -- the quota, not the volume, is exhausted.",
 [("Get-FsrmQuota -Path 'D:\\Shares\\Projects' | Select-Object Size, Usage, SoftLimit",0,"Size: 50GB  Usage: 50GB  SoftLimit: False",""),
  ("Get-Volume -DriveLetter D | Select-Object SizeRemaining",0,"SizeRemaining : 812 GB","")],
 "Raise the FSRM quota or convert it to a soft quota with notification thresholds so users get warnings before hitting the wall; also enable quota email notifications so this is caught before it blocks work."),
("server-roles","Print server clients get 'Windows cannot connect to the printer' error 0x0000007e",
 "The client architecture doesn't match the drivers installed on the print server -- 64-bit clients are connecting while only 32-bit drivers are staged, so driver download fails at connection time.",
 [("Get-PrinterDriver -ComputerName printsrv | Select-Object Name, PrinterEnvironment",0,"Name: HP Universal  PrinterEnvironment: Windows NT x86","")],
 "Add the x64 driver to the print server ('Add-PrinterDriver -Name \"HP Universal\" -ComputerName printsrv'), or deploy printers via Group Policy with Type 4 drivers that don't require server-side per-architecture packages."),
("server-roles","NPS RADIUS authentication rejects all Wi-Fi clients after a certificate renewal",
 "NPS's network policy still references the old certificate by thumbprint; after renewal the policy points at a certificate that no longer exists, so every EAP negotiation fails before the user is even evaluated.",
 [("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=6273} -MaxEvents 3",0,"Reason: The certificate configured for use in the network policy could not be found",""),
  ("Get-ChildItem Cert:\\LocalMachine\\My | Select-Object Subject, Thumbprint, NotAfter",0,"CN=nps01.corp.local  NotAfter: 2027-08-01 (new thumbprint)","")],
 "Re-select the new certificate in each NPS network policy's PEAP/EAP configuration and restart the NPS service; policies bind by thumbprint, so renewals always require this manual re-selection unless automated."),
("server-roles","RRAS VPN server accepts connections but clients get no route to the internal network",
 "RRAS is handing out addresses from a pool that isn't routed internally, and IP forwarding for the LAN interface is disabled, so packets from VPN clients arrive but have no return path.",
 [("Get-NetIPInterface -AddressFamily IPv4 | Select-Object InterfaceAlias, Forwarding",0,"InterfaceAlias  Forwarding\nInternal        Disabled",""),
  ("Get-NetRoute -DestinationPrefix '10.10.50.0/24' -ErrorAction SilentlyContinue",1,"","(no internal route for the VPN pool)")],
 "Enable forwarding on the internal interface and add a route for the VPN client pool on the core router/firewall so return traffic knows the path back; a VPN pool must be routable, not just assignable."),
("server-roles","AD Certificate Services web enrollment returns 'The RPC server is unavailable' error",
 "The CA web enrollment role talks to the CA service over RPC; the CA service itself is stopped because its own signing certificate expired, so every enrollment path fails with a downstream RPC error.",
 [("Get-Service CertSvc | Select-Object Status",0,"Status\n------\nStopped",""),
  ("certutil -CAInfo",1,"","The Certification Authority service has not been started (0x800706ba)")],
 "Renew the CA's own certificate (certsrv console > Renew CA Certificate) then start CertSvc; the RPC error is a symptom -- always check the CA service state before troubleshooting the web enrollment layer."),
("server-roles","ADFS sign-in fails for external users with 'An error occurred' while internal users are fine",
 "The Web Application Proxy's trust with the ADFS farm expired, so proxied (external) requests are rejected while direct internal requests to the ADFS servers continue working.",
 [("Get-WebApplicationProxyConfiguration | Select-Object ConnectedServersName",0,"ConnectedServersName : {adfs01.corp.local}",""),
  ("Get-WinEvent -FilterHashtable @{LogName='AD FS/Admin'} -MaxEvents 3",0,"The federation server proxy could not renew its trust with the Federation Service","")],
 "Re-establish the proxy trust ('Install-WebApplicationProxy' re-run with a farm admin credential); proxy trust certificates auto-renew but fail silently if the proxy was offline during the renewal window."),
# ================= STORAGE / NETWORKING ADVANCED =================
("iscsi","iSCSI target disconnects under load and the volume goes offline intermittently",
 "The iSCSI initiator times out because the storage network shares an oversubscribed uplink with regular traffic; each congestion burst exceeds the initiator's default timeout and drops the session.",
 [("Get-IscsiSession | Select-Object InitiatorNodeAddress, IsConnected",0,"IsConnected : False (intermittent)",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='iScsiPrt'} -MaxEvents 3",0,"Target did not respond in time for a SCSI request (Event 39/129)","")],
 "Put iSCSI on a dedicated VLAN/NIC with flow control and jumbo frames end-to-end, enable MPIO for path redundancy, and only then consider raising the initiator's LinkDownTime/MaxRequestHoldTime values."),
("networking-advanced","NIC teaming shows both adapters up but throughput never exceeds a single adapter's speed",
 "The team uses Switch Independent mode with address-hash distribution, so a single TCP flow always maps to one adapter -- teaming adds redundancy and aggregate capacity across flows, not speed for one stream.",
 [("Get-NetLbfoTeam | Select-Object Name, TeamingMode, LoadBalancingAlgorithm",0,"TeamingMode: SwitchIndependent  LoadBalancingAlgorithm: HyperVPort","")],
 "This is expected behavior -- a single stream can't exceed one member's bandwidth without LACP plus a switch-side port channel and a flow-aware hash; use SMB Multichannel or multiple parallel streams to use the full aggregate."),
("networking-advanced","Jumbo frames configured but large transfers still fragment or fail across the network",
 "The server's NIC has jumbo frames enabled but an intermediate switch port is still at the default 1500 MTU, so oversized frames are dropped silently -- jumbo frames require every hop to agree.",
 [("Get-NetAdapterAdvancedProperty -Name 'Storage NIC' -DisplayName '*Jumbo*' | Select-Object DisplayValue",0,"DisplayValue : 9014 Bytes",""),
  ("ping -f -l 8972 10.10.20.5",1,"","Packet needs to be fragmented but DF set.")],
 "Set the same MTU on every device in the path (NICs, switch ports, and any router interfaces) and verify end-to-end with a DF-flagged ping at the target size before relying on jumbo frames for production traffic."),
("networking-advanced","QoS policy for a business app has no effect -- traffic is still being starved during congestion",
 "The QoS policy tags packets with DSCP correctly, but the network switches are configured to trust only CoS markings and re-write DSCP to zero at ingress, discarding the endpoint's classification.",
 [("Get-NetQosPolicy | Select-Object Name, DSCPAction, AppPathNameMatchCondition",0,"Name: BizApp  DSCPAction: 46  AppPathName: bizapp.exe","")],
 "Endpoint QoS only works if the network honors it -- have the network team configure the access ports to trust DSCP from these endpoints, otherwise apply the classification at the switch/router instead."),
("networking-advanced","SNMP monitoring stopped reporting for Windows servers after a hardening baseline was applied",
 "The SNMP Service feature was removed by the baseline (it's deprecated), so the monitoring system's polls go unanswered -- the servers are healthy, the agent is simply gone.",
 [("Get-WindowsFeature SNMP-Service | Select-Object InstallState",0,"InstallState : Removed","")],
 "Migrate monitoring to WMI/WinRM-based collection or an agent the vendor still supports; SNMP on Windows is deprecated, so re-adding it is a short-term bridge rather than a fix."),
# ================= WINDOWS SANDBOX / VIRTUAL =================
("sandbox","Windows Sandbox fails to start with 'Failed to initialize' error 0x80070002",
 "Sandbox depends on the Hyper-V platform components; virtualization is enabled in firmware but the required optional features were only partially installed, so its container image can't initialize.",
 [("Get-WindowsOptionalFeature -Online -FeatureName 'Containers-DisposableClientVM' | Select-Object State",0,"State : Enabled",""),
  ("Get-WindowsOptionalFeature -Online -FeatureName 'VirtualMachinePlatform' | Select-Object State",0,"State : Disabled","")],
 "Enable VirtualMachinePlatform (and HypervisorPlatform) then reboot; Sandbox silently requires these even though only the Sandbox feature is visible in the UI."),
("sandbox","Windows Sandbox has no network access though the host is online",
 "The Sandbox's default networking uses the Hyper-V Default Switch, which was deleted by a previous VM cleanup, leaving the sandbox with no virtual network to attach to.",
 [("Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue",1,"","(Default Switch not found)")],
 "Restore the Default Switch by disabling and re-enabling the Hyper-V feature (it recreates it on boot), or disable networking in the .wsb config if the sandbox is meant to be isolated anyway."),
# ================= REMOTE ASSISTANCE =================
("remote-assist","Quick Assist connects but the helper sees a black screen with only the mouse cursor moving",
 "The remote session can't capture the secure desktop and the target's GPU is using a driver mode that blocks the capture path -- typically after a UAC prompt appears or with certain hardware-accelerated capture blocked.",
 [("Get-Process QuickAssist -ErrorAction SilentlyContinue | Select-Object Responding",0,"Responding : True",""),
  ("Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion",0,"Name: Intel Iris Xe  DriverVersion: 27.20.100.8681","")],
 "Update the GPU driver, and have the user dismiss any UAC/secure-desktop prompt (Quick Assist can't render the secure desktop unless the helper has been granted control with elevation consent)."),
("remote-assist","Remote Assistance invitations fail on a corporate network with 'the person you are trying to help is not available'",
 "Remote Assistance is disabled by Group Policy and its firewall rule group is off, so the invitation can be generated locally but no inbound session can ever be established.",
 [("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Remote Assistance' -Name fAllowToGetHelp",0,"fAllowToGetHelp : 0",""),
  ("Get-NetFirewallRule -DisplayGroup 'Remote Assistance' | Select-Object Enabled -First 1",0,"Enabled : False","")],
 "On managed networks use the sanctioned remote support tool instead; if Remote Assistance is meant to be available, it must be enabled via GPO plus its firewall rule group -- local changes will be reverted at policy refresh."),
# ================= FONTS / DISPLAY =================
("fonts","Some applications show boxes/tofu instead of text after a font cleanup",
 "A required system font was removed during cleanup; apps that reference it by name fall back to a font lacking those glyphs, rendering placeholder boxes rather than failing outright.",
 [("Get-ChildItem C:\\Windows\\Fonts -Filter 'segoeui*.ttf' | Select-Object Name",0,"(segoeui.ttf missing)",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-Font-Cache'} -MaxEvents 2 -ErrorAction SilentlyContinue",0,"Font resource could not be loaded","")],
 "Restore the missing system fonts with 'sfc /scannow' (system fonts are protected files it can replace), or copy them from another matching-build machine; never remove fonts from C:\\Windows\\Fonts without knowing which apps reference them."),
("fonts","Font rendering is corrupted across all apps until reboot -- fixes itself temporarily",
 "The font cache database became corrupted; apps read stale/garbled glyph data from it until the service rebuilds the cache at boot, which is why rebooting temporarily resolves it.",
 [("Get-Service FontCache | Select-Object Status",0,"Status\n------\nRunning",""),
  ("Get-ChildItem 'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Local\\FontCache' | Measure-Object Length -Sum",0,"Sum : 412 MB (abnormally large)","")],
 "Stop the FontCache service, delete the cache files under the LocalService FontCache folder plus FNTCACHE.DAT in System32, then start the service so a clean cache is built."),
# ================= LICENSING / ACTIVATION =================
("licensing","Office 365 apps show 'Product Deactivated' repeatedly despite signing in successfully",
 "The Office licensing token cache is corrupted, so each sign-in stores a token the licensing stack can't read back, causing the app to fall into deactivated state on next launch.",
 [("Get-ChildItem \"$env:LOCALAPPDATA\\Microsoft\\Office\\16.0\\Licensing\" -ErrorAction SilentlyContinue | Measure-Object",0,"Count : 47 (stale token files)","")],
 "Clear the Office licensing token cache (close all Office apps, delete the Licensing folder contents and the corresponding credentials in Credential Manager), then sign in once to re-provision a clean token."),
("licensing","KMS activation succeeds but Windows deactivates again after 180 days on isolated machines",
 "KMS licenses are time-limited and require re-activation contact every 180 days; these machines are on an isolated network segment that can't reach the KMS host, so they lapse on schedule rather than failing outright.",
 [("slmgr /dlv",0,"Volume activation expiration: 43200 minutes remaining (KMS)",""),
  ("Test-NetConnection kms01.corp.local -Port 1688",1,"","TcpTestSucceeded : False")],
 "Either open port 1688 from the isolated segment periodically, or convert these machines to MAK activation which doesn't require recurring contact -- KMS by design needs a renewal path."),
("licensing","Windows reports 'Your Windows license will expire soon' on a domain-joined machine",
 "The machine is activated against a KMS host with a client key, and its renewal attempts are failing -- so the countdown is real and it will drop to notification mode if the KMS host stays unreachable.",
 [("slmgr /dli",0,"License Status: Licensed\nVolume activation expiration: 2160 minutes remaining",""),
  ("nslookup -type=srv _vlmcs._tcp.corp.local",1,"","*** No SRV records found")],
 "Restore the KMS SRV record in DNS (or set the KMS host explicitly with 'slmgr /skms kms01.corp.local'), then force re-activation with 'slmgr /ato'; the expiry warning clears once renewal succeeds."),
# ================= MALWARE / REMEDIATION =================
("malware","After malware removal, internet works but every browser redirects -- DNS settings keep reverting",
 "The malware left a scheduled task that rewrites the adapter's DNS servers to attacker-controlled resolvers every few minutes, which is why manual corrections don't stick after the payload itself was removed.",
 [("Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, ServerAddresses",0,"Wi-Fi  {45.67.89.10, 45.67.89.11}",""),
  ("Get-ScheduledTask | Where-Object {$_.Author -notmatch 'Microsoft' -and $_.State -eq 'Ready'} | Select-Object TaskName, TaskPath",0,"TaskName: SystemNetHelper  TaskPath: \\","")],
 "Remove the malicious scheduled task, reset DNS to automatic, then run a full Defender offline scan; persistence mechanisms (tasks, Run keys, services, WMI subscriptions) must all be cleared or the payload returns."),
("malware","Suspected fileless malware -- nothing on disk but the machine beacons out periodically",
 "A permanent WMI event subscription is executing an encoded PowerShell payload on a timer, which leaves no conventional file on disk and survives reboots -- a classic fileless persistence technique.",
 [("Get-WmiObject -Namespace root\\subscription -Class __EventFilter | Select-Object Name, Query",0,"Name: SCM Event Filter  Query: SELECT * FROM __InstanceModificationEvent WITHIN 60",""),
  ("Get-WmiObject -Namespace root\\subscription -Class CommandLineEventConsumer | Select-Object Name, CommandLineTemplate",0,"CommandLineTemplate: powershell.exe -enc SQBFAFgA...","")],
 "Treat as an incident: capture the subscription details for analysis, remove the __EventFilter/__EventConsumer/__FilterToConsumerBinding trio, then rebuild the machine -- fileless persistence usually accompanies deeper compromise."),
("malware","Ransomware note found but files still open normally -- assessing whether encryption actually ran",
 "Comparing file entropy and headers shows the documents are intact and only the ransom note was dropped, indicating an aborted or scareware-only payload rather than completed encryption.",
 [("Get-ChildItem 'C:\\Users\\jdoe\\Documents' -Filter '*.docx' | Select-Object -First 3 Name, Length",0,"(files present with normal sizes and .docx extensions)",""),
  ("Get-MpThreatDetection | Select-Object -First 2 ThreatName, InitialDetectionTime",0,"Ransom:Win32/Filecoder (blocked before execution)","")],
 "Isolate the machine anyway and preserve evidence: Defender blocked the payload here, but the initial access vector remains unknown -- audit how it arrived, reset credentials used on the machine, and restore from backup if any doubt remains."),
("malware","Controlled Folder Access blocked a ransomware attempt -- verifying nothing was lost",
 "The Defender operational log shows a blocked write attempt against a protected folder, confirming the protection worked and the target files were never modified.",
 [("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1123} -MaxEvents 3",0,"Blocked untrusted process C:\\Users\\Public\\enc.exe from modifying C:\\Users\\jdoe\\Documents",""),
  ("Get-MpPreference | Select-Object EnableControlledFolderAccess",0,"EnableControlledFolderAccess : 1","")],
 "Quarantine and analyze the blocked binary, then hunt for how it landed on the machine; keep Controlled Folder Access enabled and extend its protected-folder list to any custom data directories."),
# ================= DATA RECOVERY / MIGRATION =================
("datarecovery","Deleted files aren't in the Recycle Bin -- deleted from a network share or with Shift+Delete",
 "Files deleted from network shares bypass the client Recycle Bin entirely, and the server's previous-versions snapshots are the only recovery path -- which exist here from VSS.",
 [("Get-ChildItem '\\\\fileserver\\projects' -Force | Where-Object Name -eq 'report.xlsx'",1,"","(file not present)"),
  ("vssadmin list shadows /for=D: # on the file server",0,"Shadow Copy creation time: 7/28/2026 12:00 (3 snapshots available)","")],
 "Restore from Previous Versions on the share (right-click the folder > Restore previous versions) or from the server's VSS snapshot; ensure shadow copies are scheduled on file server volumes -- client Recycle Bin never covers network deletions."),
("datarecovery","User profile migration to a new PC left Outlook, browser passwords and app settings behind",
 "The migration copied the visible Documents/Desktop folders but not AppData, where Outlook profiles, browser data and app settings live -- so the data exists on the old machine but wasn't in scope.",
 [("Get-ChildItem 'C:\\Users\\jdoe\\AppData\\Roaming' | Measure-Object",0,"Count : 62 (application data directories not migrated)","")],
 "Use USMT (scanstate/loadstate) or a profile migration tool that includes AppData rather than a manual folder copy; for a one-off, copy AppData\\Roaming and AppData\\Local selectively while both apps are closed."),
("datarecovery","An accidentally formatted drive needs recovery -- what's safe to do first",
 "A quick format only rewrites file-system metadata, leaving the data clusters intact, so recovery odds are high -- provided nothing writes to the volume before imaging it.",
 [("Get-Volume -DriveLetter F | Select-Object FileSystem, Size, SizeRemaining",0,"FileSystem: NTFS  Size: 1TB  SizeRemaining: 999GB (freshly formatted)","")],
 "Stop using the drive immediately, image it to another disk sector-by-sector, and run recovery tooling against the image, never the original; every write to the formatted volume reduces what's recoverable."),
# ================= TERMINAL / SCRIPTING ADVANCED =================
("terminal","Windows Terminal won't open -- clicking the icon does nothing and no error appears",
 "The terminal's settings.json contains a syntax error introduced by a manual edit, so the app fails during settings parse and exits before rendering any window or error dialog.",
 [("Get-Content \"$env:LOCALAPPDATA\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json\" -Raw | ConvertFrom-Json",1,"","ConvertFrom-Json : Invalid JSON primitive at line 47"),
  ("Get-AppxPackage Microsoft.WindowsTerminal | Select-Object Status",0,"Status : Ok","")],
 "Fix or delete the settings.json (Terminal regenerates defaults on next launch -- back it up first); validating the file with ConvertFrom-Json before saving prevents this entirely."),
("terminal","A PowerShell script hangs indefinitely when run non-interactively but completes when run manually",
 "The script calls a cmdlet that prompts for confirmation; interactively the user presses Enter without noticing, but in an unattended context the prompt blocks forever with nothing to answer it.",
 [("Select-String -Path .\\cleanup.ps1 -Pattern 'Remove-Item|Stop-Service' -SimpleMatch",0,"Remove-Item $path -Recurse   (no -Confirm:$false or -Force)","")],
 "Add explicit -Confirm:$false / -Force to state-changing cmdlets and set $ConfirmPreference='None' plus $ErrorActionPreference='Stop' at the top of unattended scripts, so they either proceed or fail rather than hang."),
("terminal","PowerShell script produces different results when run as a scheduled task vs interactively",
 "The scheduled task runs as SYSTEM with a different HKCU hive, PATH, and no mapped drives -- so environment-dependent parts of the script silently resolve differently rather than erroring.",
 [("Get-ScheduledTask -TaskName 'ReportGen' | Select-Object -ExpandProperty Principal | Select-Object UserId",0,"UserId : SYSTEM",""),
  ("[Environment]::GetFolderPath('MyDocuments')",0,"C:\\Windows\\system32\\config\\systemprofile\\Documents (under SYSTEM)","")],
 "Make scripts context-independent: use UNC paths not drive letters, absolute paths not relative, explicit credentials for network resources, and avoid per-user folder shortcuts like MyDocuments in machine-context automation."),
# ================= EMAIL CLIENTS =================
("email","Outlook search returns no results for older mail though the messages are visible in the folder",
 "The Outlook data file was excluded from the Windows Search index (or indexing never completed), so search finds only what's cached client-side rather than the full mailbox.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-Search'} -MaxEvents 2 -ErrorAction SilentlyContinue",0,"Indexing paused: index corruption detected",""),
  ("Get-Service WSearch | Select-Object Status",0,"Status\n------\nRunning","")],
 "Confirm Outlook is listed in Indexing Options > Modify, then rebuild the index; on very large mailboxes, reducing the 'Mail to keep offline' slider also shrinks what must be indexed."),
("email","Outlook keeps duplicating incoming messages after adding a second device",
 "A server-side rule and a client-side rule both act on incoming mail, and the client rule re-downloads messages the server rule already moved -- producing duplicates whenever both are online.",
 [("Get-InboxRule -Mailbox jdoe@corp.com | Select-Object Name, Enabled, StopProcessingRules",0,"Name: FileToProject  Enabled: True  StopProcessingRules: False","")],
 "Consolidate the logic into server-side rules only (they run regardless of which device is online) and delete the duplicate client-only rule; enable StopProcessingRules where rules could otherwise chain."),
("email","SMTP relay from an application server stopped working after Exchange hardening",
 "Anonymous relay was disabled on the receive connector during hardening; the app authenticates with no credentials, so its submissions are now rejected outright.",
 [("Test-NetConnection mail.corp.local -Port 25",0,"TcpTestSucceeded : True",""),
  ("Get-ReceiveConnector 'Anonymous Relay' | Select-Object PermissionGroups, Enabled",0,"PermissionGroups: ExchangeUsers  Enabled: True","")],
 "Configure the app to authenticate (preferred) with a dedicated service mailbox, or create a scoped receive connector limited to that server's IP with anonymous relay permission -- never re-enable open relay broadly."),
# ================= MONITORING / PERF =================
("monitoring","Performance counters are missing from Perfmon -- only a few base counters remain",
 "The performance counter registry entries were corrupted (commonly by a failed application install), so most providers' counters no longer enumerate even though the underlying services are healthy.",
 [("typeperf -q | Measure-Object",0,"Count : 84 (normally thousands)",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-Perflib'} -MaxEvents 3",0,"The Open Procedure for service failed (Event 1008, multiple providers)","")],
 "Rebuild the counters with 'lodctr /R' (elevated) then restart the 'Performance Logs & Alerts' and WMI services; re-register individual providers afterward if a specific application's counters are still missing."),
("monitoring","A Data Collector Set stops immediately after starting with no data captured",
 "The collector writes to a path the SYSTEM-context service can't reach -- a mapped drive letter that only exists for the interactive user -- so it terminates as soon as it tries to create the log file.",
 [("Get-Content 'C:\\PerfLogs\\Admin\\report.txt' -ErrorAction SilentlyContinue",1,"","(no output produced)"),
  ("logman query 'AppTrace'",0,"Root Path: Z:\\PerfLogs  Status: Stopped","")],
 "Change the collector's root path to a local absolute path or UNC path reachable by the run-as account; mapped drive letters are per-user and never available to machine-context collectors."),
# ================= MODERN MGMT =================
("intune","Intune app deployments show 'Failed' with error 0x87D1041C on several devices",
 "0x87D1041C indicates the app's detection rule never matched after installation, so Intune marks it failed even though the software installed correctly -- a detection-logic problem, not an install failure.",
 [("Get-Content 'C:\\ProgramData\\Microsoft\\IntuneManagementExtension\\Logs\\IntuneManagementExtension.log' -Tail 10",0,"Detection rule: file C:\\Program Files\\App\\app.exe not found (app installed to Program Files (x86))","")],
 "Correct the detection rule to match the real install path/version (or use a registry/MSI product-code detection), then re-deploy; mismatched detection rules are the most common cause of phantom Intune app failures."),
("intune","Windows Autopatch/Update rings not applying -- devices stay on an old build",
 "The devices have a conflicting legacy WSUS policy still applied via Group Policy, which takes precedence over the cloud update policy, so the modern update rings are effectively ignored.",
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate' -Name UseWUServer, WUServer -ErrorAction SilentlyContinue",0,"UseWUServer : 1  WUServer : http://wsus.corp.local",""),
  ("dsregcmd /status | Select-String 'MdmUrl'",0,"MdmUrl : https://enrollment.manage.microsoft.com/...","")],
 "Remove the legacy WSUS GPO from co-managed devices (or set the MDM authority precedence explicitly); mixing GPO-based and cloud-based update management is the standard cause of update rings appearing inert."),
("mdm","Company Portal shows the device as non-compliant for 'Antivirus not reporting' though Defender is on",
 "Defender is running but in passive mode behind a third-party AV that doesn't report through the Windows Security Center API, so the compliance check finds no reporting antivirus.",
 [("Get-MpComputerStatus | Select-Object AMRunningMode, AntivirusEnabled",0,"AMRunningMode : Passive Mode",""),
  ("Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object displayName, productState",0,"displayName : LegacyAV Corporate (productState indicates not reporting)","")],
 "Either update the third-party AV to a version that registers with Security Center properly, or standardize on Defender so compliance signals flow; the compliance policy is reading an accurate signal here."),
# ================= TIME / SCHEDULING =================
("time","Scheduled tasks run an hour early or late twice a year around DST changes",
 "The tasks were created with a fixed UTC trigger rather than local time, so they don't shift with daylight saving -- their absolute run time stays constant while local clocks move.",
 [("Get-ScheduledTask -TaskName 'NightlyBatch' | Select-Object -ExpandProperty Triggers | Select-Object StartBoundary",0,"StartBoundary : 2026-01-01T02:00:00Z (UTC-anchored)","")],
 "Re-create the trigger using local time (no trailing Z in StartBoundary) so it follows DST, or intentionally keep UTC anchoring if the job must align with a global schedule -- just document which behavior is intended."),
("time","Domain time is correct but a standalone kiosk PC drifts minutes per day",
 "The standalone machine syncs against an unreachable NTP peer and has a fast-drifting RTC, so with no successful sync it accumulates error continuously.",
 [("w32tm /query /status",0,"Source: Local CMOS Clock\nLast Successful Sync Time: unspecified",""),
  ("w32tm /query /peers",0,"Peer: time.windows.com  State: Error","")],
 "Point it at a reachable NTP source and shorten the poll interval ('w32tm /config /manualpeerlist:pool.ntp.org,0x8 /syncfromflags:manual /update'), then verify sync succeeds; persistent drift with good sync means a failing RTC/CMOS battery."),
# ================= APP COMPAT =================
("appcompat","A legacy 16-bit application won't run on 64-bit Windows at all",
 "64-bit Windows removed the NTVDM subsystem entirely, so 16-bit executables cannot run natively regardless of compatibility settings -- this is an architectural limitation, not a configuration issue.",
 [("Get-CimInstance Win32_OperatingSystem | Select-Object OSArchitecture",0,"OSArchitecture : 64-bit",""),
  ("(Get-Item .\\legacyapp.exe).VersionInfo.FileDescription",0,"(16-bit MZ executable)","")],
 "Run it in a 32-bit Windows VM (which retains NTVDM), use DOSBox for DOS-era software, or pursue a modern replacement; no compatibility-mode setting can restore 16-bit support on 64-bit Windows."),
("appcompat","An older app crashes on launch only on newer Windows builds -- works on older machines",
 "The app queries the OS version and mishandles the newer version number, crashing during its own compatibility check -- a version-detection bug in the application rather than a broken API.",
 [("Get-CimInstance Win32_OperatingSystem | Select-Object Version, BuildNumber",0,"Version : 10.0.26100  BuildNumber : 26100",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000} -MaxEvents 1 | Select-Object -ExpandProperty Message",0,"Faulting module: legacyapp.exe, exception 0xc0000005 during startup version check","")],
 "Apply a compatibility mode shim (Properties > Compatibility > 'Run this program in compatibility mode for Windows 8'), which reports an older version string to the app; the vendor fix is a corrected version check."),
]

with open(JSON_PATH, encoding="utf-8") as f:
    data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f:
    jsonl_lines = [l for l in f if l.strip()]

existing_ids = set(d["id"] for d in data)
existing_goals = set(d["goal"] for d in data)
# fast near-dup index: 4-word prefix buckets
prefix_index = collections.defaultdict(list)
for g in existing_goals:
    prefix_index[' '.join(g.lower().split()[:4])].append(g)

n = 1
def next_id():
    global n
    while True:
        cand = f"new-win-repair-{n:03d}"
        n += 1
        if cand not in existing_ids:
            existing_ids.add(cand); return cand

skipped, near = [], []
base_time = datetime(2026, 8, 2, 14, 0, 0)
i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goals:
        skipped.append(goal); continue
    key = ' '.join(goal.lower().split()[:4])
    if key in prefix_index:
        near.append((goal, prefix_index[key][0]))
    created = base_time + timedelta(minutes=6 * i); i += 1
    steps = [{"command": c, "blocked": False, "exitCode": ec, "stdout": o, "stderr": e, "reason": None} for c, ec, o, e in commands]
    data.append({
        "id": next_id(), "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal, "domain": domain,
        "plan": [f"Gather evidence across multiple layers for this {domain} issue",
                 "Distinguish the true root cause from plausible-looking suspects",
                 "Apply the correct fix, or escalate/explain when policy or design prevents a local fix"],
        "steps": steps, "resolved": True, "summary": summary, "recommendation": recommendation,
        "feedback": {"worked": True, "note": "", "at": (created + timedelta(minutes=3)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}})
    existing_goals.add(goal); prefix_index[key].append(goal)
    cmd_lines = "\n".join(f"- {c[0]}" + ("  [FAILED: " + c[3][:70] + "]" if c[1] != 0 else "") for c in commands)
    chat = {"messages": [
        {"role": "system", "content": f"You are a Windows repair expert specializing in {domain} problems. Diagnose with read-only commands first, then apply safe fixes. When a command fails, interpret the error and adapt."},
        {"role": "user", "content": goal},
        {"role": "assistant", "content": f"{summary}\nCommands used:\n{cmd_lines}\nRecommendation: {recommendation}"}]}
    jsonl_lines.append(json.dumps(chat, ensure_ascii=False) + "\n")

with open(JSON_PATH, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False); f.write("\n")
with open(JSONL_PATH, "w", encoding="utf-8") as f:
    f.writelines(jsonl_lines)

print("Added:", i, "| exact dups skipped:", len(skipped), "| near-dup prefix collisions:", len(near))
for a,b in near: print("   NEAR:", a, "<>", b)
print("Total JSON entries:", len(data), "| Total JSONL lines:", len(jsonl_lines))

ids = [d["id"] for d in data]; assert len(ids) == len(set(ids))
goals = [d["goal"] for d in data]; assert len(goals) == len(set(goals))
users = [json.loads(l)["messages"][1]["content"] for l in jsonl_lines]
assert len(users) == len(set(users)) and set(users) == set(goals)
print("Validation passed: unique ids/goals/prompts, files mirrored")
