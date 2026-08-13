#!/usr/bin/env python3
"""gen26.py - Round 8: repair-only, writes DIRECTLY to the project folder.
Fills thin domains: wsus, sccm, intune/mdm, dfs, iscsi, raid, cluster, vmware,
monitoring, fonts, gpo-advanced, remote-assist, loadbalancer + more everyday cases."""
import json, collections, uuid, sys, os, glob, shutil
from datetime import datetime, timedelta

STORE = glob.glob('/sessions/*/mnt/chatbot/backend/storage')[0]
JSON_PATH  = os.path.join(STORE, "repair-sessions.json")
JSONL_PATH = os.path.join(STORE, "repair-dataset.jsonl")

NEW = [
# ===================== WSUS =====================
("wsus","WSUS","Clients show in the WSUS console but never report any status",
 ["Check which update source the client is using","Confirm it can reach the WSUS endpoint","Look at the reporting result"],
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate' -Name WUServer, WUStatusServer",0,"WUServer       : http://wsus.corp.local:8530\nWUStatusServer : http://wsus.corp.local:80",""),
  ("Test-NetConnection wsus.corp.local -Port 8530 -InformationLevel Quiet",0,"True",""),
  ("Test-NetConnection wsus.corp.local -Port 80 -InformationLevel Quiet",1,"","False"),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WindowsUpdateClient'} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"Unable to connect: Windows is unable to connect to the automatic updates service and therefore cannot download and install updates.","")],
 True,
 "The detection endpoint on 8530 is reachable so clients appear in the console, but the reporting endpoint is pointed at port 80 which is closed. Detection and reporting are separate URLs, which is why the machines are visible yet permanently blank on status.",
 "Set WUStatusServer to the same http://wsus.corp.local:8530 value as WUServer. The two must match unless there is a deliberate split configuration - a mismatch produces exactly this half-working state.",
 (True,"typo in the GPO, fixed for the whole OU")),

("wsus","WSUS","Windows Update on clients fails with 0x80244022 against our WSUS server",
 ["Check the WSUS application pool state","Confirm the client's error is server-side","Identify the resource limit"],
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate' -Name WUServer",0,"WUServer : http://wsus.corp.local:8530",""),
  ("Invoke-WebRequest 'http://wsus.corp.local:8530/ClientWebService/client.asmx' -UseBasicParsing -TimeoutSec 10",1,"","The remote server returned an error: (503) Server Unavailable."),
  ("Test-NetConnection wsus.corp.local -Port 8530 -InformationLevel Quiet",0,"True","")],
 True,
 "0x80244022 is HTTP 503 passed through to the client - the port is open but the WsusPool application pool has stopped, usually after hitting its private memory limit. The failure is on the server, so nothing done on the clients will help.",
 "Raise the WsusPool private memory limit from the default 1,843,200 KB to 4 GB or more and restart the pool, then run a server cleanup to reduce what it has to hold. Restarting the pool alone brings clients back but it will stop again in days.",
 (True,"raised the limit and ran the cleanup wizard, stable since")),

# ===================== SCCM / CONFIGMGR =====================
("sccm","Configuration Manager","The Configuration Manager client shows no deployments at all",
 ["Check the client's assigned site","Verify management point communication","Identify the assignment failure"],
 [("Get-CimInstance -Namespace root\\ccm -ClassName SMS_Client | Select-Object ClientVersion",0,"ClientVersion\n-------------\n5.00.9128.1005",""),
  ("Get-CimInstance -Namespace root\\ccm -ClassName SMS_Authority | Select-Object Name, CurrentManagementPoint",0,"Name             CurrentManagementPoint\n----             ----------------------\nSMS:PS1",""),
  ("Test-NetConnection mp01.corp.local -Port 443 -InformationLevel Quiet",0,"True",""),
  ("Get-Content 'C:\\Windows\\CCM\\Logs\\ClientIDManagerStartup.log' -Tail 3",0,"[RegTask] - Server rejected registration 3","")],
 True,
 "The client is installed and the site is assigned, but CurrentManagementPoint is empty and registration is being rejected with code 3 - the client's certificate is not trusted by the management point. Without registration it never receives a policy, so no deployments appear.",
 "Check that the client has a valid PKI certificate and that its issuing CA is in the site's trusted root list. Reinstalling the client will not help while the certificate is the thing being rejected.",
 (True,"cert template had expired and reissued under a new CA")),

("sccm","Configuration Manager","Software deployments download but never install on some machines",
 ["Check the cache size against the package size","Look at the content download result","Identify the constraint"],
 [("Get-CimInstance -Namespace root\\ccm\\SoftMgmtAgent -ClassName CacheConfig | Select-Object Location, Size",0,"Location            Size\n--------            ----\nC:\\Windows\\ccmcache 5120",""),
  ("Get-ChildItem 'C:\\Windows\\ccmcache' -Directory | Measure-Object | Select-Object Count",0,"Count\n-----\n   38",""),
  ("Get-Content 'C:\\Windows\\CCM\\Logs\\CAS.log' -Tail 3",0,"Failed to create cache space for 8241 MB. Error 0x87D00324",""),
  ("Get-Volume C | Select-Object @{N='FreeGB';E={[int]($_.SizeRemaining/1GB)}}",0,"FreeGB\n------\n   64","")],
 True,
 "The cache is capped at 5 GB but the package needs 8.2 GB, so the download completes into a temporary location and then fails to be committed. There is 64 GB free on the disk - the limit is the ConfigMgr cache setting, not the drive.",
 "Increase the client cache size to at least 12 GB and clear the 38 stale cache folders. Persistent cache entries from old deployments consume the same budget, so raising the size without a cleanup often just delays the failure.",
 (True,"raised cache to 20 GB, deployment went through")),

# ===================== INTUNE / MDM =====================
("intune","Intune","A device shows as compliant in Intune but policies are not applied locally",
 ["Check the MDM enrolment state","Look at the sync result","Identify the stale enrolment"],
 [("Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Enrollments' | Where-Object { (Get-ItemProperty $_.PSPath).EnrollmentState -eq 1 } | Select-Object PSChildName",0,"PSChildName\n-----------\n{A1B2C3D4-...}",""),
  ("Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\EnterpriseMgmt\\*' | Select-Object TaskName, State | Select-Object -First 3",0,"TaskName                         State\n--------                         -----\nSchedule #1 created by enrollment Ready",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-DeviceManagement-Enterprise-Diagnostics-Provider/Admin'} -MaxEvents 3 | Select-Object -ExpandProperty Message",0,"MDM Session: OMA-DM message failed. Result: (Unknown Win32 Error code: 0x80190190).","")],
 True,
 "The enrolment record exists, which is why the portal still lists the device as compliant from its last good check-in, but every sync since has failed with HTTP 400 from the MDM service. The compliance status is stale, not current.",
 "Retire and re-enrol the device - a session failing at the protocol level will not recover on its own. Treat the portal's compliant status as unreliable here; check the last sync timestamp rather than the badge.",
 (True,"re-enrolled and it started applying policy again")),

("mdm","MDM","Company Portal says the device is not compliant but does not say why",
 ["Check which compliance policies target the device","Look at the local evaluation result","Identify the failing rule"],
 [("Get-BitLockerVolume -MountPoint C | Select-Object VolumeStatus, ProtectionStatus",0,"VolumeStatus           ProtectionStatus\n------------           ----------------\nFullyDecrypted                       0",""),
  ("Get-MpComputerStatus | Select-Object AntivirusEnabled, RealTimeProtectionEnabled",0,"AntivirusEnabled RealTimeProtectionEnabled\n---------------- -------------------------\n            True                      True",""),
  ("Get-CimInstance Win32_OperatingSystem | Select-Object Version, BuildNumber",0,"Version    BuildNumber\n-------    -----------\n10.0.22631       22631","")],
 True,
 "Defender is on and the build is current, but the system drive is fully decrypted with no BitLocker protection. Encryption is the most common mandatory compliance rule, and it is the only one of the three that is failing.",
 "Enable BitLocker on the system drive and let it complete encryption before re-checking compliance. If the device has no TPM the policy needs a startup PIN configured, otherwise encryption will not begin and the device stays non-compliant indefinitely.",
 (True,"TPM was disabled in firmware, enabled it and encryption started")),

# ===================== DFS =====================
("dfs","DFS","The DFS namespace path opens on some machines and not others",
 ["Check which target the client selects","Compare site awareness between machines","Identify the referral problem"],
 [("Get-DfsnFolderTarget -Path '\\\\corp.local\\shares\\finance' -ErrorAction SilentlyContinue | Select-Object TargetPath, State",0,"TargetPath                    State\n----------                    -----\n\\\\fs01\\finance              Online\n\\\\fs02\\finance             Offline",""),
  ("Test-NetConnection fs02 -Port 445 -InformationLevel Quiet",1,"","False"),
  ("nltest /dsgetsite",0,"Branch-Office\nThe command completed successfully","")],
 True,
 "Two folder targets exist and fs02 is offline and unreachable. Machines in the Branch-Office site are referred to fs02 first because of site costing, so they fail while machines elsewhere are referred to fs01 and work normally.",
 "Bring fs02 back online, or disable that folder target in the namespace until it is repaired. Leaving a dead target enabled means site-local clients keep being sent to it - DFS referral order is by site cost, not by availability.",
 (True,"fs02 had a failed NIC, disabled the target meanwhile")),

("dfs","DFS Replication","Files changed on one server never appear on the replica partner",
 ["Check the replication backlog","Look at the staging quota","Identify what stalls it"],
 [("Get-DfsrState -ComputerName fs01 -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count\n-----\n    0",""),
  ("Get-WinEvent -FilterHashtable @{LogName='DFS Replication'} -MaxEvents 3 | Select-Object -ExpandProperty Message",0,"The DFS Replication service has detected that the staging space in use for the replicated folder is above the high watermark.",""),
  ("Get-DfsrConnection -GroupName 'Finance' | Select-Object SourceComputerName, DestinationComputerName, Enabled",0,"SourceComputerName DestinationComputerName Enabled\n------------------ ----------------------- -------\nfs01               fs02                       True","')")],
 True,
 "Replication is enabled and connected, but the staging folder is above its high watermark. DFSR stages every file before sending it, so once staging is full it spends its time evicting rather than replicating - the queue drains to zero and nothing moves.",
 "Increase the staging quota to at least the size of the 32 largest files in the replicated folder, which is Microsoft's sizing rule. Simply clearing staging gives temporary relief and the same stall returns on the next large batch.",
 (True,"staging was at the 4 GB default with 2 GB CAD files")),

# ===================== iSCSI / RAID =====================
("iscsi","iSCSI","An iSCSI volume disappears after every reboot",
 ["Check whether the target is set to reconnect","Look at the volume mount behaviour","Identify what is not persistent"],
 [("Get-IscsiTarget | Select-Object NodeAddress, IsConnected",0,"NodeAddress                          IsConnected\n-----------                          -----------\niqn.2001-05.com.equallogic:0-vol1           True",""),
  ("Get-IscsiSession | Select-Object IsPersistent, TargetNodeAddress",0,"IsPersistent TargetNodeAddress\n------------ -----------------\n       False iqn.2001-05.com.equallogic:0-vol1",""),
  ("Get-Service MSiSCSI | Select-Object Status, StartType",0,"Status  StartType\n------  ---------\nRunning    Manual","")],
 True,
 "The session works but is not persistent, and the initiator service is set to Manual rather than Automatic. Neither survives a reboot, so the target is never reconnected and the volume is simply absent until someone connects it by hand.",
 "Set MSiSCSI to Automatic and reconnect the target with the persistent option ticked. If a service depends on that volume, also configure it to depend on MSiSCSI so it does not start before the disk is available.",
 (True,"persistent connect plus automatic service, survives reboots now")),

("raid","RAID","A RAID array reports degraded but Windows still sees the volume normally",
 ["Confirm which member has failed","Check whether the array is rebuilding","Understand the current risk"],
 [("Get-PhysicalDisk | Select-Object DeviceId, FriendlyName, HealthStatus, OperationalStatus",0,"DeviceId FriendlyName HealthStatus OperationalStatus\n-------- ------------ ------------ -----------------\n0        WDC WD40      Healthy      OK\n1        WDC WD40      Unhealthy    Lost Communication",""),
  ("Get-VirtualDisk | Select-Object FriendlyName, HealthStatus, OperationalStatus, ResiliencySettingName",0,"FriendlyName HealthStatus OperationalStatus ResiliencySettingName\n------------ ------------ ----------------- ---------------------\nDataVol      Warning      Degraded          Mirror",""),
  ("Get-StorageJob -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count\n-----\n    0","")],
 False,
 "One mirror member has lost communication, so the volume is running on a single disk. It reads and writes normally, which is exactly what a mirror is for - but there is no redundancy left, and no rebuild job is running because there is no spare to rebuild onto.",
 "Replace the failed disk now and let the mirror rebuild. The volume working normally is not a sign that this can wait - a second disk failure while degraded loses everything, and the surviving disk is the same age and workload as the one that just failed.",
 (False,"replacement disk ordered, rebuilding once it arrives")),

# ===================== CLUSTER =====================
("cluster","failover clustering","A clustered role keeps failing over between nodes every few minutes",
 ["Check the resource that triggers the failover","Look at the health check settings","Identify the flapping resource"],
 [("Get-ClusterGroup | Select-Object Name, OwnerNode, State",0,"Name        OwnerNode State\n----        --------- -----\nSQLGroup    node02    Online",""),
  ("Get-ClusterResource | Where-Object State -ne 'Online' | Select-Object Name, State, ResourceType",0,"Name           State   ResourceType\n----           -----   ------------\nSQL IP Address Failed  IP Address",""),
  ("Get-ClusterLog -Destination C:\\Temp -TimeSpan 15 | Out-Null; Select-String 'IsAlive' 'C:\\Temp\\node02_cluster.log' | Select-Object -Last 2",0,"[RES] IP Address: IsAlive check failed - no response from gateway","')")],
 True,
 "The IP address resource fails its IsAlive check because the gateway does not respond, which fails the whole group over. The new node then fails the same check, so the role bounces between nodes rather than settling anywhere.",
 "Fix the network path to the gateway on the cluster network - the failover is the cluster correctly reacting to a network fault, not a cluster misconfiguration. Increasing the health check thresholds would mask a real connectivity problem.",
 (True,"a switch uplink was flapping, network team fixed it")),

# ===================== VMWARE =====================
("vmware","VMware","A Windows VM runs slowly and the guest reports high CPU ready time",
 ["Check the guest's own CPU state","Look at whether the tools are current","Distinguish guest from host contention"],
 [("Get-CimInstance Win32_Processor | Select-Object NumberOfLogicalProcessors, LoadPercentage",0,"NumberOfLogicalProcessors LoadPercentage\n------------------------- --------------\n                        8             12",""),
  ("Get-Service VMTools -ErrorAction SilentlyContinue | Select-Object Status, StartType",0,"Status  StartType\n------  ---------\nRunning Automatic",""),
  ("Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\" | Select-Object PercentProcessorTime",0,"PercentProcessorTime\n--------------------\n                  11","")],
 True,
 "Inside the guest the CPU is only 12% busy, yet the machine feels slow. That gap is the signature of CPU ready time - the VM is waiting for physical cores to become available. It is a host scheduling problem, and nothing measured inside Windows will show it directly.",
 "Reduce the vCPU count for this VM. Oversized VMs wait longer to be scheduled because the host must free that many cores simultaneously, so fewer vCPUs usually makes an over-provisioned host feel faster, not slower.",
 (True,"dropped from 8 vCPU to 4 and it got noticeably quicker")),

("vmware","VMware","Time inside the VM drifts even though NTP is configured",
 ["Check which time source the guest uses","Look for a competing sync provider","Identify the conflict"],
 [("w32tm /query /status | Select-String 'Source'",0,"Source: time.corp.local",""),
  ("Get-Service VMTools | Select-Object Status",0,"Status\n------\nRunning",""),
  ("w32tm /query /configuration | Select-String 'Type|VMICTimeProvider' -Context 0,1",0,"Type: NT5DS (Policy)\nVMICTimeProvider Enabled: 1","")],
 True,
 "Two time providers are active at once: Windows Time syncing from the domain hierarchy, and the hypervisor's own periodic sync through the tools. They correct each other in opposite directions, which produces drift rather than accuracy.",
 "Pick one. For a domain-joined guest, disable the host time synchronisation in the VM's tools settings and let W32Time handle it; for a standalone guest, do the reverse. Running both is the actual cause here, not a misconfigured NTP server.",
 (True,"disabled host sync, clock is steady now")),

# ===================== MONITORING =====================
("monitoring","performance monitoring","Performance counters are missing and monitoring tools report no data",
 ["Check whether the counter registry is intact","Look for disabled performance libraries","Rebuild if corrupt"],
 [("Get-Counter -ListSet 'Processor' -ErrorAction SilentlyContinue | Select-Object CounterSetName",1,"","The specified object was not found on the computer."),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Perflib\\009' -Name Counter -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Counter | Measure-Object | Select-Object Count",0,"Count\n-----\n    0",""),
  ("Get-Service pla | Select-Object Status, StartType",0,"Status  StartType\n------  ---------\nStopped   Disabled","")],
 True,
 "The English counter name table is empty, so counters cannot be resolved by name at all, and the Performance Logs and Alerts service is disabled. Every monitoring agent asking for a named counter gets nothing back.",
 "Rebuild the counters with 'lodctr /R' from an elevated prompt and set the pla service back to Manual. Run lodctr /R once and check the result - running it repeatedly on an already-rebuilt registry can make things worse rather than better.",
 (True,"lodctr /R restored them, monitoring came back")),

("monitoring","Reliability Monitor","Reliability Monitor shows no history at all",
 ["Check whether the data collector is running","Look at the scheduled task that populates it","Identify what stopped collection"],
 [("Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\RAC\\*' | Select-Object TaskName, State",0,"TaskName       State\n--------       -----\nRacTask      Disabled",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Reliability Analysis\\WMI' -Name WMIEnable -ErrorAction SilentlyContinue",0,"WMIEnable : 0",""),
  ("Get-Service RacTask -ErrorAction SilentlyContinue",1,"","(no such service - it is a scheduled task, not a service)")],
 True,
 "Reliability Monitor is fed by the RacTask scheduled task and the WMIEnable flag, and both are switched off. No data has been collected, which is why the timeline is empty rather than showing a healthy system.",
 "Set WMIEnable to 1 and enable RacTask, then allow 24 hours for the first data points to appear. Both are commonly turned off by optimisation scripts that treat the collector as unnecessary background activity.",
 (True,"a tweaking script had disabled it, history is building again")),

# ===================== FONTS =====================
("fonts","fonts","A font is installed but does not appear in any application",
 ["Check where the font was installed","Look at whether it is registered for all users","Identify the scope problem"],
 [("Get-ChildItem \"$env:LOCALAPPDATA\\Microsoft\\Windows\\Fonts\" -Filter '*.ttf' | Select-Object -First 3 Name",0,"Name\n----\nBrandSans-Regular.ttf",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -ErrorAction SilentlyContinue | Get-Member -Name '*BrandSans*'",1,"","(not registered machine-wide)"),
  ("Get-ChildItem 'C:\\Windows\\Fonts' -Filter 'BrandSans*'",1,"","(not present)")],
 True,
 "The font was installed for the current user only, into the local AppData font folder, and registered under HKCU. Applications running elevated or as a service load fonts from the machine store, so they never see it.",
 "Reinstall it with 'Install for all users' from the right-click menu, which places it in C:\\Windows\\Fonts and registers it machine-wide. Per-user fonts also do not survive being used by print spoolers or PDF generators running as SYSTEM.",
 (True,"install for all users made it show up everywhere")),

("fonts","fonts","Text in some applications shows as boxes or question marks",
 ["Check whether the required font is present","Look at the language support installed","Identify the missing glyphs"],
 [("Get-ChildItem 'C:\\Windows\\Fonts' -Filter '*.ttf' | Measure-Object | Select-Object Count",0,"Count\n-----\n   84",""),
  ("Get-WindowsCapability -Online | Where-Object Name -like 'Language.Fonts*' | Select-Object Name, State | Select-Object -First 4",0,"Name                          State\n----                          -----\nLanguage.Fonts.Jpan~~~und-JPAN NotPresent\nLanguage.Fonts.Hans~~~und-HANS NotPresent",""),
  ("Get-WinUserLanguageList | Select-Object LanguageTag",0,"LanguageTag\n-----------\nen-GB","")],
 True,
 "The boxes are missing glyphs, not a rendering fault - the supplemental font packages for Japanese and Simplified Chinese are not installed, so any text in those scripts has no font that can draw it. Only 84 fonts are present, which is a stripped-down set.",
 "Add the relevant font capabilities through Optional features, or install the language pack which brings them in. This appears after clean installs and after image-based deployments that strip optional font packages to save space.",
 (True,"added the CJK fonts, documents render properly now")),

# ===================== GPO ADVANCED =====================
("gpo-advanced","Group Policy","A Group Policy setting applies but is immediately reverted",
 ["Check whether two policies target the same setting","Look at the winning GPO","Identify the conflict"],
 [("gpresult /r /scope:computer | Select-String -Pattern 'Applied Group Policy Objects' -Context 0,6",0,"Applied Group Policy Objects\n    Default Domain Policy\n    Workstation Baseline\n    Security Hardening\n    Legacy Settings",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-GroupPolicy/Operational'; Id=5312} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"List of applicable Group Policy objects: Security Hardening, Legacy Settings",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU' -Name NoAutoUpdate -ErrorAction SilentlyContinue",0,"NoAutoUpdate : 1","")],
 True,
 "Two GPOs set the same value in opposite directions. Group Policy applies them in order and the last one processed wins, so the setting appears to revert - it is being overwritten by 'Legacy Settings' after the intended policy applies.",
 "Remove the setting from the older GPO rather than raising the precedence of the newer one. Winning by link order works but leaves a contradiction that the next administrator will hit; removing the duplicate makes the intent readable.",
 (True,"an old GPO nobody had reviewed in years")),

("gpo-advanced","Group Policy","Loopback processing is enabled but user settings still do not apply",
 ["Check the loopback mode configured","Confirm the user policies are linked where they are needed","Identify the scoping error"],
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System' -Name UserPolicyMode -ErrorAction SilentlyContinue",0,"UserPolicyMode : 1",""),
  ("gpresult /r /scope:user | Select-String -Pattern 'Applied Group Policy Objects' -Context 0,3",0,"Applied Group Policy Objects\n    N/A",""),
  ("nltest /dsgetsite",0,"HQ\nThe command completed successfully","")],
 True,
 "UserPolicyMode 1 is Replace mode, which discards the user's own GPOs and applies only user settings linked to the computer's OU. No user-configuration GPOs are linked there, so the result is nothing at all rather than the intended settings.",
 "Link the user-configuration GPO to the computer's OU, or switch to Merge mode if the user's normal policies should still apply. Replace mode with nothing linked is the usual cause of loopback appearing to break everything.",
 (True,"switched to Merge, that was what we actually wanted")),

# ===================== REMOTE ASSIST =====================
("remote-assist","Remote Assistance","Quick Assist connects then drops after a few seconds every time",
 ["Check the network path for the relay","Look for an inspection device in the way","Identify what interrupts the session"],
 [("Test-NetConnection remoteassistance.support.services.microsoft.com -Port 443 -InformationLevel Quiet",0,"True",""),
  ("Get-NetFirewallProfile | Select-Object Name, Enabled",0,"Name    Enabled\n----    -------\nDomain     True\nPrivate    True\nPublic     True",""),
  ("Resolve-DnsName remoteassistance.support.services.microsoft.com | Select-Object -First 1 Name, IPAddress",0,"Name                                             IPAddress\n----                                             ---------\nremoteassistance.support.services.microsoft.com  10.20.5.14","')")],
 True,
 "The service name resolves to an internal 10.x address, which means a proxy or inspection appliance is intercepting the connection. The initial handshake completes but the long-lived relay stream is torn down by the inspection device, so the session drops seconds after connecting.",
 "Add the Quick Assist endpoints to the TLS inspection bypass list on the proxy. Interactive relay traffic does not survive being terminated and re-established mid-stream, which is why it connects and then fails rather than failing outright.",
 (True,"network team bypassed inspection for those hosts")),

("remote-assist","Remote Desktop","RDP works from inside the office but times out over VPN",
 ["Check the route to the target over the tunnel","Look at the MTU on the tunnel","Identify where the session breaks"],
 [("Test-NetConnection 10.4.2.30 -Port 3389 -InformationLevel Quiet",0,"True",""),
  ("Get-NetIPInterface -InterfaceAlias 'VPN Tunnel' | Select-Object NlMtu",0,"NlMtu\n-----\n 1420",""),
  ("ping 10.4.2.30 -f -l 1400",1,"","Packet needs to be fragmented but DF set."),
  ("ping 10.4.2.30 -f -l 1372",0,"Reply from 10.4.2.30: bytes=1372 time=42ms TTL=127","")],
 True,
 "Port 3389 is reachable and small packets pass, but anything above roughly 1372 bytes is dropped with the do-not-fragment bit set. RDP negotiates fine on small packets then stalls as soon as it sends a full-size screen update - which is why it connects and then times out.",
 "Lower the tunnel MTU to 1400 or enable MSS clamping on the VPN device. The interface claims 1420 but the real path supports less, and path MTU discovery is being blocked somewhere in between.",
 (True,"MSS clamping on the firewall fixed it for everyone")),

# ===================== LOAD BALANCER =====================
("loadbalancer","load balancing","Users behind a load balancer are randomly logged out of the web application",
 ["Check whether sessions are pinned to a backend","Look at how many backends serve the site","Identify the session loss"],
 [("Resolve-DnsName app.corp.local | Select-Object Name, IPAddress",0,"Name           IPAddress\n----           ---------\napp.corp.local 10.4.9.20",""),
  ("1..4 | ForEach-Object { (Invoke-WebRequest 'http://app.corp.local/whoami' -UseBasicParsing).Content }",0,"web01\nweb03\nweb02\nweb01",""),
  ("Invoke-WebRequest 'http://app.corp.local/' -UseBasicParsing | Select-Object -ExpandProperty Headers | Select-String 'Set-Cookie'",1,"","(no session affinity cookie present)")],
 True,
 "Four consecutive requests land on three different backends and there is no affinity cookie. The application stores sessions in memory on each server, so a user is logged out whenever the balancer sends them somewhere new - which is most requests.",
 "Either enable session affinity on the load balancer, or move session state to a shared store such as Redis or SQL. The shared store is the better answer because affinity breaks again the moment a backend is taken out for patching.",
 (True,"moved sessions to Redis, no more random logouts")),

# ===================== SYSTEM / TIME (thin) =====================
("system","system health","The system feels fine but Event Viewer is full of critical errors",
 ["Check what the critical events actually are","Assess whether they indicate a live fault","Decide what needs action"],
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Level=1} -MaxEvents 5 | Group-Object Id | Select-Object Count, Name",0,"Count Name\n----- ----\n    4 41\n    1 1001",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; Id=41} -MaxEvents 2 | Select-Object TimeCreated",0,"TimeCreated\n-----------\n5/14/2026 7:02:11 PM\n5/12/2026 6:48:03 PM",""),
  ("Get-CimInstance Win32_OperatingSystem | Select-Object LastBootUpTime",0,"LastBootUpTime\n--------------\n8/2/2026 8:14:00 AM","")],
 True,
 "All the critical events are Kernel-Power 41 from three months ago, recorded when the machine lost power unexpectedly. There is nothing recent, and the system has been up continuously since early August. The log is history, not a current fault.",
 "No action needed. Event Viewer keeps entries for months, so a full-looking log says little without checking the timestamps - always sort by date before treating critical events as a live problem.",
 (True,"those were from a power cut in the spring")),

("time","time zone","Meeting times are an hour out for some colleagues but not others",
 ["Check the time zone and DST setting","Compare against the actual offset","Identify the misconfiguration"],
 [("Get-TimeZone | Select-Object Id, DisplayName, SupportsDaylightSavingTime",0,"Id                       DisplayName                          SupportsDaylightSavingTime\n--                       -----------                          --------------------------\nUTC                      (UTC) Coordinated Universal Time                          False",""),
  ("Get-Date -Format 'yyyy-MM-dd HH:mm zzz'",0,"2026-08-18 08:00 +00:00",""),
  ("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation' -Name TimeZoneKeyName",0,"TimeZoneKeyName : UTC","")],
 True,
 "The machine is set to UTC, which does not observe daylight saving. During BST the local clock is an hour behind everyone in the UK, so calendar entries created here are written an hour out - and only in summer, which is why it was not noticed before.",
 "Set the time zone to GMT Standard Time, which handles the DST transition automatically. UTC looks like a safe neutral choice but it is a fixed offset, so anything scheduled from this machine drifts for half the year.",
 (True,"someone had set UTC thinking it was 'the correct one'")),

# ===================== EVERYDAY =====================
("windows","Start menu","The Start menu opens but is completely empty",
 ["Check whether the shell package is registered","Look at the tile database","Identify the broken component"],
 [("Get-AppxPackage -Name 'Microsoft.Windows.StartMenuExperienceHost' | Select-Object Status, InstallLocation",0,"Status InstallLocation\n------ ---------------\n    Ok C:\\Windows\\SystemApps\\...",""),
  ("Get-Process StartMenuExperienceHost -ErrorAction SilentlyContinue | Select-Object Id, Responding",0,"  Id Responding\n  -- ----------\n4218       True",""),
  ("Get-ChildItem \"$env:LOCALAPPDATA\\Packages\\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\\TempState\" -Filter '*.db' -ErrorAction SilentlyContinue | Select-Object Name, Length",0,"Name             Length\n----             ------\nstart.db              0","")],
 True,
 "The package is registered and the process is running and responsive, so the shell itself is healthy - but the tile database file is zero bytes. It was truncated, most likely by an unclean shutdown, and an empty database renders as an empty menu.",
 "Delete the zero-byte database file and sign out; it is rebuilt from the installed applications at next sign-in. Re-registering all Appx packages is the usual advice for Start menu problems and it is far more disruptive than deleting one corrupt file.",
 (True,"deleted the file, menu rebuilt itself on next login")),

("windows","clipboard","Copy and paste stops working across all applications",
 ["Check whether the clipboard chain is being blocked","Look for a process holding the clipboard","Identify the holder"],
 [("Get-Process rdpclip -ErrorAction SilentlyContinue | Select-Object Id, StartTime, Responding",0,"  Id StartTime           Responding\n  -- ---------           ----------\n3904 8/18/2026 8:02:11 AM     False",""),
  ("Get-Service cbdhsvc* | Select-Object Name, Status",0,"Name           Status\n----           ------\ncbdhsvc_4a2f1 Running",""),
  ("Get-CimInstance Win32_Process -Filter \"Name='rdpclip.exe'\" | Select-Object ProcessId, CommandLine",0,"ProcessId CommandLine\n--------- -----------\n     3904 rdpclip","')")],
 True,
 "The remote desktop clipboard bridge process is running but unresponsive. It holds the clipboard chain, so every copy operation waits on a process that never answers and nothing reaches the clipboard - including local copies between local applications.",
 "End rdpclip.exe; it restarts automatically inside the RDP session and the clipboard recovers immediately. Restarting Explorer is the usual first suggestion and it does not help, because Explorer is not what is holding the chain.",
 (True,"killed rdpclip, working instantly")),

("windows","notifications","Notifications stopped appearing for every application",
 ["Check whether a quiet mode is active","Look at the notification platform state","Identify the suppression"],
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications' -Name ToastEnabled -ErrorAction SilentlyContinue",0,"ToastEnabled : 0",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings' -Name NOC_GLOBAL_SETTING_TOASTS_ENABLED -ErrorAction SilentlyContinue",0,"NOC_GLOBAL_SETTING_TOASTS_ENABLED : 0",""),
  ("Get-Process ShellExperienceHost -ErrorAction SilentlyContinue | Select-Object Id, Responding",0,"  Id Responding\n  -- ----------\n5012       True","')")],
 True,
 "Toast notifications are disabled at both the platform level and the global user setting. The shell is running normally - notifications are being suppressed by configuration rather than failing to be delivered.",
 "Set both values to 1 and sign out and back in, or re-enable notifications in Settings which writes both. Checking Focus Assist first is reasonable, but it schedules quiet hours rather than switching the platform off entirely as these keys do.",
 (True,"a privacy script had turned both off")),

("windows","printing","Printing produces a blank page every time but the print queue clears normally",
 ["Check which driver the printer uses","Look at the print processor and data type","Identify the rendering problem"],
 [("Get-Printer | Select-Object Name, DriverName, PrintProcessor",0,"Name          DriverName            PrintProcessor\n----          ----------            --------------\nOffice-HP     HP Universal PCL 6    winprint",""),
  ("Get-PrintJob -PrinterName 'Office-HP' -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count\n-----\n    0",""),
  ("Get-PrinterProperty -PrinterName 'Office-HP' -PropertyName 'Config:RenderOnServer' -ErrorAction SilentlyContinue | Select-Object Value",0,"Value\n-----\nTrue","')")],
 True,
 "Jobs are being rendered on the print server rather than the client, and the server's driver version does not match the client's. The job spools and completes - hence the queue clearing - but the rendered output is empty because the two drivers disagree on the data.",
 "Set 'Render print jobs on client computers' for this printer, or align the driver versions on the server and clients. A blank page with a clean queue points at rendering, not at the printer, which is why hardware checks lead nowhere here.",
 (True,"client-side rendering fixed it across the office")),
]

with open(JSON_PATH, encoding="utf-8") as f: data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f: jsonl_lines = [l for l in f if l.strip()]
before = len(data)

# backup before touching project data
ts = datetime.now().strftime("%Y%m%d-%H%M%S")
bdir = os.path.join(STORE, f"_backup-{ts}"); os.makedirs(bdir, exist_ok=True)
shutil.copy2(JSON_PATH, bdir); shutil.copy2(JSONL_PATH, bdir)

existing = {d["goal"] for d in data}
prefix = collections.defaultdict(list)
for g in existing: prefix[' '.join(g.lower().split()[:4])].append(g)

base = datetime(2026, 8, 19, 9, 0, 0)
added = skipped = 0; near = []
for i, (dom, sub, goal, plan, cmds, resolved, summary, rec, fb) in enumerate(NEW):
    if goal in existing: skipped += 1; continue
    k = ' '.join(goal.lower().split()[:4])
    if k in prefix: near.append((goal, prefix[k][0]))
    created = base + timedelta(minutes=7*i)
    steps = [{"command": c, "blocked": False, "exitCode": e, "stdout": o, "stderr": er, "reason": None}
             for c, e, o, er in cmds]
    data.append({"id": str(uuid.uuid4()),
        "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal, "domain": dom, "subdomain": sub, "plan": list(plan),
        "steps": steps, "resolved": resolved, "summary": summary, "recommendation": rec,
        "feedback": {"worked": fb[0], "note": fb[1],
                     "at": (created+timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}})
    existing.add(goal); prefix[k].append(goal); added += 1
    cl = "\n".join(f"- {c[0]}" + (f"  [FAILED: {c[3][:70]}]" if c[1] else "") for c in cmds)
    note = "" if resolved else "\nNOTE: not resolved - see recommendation."
    jsonl_lines.append(json.dumps({"messages":[
        {"role":"system","content":f"You are a Windows repair expert specializing in {dom} ({sub}) problems. Diagnose with read-only commands first, then apply safe fixes. When a command fails, interpret the error and adapt."},
        {"role":"user","content":goal},
        {"role":"assistant","content":f"{summary}\nCommands used:\n{cl}\nRecommendation: {rec}{note}"}]}, ensure_ascii=False)+"\n")

with open(JSON_PATH,"w",encoding="utf-8") as f: json.dump(data,f,indent=2,ensure_ascii=False); f.write("\n")
with open(JSONL_PATH,"w",encoding="utf-8") as f: f.writelines(jsonl_lines)
print(f"merged into project folder: {before} -> {len(data)}  (added {added}, dups {skipped})")
for a,b in near: print("  NEAR:", a[:52], "<>", b[:52])
print(f"backup: _backup-{ts}")
