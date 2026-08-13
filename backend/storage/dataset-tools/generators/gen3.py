import json
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

NEW = [
("sql","SQL Server queries are randomly timing out under moderate load, no obvious single culprit",
 "Correlating perfmon counters with SQL Server's own wait statistics showed the bottleneck wasn't connections or CPU but storage latency (PAGEIOLATCH_SH waits lining up with elevated Avg. Disk sec/Read), meaning queries are stalling waiting for data pages to be read from a slow disk subsystem under load.",
 [("Get-Counter -Counter '\\SQLServer:General Statistics\\User Connections','\\SQLServer:Locks(_Total)\\Lock Waits/sec','\\PhysicalDisk(_Total)\\Avg. Disk sec/Read' -SampleInterval 2 -MaxSamples 3 | Select-Object -ExpandProperty CounterSamples | Select-Object Path, CookedValue","Path                                          CookedValue\n----                                          -----------\n\\\\sql01\\sqlserver:locks(_total)\\lock waits/sec       241.6\n\\\\sql01\\physicaldisk(_total)\\avg. disk sec/read       0.045",""),
  ("Invoke-Sqlcmd -Query \"SELECT TOP 5 wait_type, wait_time_ms FROM sys.dm_os_wait_stats ORDER BY wait_time_ms DESC\"","wait_type       wait_time_ms\n---------       ------------\nPAGEIOLATCH_SH       8842011","")],
 "Move tempdb and/or the busiest database files to faster storage (SSD/NVMe), and check whether antivirus real-time scanning is including the SQL data/log file paths, which compounds read latency."),
("sql","tempdb keeps filling up and SQL Server throws 'insufficient space in database'",
 "A single long-running query with a large sort/hash spill was consuming the bulk of tempdb space, rather than tempdb being generally undersized for normal workload.",
 [("Invoke-Sqlcmd -Query \"SELECT name, size/128.0 AS SizeMB FROM tempdb.sys.database_files\"","name       SizeMB\n----       ------\ntempdev   38912.0\ntemplog   40960.0",""),
  ("Invoke-Sqlcmd -Query \"SELECT TOP 5 session_id, request_id, SUM(internal_objects_alloc_page_count) AS pages FROM sys.dm_db_task_space_usage GROUP BY session_id, request_id ORDER BY pages DESC\"","session_id request_id pages\n---------- ---------- -----\n        87          0 912340","")],
 "Identify and tune or kill the offending query (check its execution plan for missing indexes causing the spill), and consider pre-sizing tempdb with multiple equally-sized data files (one per up to 8 cores) as a longer-term best practice."),
("sql","An Always On Availability Group secondary replica shows 'Not Synchronizing'",
 "The secondary replica's log-shipping was blocked because its database files had lost the write permission the SQL Server service account needs, most likely after a security/GPO permissions change on that drive.",
 [("Get-DbaAgReplica -SqlInstance SQL01 | Select-Object AvailabilityGroup, Name, Role, RollupSynchronizationState","AvailabilityGroup Name  Role      RollupSynchronizationState\n----------------- ----  ----      ---------------------------\nAG-Prod           SQL02 Secondary NotSynchronizing",""),
  ("Get-WinEvent -LogName 'Microsoft-Windows-FailoverClustering/Diagnostic' -MaxEvents 5","Repeated errors: Access to the path 'D:\\SQLData\\AG-Prod.mdf' is denied","")],
 "Restore the SQL Server service account's NTFS permissions on the secondary's data/log folders, then resume data movement with 'Resume-SqlAvailabilityGroup' once access is confirmed."),
("exchange","Mail is piling up in the Exchange transport queue and not delivering",
 "Mail destined for one specific partner domain is stuck retrying because Exchange can't resolve that domain's MX record, pointing to a DNS resolution problem for that destination rather than a general Exchange outage (other queues are flowing normally).",
 [("Get-Queue | Where-Object MessageCount -gt 0 | Select-Object Identity, MessageCount, Status, NextHopDomain","Identity        MessageCount Status NextHopDomain\n--------        ------------ ------ -------------\nMBX01\\Queue-14           412 Retry  partner-corp.com",""),
  ("Resolve-DnsName partner-corp.com -Type MX","Resolve-DnsName : partner-corp.com : DNS name does not exist","")],
 "Confirm the partner domain's MX records are valid from an external resolver, and check whether Exchange's configured DNS forwarders can reach the public internet reliably."),
("exchange","A single mailbox database won't mount after an unexpected server reboot",
 "The database is in a Dirty Shutdown state, meaning transaction logs weren't fully committed before the reboot; Exchange won't auto-mount a dirty database without either replaying the remaining logs or a repair.",
 [("Get-MailboxDatabase -Status | Select-Object Name, Mounted","Name      Mounted\n----      -------\nMailbox01   False",""),
  ("eseutil /mh 'D:\\ExchDB\\Mailbox01.edb'","State: Dirty Shutdown","")],
 "If the log files (.log) from before the crash are still present, run 'eseutil /r' to replay them and bring the database to a clean shutdown state before mounting; only use 'eseutil /p' (repair, which can lose data) as a last resort."),
("exchange","Emails from one specific domain keep getting sent to Junk despite being legitimate",
 "The sending domain has no valid SPF record published, so the anti-spam engine is scoring their mail down as a spoofing risk -- the filtering is working as intended against their misconfigured DNS, not a false positive on your end.",
 [("Get-MessageTrace -SenderAddress *@partner.com -StartDate (Get-Date).AddDays(-1) -EndDate (Get-Date) | Select-Object -First 3 Status","Status\n------\nFilteredAsSpam",""),
  ("Resolve-DnsName partner.com -Type TXT","(no SPF-formatted TXT record returned)","")],
 "Ask the partner's mail admin to publish a correct SPF (and ideally DKIM/DMARC) record for their domain; in the meantime a targeted allow entry can be added for that sender in the anti-spam policy."),
("exchange","Autodiscover works internally but external Outlook clients can't configure new mailboxes",
 "The internal DNS has an autodiscover record, but no corresponding public DNS record exists, so external clients have no way to find the Autodiscover endpoint at all -- an external DNS publishing gap, not an Exchange configuration issue.",
 [("Test-NetConnection autodiscover.company.com -Port 443","TcpTestSucceeded : True",""),
  ("Resolve-DnsName autodiscover.company.com -Server 8.8.8.8","Resolve-DnsName : autodiscover.company.com : DNS name does not exist","")],
 "Publish a public 'autodiscover.company.com' CNAME/A record pointing at the externally reachable Exchange endpoint so external Outlook clients can complete Autodiscover."),
("sccm","An application deployment shows 'Failed' on client machines with no clear error",
 "A previous, still-running MSI installation on the client was holding the installer mutex, so the new SCCM-deployed app's install failed immediately with generic error 1603 rather than a problem with the package itself.",
 [("Get-Content 'C:\\Windows\\CCM\\Logs\\AppEnforce.log' -Tail 15","Exit code 1603 -- unable to acquire installer mutex, another installation in progress",""),
  ("Get-Process msiexec -ErrorAction SilentlyContinue","Id   ProcessName\n--   -----------\n5210 msiexec","")],
 "Ensure any pending installs/reboots on the client are cleared before redeploying (check for a pending reboot flag), then retry the deployment."),
("sccm","SCCM client shows as 'Inactive' in the console even though the machine is online and used daily",
 "The SCCM client service is running locally and healthy, but it can't reach the Management Point (the server-side component that records heartbeats), so the console shows it as Inactive purely from a missing heartbeat, not a broken client.",
 [("Get-Service CcmExec | Select-Object Status, StartType","Status  StartType\n------  ---------\nRunning Automatic",""),
  ("Get-Content 'C:\\Windows\\CCM\\Logs\\ClientLocation.log' -Tail 10","Failed to locate Management Point over HTTPS, error 0x80072EE2","")],
 "Verify network/firewall connectivity from this client to the Management Point's HTTPS port, and check the Management Point's own health in the SCCM console for a site-wide issue."),
("azuread","Users report their password changes on-premises aren't reflected in Microsoft 365 for hours",
 "Azure AD Connect's sync scheduler had its interval changed to a much longer window than the default, so password/attribute changes are batching up for hours before syncing to Azure AD -- this is a scheduler configuration change, not a sync failure.",
 [("Get-ADSyncScheduler | Select-Object SyncCycleEnabled, CustomizedSyncCycleInterval","SyncCycleEnabled CustomizedSyncCycleInterval\n----------------- ----------------------------\n             True                     03:00:00","")],
 "Reset the sync interval back to the default with 'Set-ADSyncScheduler -CustomizedSyncCycleInterval 00:30:00', or trigger an immediate delta sync manually with 'Start-ADSyncSyncCycle -PolicyType Delta' when an urgent change needs to propagate."),
("azuread","Azure AD Connect shows sync errors for a subset of users with 'attribute value must be unique'",
 "Two separate on-premises AD accounts have been assigned the same mail/proxyAddress value (likely from a duplicate account created during a migration), and Azure AD correctly rejects the second sync since that attribute must be unique across the tenant.",
 [("Get-ADUser -Filter {mail -eq 'jdoe@company.com'} -Properties mail | Select-Object SamAccountName, mail","SamAccountName mail\n-------------- ----\njdoe           jdoe@company.com\njdoe.old       jdoe@company.com","")],
 "Identify which of the two accounts is the correct, active one and correct or remove the duplicate mail/proxyAddress value on the other before the next sync cycle."),
("cluster","A Windows Failover Cluster keeps losing quorum and taking resources offline randomly",
 "The cluster's file-share witness lives on a server that's been intermittently unreachable, and when both the witness and a node's network path degrade simultaneously the cluster loses majority vote and drops resources -- the cluster nodes themselves are healthy.",
 [("Get-Cluster | Select-Object Name, QuorumType","Name      QuorumType\n----      ----------\nProdClus  NodeAndFileShareMajority",""),
  ("Get-ClusterQuorum | Select-Object QuorumResource","QuorumResource\n--------------\n\\\\fileserver01\\witness$","")],
 "Move the file-share witness to a highly available, independent server (or switch to a Cloud Witness if any node has internet access), and investigate the network path to the current witness server."),
("cluster","A Cluster Shared Volume (CSV) drops into 'Redirected Access' mode, tanking storage performance",
 "A node lost direct storage connectivity (commonly a SAN/iSCSI path failure or lost cluster network), so the CSV coordinator redirected that volume's I/O over the cluster network to a node that still has direct access -- a resiliency feature working as designed, at a performance cost.",
 [("Get-ClusterSharedVolumeState | Select-Object Name, StateInfo, Node","Name    StateInfo         Node\n----    ---------         ----\nCSV01   FileSystemRedirected Node2",""),
  ("Get-ClusterNetworkInterface | Select-Object Name, State","Name              State\n----              -----\nNode2 - Storage   Unreachable","")],
 "Investigate and restore the affected node's direct storage path (check HBA/iSCSI initiator connections and multipathing), after which the CSV should automatically return to Direct I/O mode."),
("certificates","Multiple internal web apps suddenly show certificate trust errors organization-wide",
 "The organization's internal Root Certificate Authority certificate itself expired, which breaks trust for every certificate it issued across every internal app simultaneously -- explaining the sudden, org-wide nature of the errors rather than individual app misconfigurations.",
 [("Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object Subject -like '*Internal Root CA*' | Select-Object Subject, NotAfter","Subject                   NotAfter\n-------                   --------\nCN=Internal Root CA       2026-07-27","")],
 "This requires the PKI team to renew/reissue the Root CA certificate and redistribute it via Group Policy to all domain-joined machines' trusted root store; follow your organization's CA renewal runbook."),
("certificates","A specific app can't validate a certificate, error mentions the CRL is unreachable",
 "The certificate itself is valid, but the app can't reach the Certificate Revocation List (CRL) distribution point to confirm it hasn't been revoked, and strict validation settings are treating an unreachable CRL as a hard failure rather than a soft one.",
 [("certutil -URL 'https://cert.company.com/pki/company-ca.crl'","(manual retrieval fails to connect)",""),
  ("Test-NetConnection cert.company.com -Port 443","TcpTestSucceeded : False","")],
 "Restore network access to the CRL distribution point (cert.company.com), or if that's not possible, check whether the app/OS can be configured to fall back to OCSP or soft-fail on CRL unavailability."),
("certificates","A scheduled task using a certificate for authentication stopped working after 'cleaning up' old certificates",
 "The certificate the scheduled task was pinned to by thumbprint was removed during the certificate cleanup, and because the task references a specific thumbprint rather than a subject name, it has nothing to fall back to -- a direct casualty of the cleanup rather than an unrelated fault.",
 [("Get-ChildItem Cert:\\LocalMachine\\My | Select-Object Subject, Thumbprint, NotAfter","(the specific thumbprint the task expects is no longer present in the store)","")],
 "Reissue or restore a certificate with the expected properties, update the scheduled task's configuration with the new thumbprint, and going forward keep an inventory of which automation depends on which certificate before doing cleanup passes."),
("bsod","Random BSODs with different bug check codes each time, no obvious single driver in common",
 "Varying, unrelated bug check codes (rather than the same code every time) is a classic signature of unstable RAM rather than one bad driver -- especially with mismatched memory modules running at inconsistent clock speeds here.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WER-SystemErrorReporting'} -MaxEvents 5 | Select-Object TimeCreated","3 distinct bug check codes (0x1E, 0x3B, 0x139) across the last 5 crashes",""),
  ("Get-CimInstance Win32_PhysicalMemory | Select-Object BankLabel, Capacity, ConfiguredClockSpeed","BankLabel Capacity ConfiguredClockSpeed\n--------- -------- ---------------------\nBANK0     8589934592                3200\nBANK1     8589934592                2666","")],
 "Run MemTest86 for at least a few passes to confirm; if errors show up, either match the RAM kit properly (same speed/timings/manufacturer) or run at the slowest common, stable speed."),
("bsod","BSOD only happens during specific high-GPU-load moments, always the same bug check code",
 "A single, consistent bug check code tied directly to the GPU driver during high-load moments (unlike the RAM-instability pattern of varying codes) strongly points to the GPU driver itself as the specific fault, rather than a broader hardware stability issue.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 3 | Select-Object -ExpandProperty Message","Consistently bug check 0x00000116 (VIDEO_TDR_FAILURE), nvlddmkm.sys",""),
  ("Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion","Name                    DriverVersion\n----                    -------------\nNVIDIA GeForce RTX 3060 27.21.14.5678","")],
 "Update the GPU driver to the latest version via a clean install (DDU first), and if it's overclocked, return it to stock clocks since the crashes are load-triggered."),
("wsus","WSUS console is extremely slow and some clients aren't reporting compliance status",
 "The WSUS database has accumulated far more approved/declined update revisions than recommended without ever being cleaned up, which degrades both console responsiveness and the SQL queries backing client compliance reporting -- a maintenance gap, not a service failure.",
 [("Invoke-Sqlcmd -ServerInstance 'localhost\\SUSDB' -Query \"SELECT COUNT(*) AS UpdateCount FROM tbUpdate\"","UpdateCount\n-----------\n      48210",""),
  ("Get-Service WsusService | Select-Object Status","Status\n------\nRunning","")],
 "Run the built-in WSUS Server Cleanup Wizard (or its PowerShell equivalent 'Invoke-WsusServerCleanup') to remove obsolete/superseded updates, and schedule it to run regularly going forward."),
("wsus","Clients show 'downloading' at 0% forever when pulling updates from an internal WSUS server",
 "WSUS's metadata says updates are approved, but the actual update binary content was never fully downloaded to the WSUS content store, so clients connect fine but have nothing to actually download -- a content synchronization gap on the server, not a client-side issue.",
 [("Test-NetConnection wsus01.corp.local -Port 8530","TcpTestSucceeded : True",""),
  ("Get-ChildItem 'C:\\WSUS\\WsusContent' -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum","Sum: far smaller than expected for the number of approved updates","")],
 "Run 'wsusutil.exe reset' on the WSUS server to force it to re-verify and re-download all approved update content from Microsoft, which can take a while depending on how much is missing."),
("dfs","A DFS Namespace folder shows different (stale) content depending on which server a user's request lands on",
 "DFS Replication between the two servers backing this namespace has a large backlog, so users are seeing different content depending on which server's replica DFS happens to route them to until replication catches up.",
 [("Get-DfsrBacklog -GroupName 'PublicShare' -FolderName 'Docs' -SourceComputerName SRV1 -DestinationComputerName SRV2","BacklogFileCount : 1240","")],
 "Check for what's blocking replication (commonly a recent large file change, a paused replication schedule, or a bandwidth-throttled connection between sites), and monitor with repeated 'Get-DfsrBacklog' calls until it drains."),
("dfs","DFS Namespace referral sends users to a DFS server across a slow WAN link instead of their local one",
 "The local site's DFS folder target is marked with a higher referral cost (or is offline) relative to the remote site's target, so Active Directory Site-aware referral is correctly routing users to the 'cheaper' remote target per its misconfigured cost value.",
 [("Get-DfsnFolderTarget -Path '\\\\corp.local\\Public\\Docs' | Select-Object TargetPath, State","TargetPath                  State\n----------                  -----\n\\\\SITE-LOCAL\\Docs           Offline\n\\\\SITE-REMOTE\\Docs          Online","")],
 "Correct the referral ordering/cost for the local target under DFS Management, and confirm the local server's DFSR service is healthy if it's showing offline rather than just lower priority."),
("raid","A hardware RAID 5 array shows 'Degraded' status but all drives report as physically healthy in Windows",
 "Windows only sees the RAID controller's single logical volume, not the individual physical disks behind it, so 'all healthy' here just means the OS-visible volume is up -- the actual degraded/rebuilding state and any failed member disk needs to be checked in the RAID controller's own utility, not Windows Storage Management.",
 [("Get-PhysicalDisk | Select-Object DeviceId, HealthStatus","DeviceId HealthStatus\n-------- ------------\n0        Healthy",""),
  ("Get-Volume | Select-Object DriveLetter, HealthStatus","DriveLetter HealthStatus\n----------- ------------\nD           Healthy","")],
 "Open the RAID controller's dedicated management tool (a vendor's Storage Manager/BIOS utility) to identify which physical member disk triggered the degraded state and whether a rebuild is in progress or a replacement disk is needed."),
("raid","Storage Spaces virtual disk shows 'Needs Repair' after a drive was briefly disconnected",
 "The brief disconnection left the storage pool's resiliency data (mirror/parity) out of sync across the physical disks; the disks themselves reconnected fine, but Storage Spaces flags the virtual disk for repair until it re-synchronizes the redundant copies.",
 [("Get-VirtualDisk | Select-Object FriendlyName, HealthStatus, OperationalStatus","FriendlyName HealthStatus OperationalStatus\n------------ ------------ -----------------\nDataPool     Warning      InService, Needs Repair",""),
  ("Get-PhysicalDisk | Select-Object FriendlyName, HealthStatus, Usage","FriendlyName HealthStatus Usage\n------------ ------------ -----\nDisk1        Healthy      Auto-Select","")],
 "Run 'Repair-VirtualDisk -FriendlyName <name>' to trigger the resync; monitor progress with 'Get-StorageJob' until it completes, and avoid disconnecting drives from the pool while it's mid-repair."),
("security-incident","Multiple workstations show identical suspicious PowerShell activity in Sysmon logs around the same time",
 "Coordinated, encoded PowerShell execution launching near-simultaneously across multiple hosts with a shared parent process is a strong indicator of lateral movement from a compromised management tool or credential, not isolated user activity -- this should be treated as an active incident.",
 [("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Sysmon/Operational'; Id=1} -MaxEvents 20 | Where-Object Message -match 'powershell.exe' | Select-Object -First 3 TimeCreated","3 near-simultaneous PowerShell launches with -EncodedCommand across different hosts",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4688} -MaxEvents 10","Matching process-creation events with the same parent process across machines","")],
 "Escalate immediately per your incident response plan: isolate the affected hosts from the network, preserve the Sysmon/Security logs for forensics, and decode the captured -EncodedCommand payloads in an isolated analysis environment rather than on production hosts."),
("security-incident","An admin account shows sign-ins from two geographically distant locations within minutes",
 "'Impossible travel' between two sign-ins that are geographically infeasible within the observed time gap is a classic sign of credential compromise (the account is likely being used from two different actors/locations), not a single legitimate user traveling.",
 [("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4624} -MaxEvents 10 | Where-Object Message -match 'admin.jsmith' | Select-Object TimeCreated","Two 4624 logon events 6 minutes apart from IPs geolocating to different continents","")],
 "Immediately force a password reset and revoke active sessions/tokens for this account, enable/require MFA if not already enforced, and review what that account accessed during the suspicious window as part of an incident investigation."),
("gpo-advanced","A GPO applies to some computers in an OU but not others, no obvious pattern",
 "The GPO has a WMI filter scoped to a specific Windows build range, and the computers where it's 'not applying' are simply running a different OS build outside that filter's criteria -- targeted filtering working as designed, not a replication or application failure.",
 [("gpresult /r /scope:computer","GPO 'Baseline-Config' listed under: The following GPOs were not applied because they were filtered out (WMI Filter)",""),
  ("Get-GPO -Guid 3e2a1b7c-... | Select-Object WmiFilter","WmiFilter : SELECT * FROM Win32_OperatingSystem WHERE Version LIKE '10.0.19%'","")],
 "If the WMI filter's OS version criteria is outdated (e.g., excluding newer builds it should now include), update the filter's WQL query to match the current intended scope."),
("gpo-advanced","Users are unexpectedly getting local admin rights removed after each Group Policy refresh",
 "A Restricted Groups GPO is configured to authoritatively enforce the local Administrators group membership list, which silently strips out any manually added local admins on every policy refresh -- this is the GPO working exactly as configured, not a bug.",
 [("Get-ADGroupMember 'Restricted Groups - Local Admins' -ErrorAction SilentlyContinue | Select-Object Name","Name\n----\nsvc-helpdesk","")],
 "If specific users legitimately need standing local admin rights, add them to the AD group referenced by the Restricted Groups policy itself rather than adding them locally, since local-only additions will keep being reverted."),
("loadbalancer","One node behind a Windows NLB (Network Load Balancing) cluster never receives traffic",
 "The node's NLB participation was left in a Suspended state (commonly after maintenance work was paused but never resumed), so it's cluster-aware but deliberately excluded from the traffic distribution.",
 [("Get-NlbClusterNode | Select-Object HostName, State","HostName State\n-------- -----\nWEB01    Started\nWEB02    Suspended","")],
 "Resume the node's NLB participation with 'Resume-NlbClusterNode', and confirm its health check/application is actually ready to take traffic before resuming."),
("loadbalancer","Health checks on a load balancer mark a healthy web server as 'down' periodically",
 "The app pool briefly queues enough requests during load spikes that the health-check endpoint itself times out under the load balancer's strict threshold, even though the server recovers moments later -- a health-check sensitivity issue rather than the server actually being down.",
 [("Get-WebAppPoolState -Name DefaultAppPool","Value\n-----\nStarted",""),
  ("Get-Counter '\\ASP.NET Applications(__Total__)\\Requests Queued'","Periodic spikes in queued requests correlating with the marked-down windows","")],
 "Increase the load balancer's health-check timeout/unhealthy-threshold slightly, or add a lightweight, separately-pooled health-check endpoint that isn't queued behind the application's regular request load."),
("vmware","A Hyper-V Replica for a critical VM shows 'Critical' health with replication far behind",
 "Replication traffic to the replica host can't reach it over the configured port, so changes have been queuing on the primary without ever making it across -- a network/firewall path issue between the two hosts, not a VM-level fault.",
 [("Get-VMReplication -VMName CriticalVM | Select-Object State, Health, LastReplicationTime","State   Health   LastReplicationTime\n-----   ------   --------------------\nReplicating Critical 7/28/2026 8:14:02 AM",""),
  ("Test-NetConnection replica-host.corp.local -Port 80","TcpTestSucceeded : False","")],
 "Restore connectivity on the Hyper-V Replica port (HTTP 80 or HTTPS 443 depending on your configuration) between the primary and replica hosts, then trigger 'Start-VMInitialReplication' resync if the backlog is too large to catch up incrementally."),
("dns-advanced","Internal DNS resolves a public domain to the wrong (internal) IP for some users but not others",
 "A DNS zone for a public domain was created locally (commonly for a legitimate split-DNS reason that's now stale, or created by mistake), so internal clients pointed at this DNS server get the internal record instead of the real public one -- affected users are simply the ones using this particular DNS server.",
 [("Get-DnsServerZone -ComputerName DC01 | Where-Object ZoneName -eq 'partner.com'","ZoneName    ZoneType   IsAutoCreated\n--------    --------   -------------\npartner.com Primary    False","")],
 "Confirm whether this internal zone is intentional (split-brain DNS for a specific internal service); if not, remove it so internal clients fall through to real public resolution for that domain."),
("dns-advanced","Conditional forwarder to a partner company's DNS intermittently fails, causing split-brain-like resolution issues",
 "One of the two conditional forwarder targets for the partner's DNS zone is down/unreachable, and depending on which forwarder DNS happens to query first, resolution either succeeds or times out -- an intermittent upstream availability issue, not a local misconfiguration.",
 [("Resolve-DnsName partner-internal.example.com -Server 10.10.5.5","Resolve-DnsName : timed out",""),
  ("Get-DnsServerForwarder | Select-Object IPAddress","IPAddress\n---------\n10.10.5.5\n10.10.5.6","")],
 "Confirm with the partner organization whether that specific DNS server is down for maintenance or has changed IP, and update/remove the stale forwarder entry accordingly."),
("performance-advanced","A file server feels slow under load; CPU, RAM, and disk queue length all look moderate individually",
 "No single resource is individually maxed out, but the network interface's output queue is consistently backed up, indicating the network adapter (not storage or compute) is the actual bottleneck for this file server's workload under concurrent load.",
 [("Get-Counter -Counter '\\Network Interface(*)\\Output Queue Length','\\PhysicalDisk(_Total)\\Avg. Disk Queue Length' -SampleInterval 2 -MaxSamples 3","Output Queue Length consistently at 2-3; Avg. Disk Queue Length under 1","")],
 "Check the NIC's link speed/duplex settings for a mismatch, confirm it's not oversubscribed on a shared switch uplink, and consider NIC teaming or a faster adapter if legitimate throughput demand exceeds current capacity."),
("performance-advanced","Application response times spike every day at the same time, but server resource graphs look flat",
 "A scheduled task (a backup or reporting job) launches at the exact time of the daily performance spike and competes for the same disk I/O the application needs, even though average resource graphs (which smooth over the short spike) don't show it clearly.",
 [("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational'; Id=200} -MaxEvents 5 | Select-Object TimeCreated, Message","Scheduled task 'NightlyReportExport' launched at 14:00:03, matching the spike window","")],
 "Reschedule the competing task to an off-peak window, or if it must run during business hours, throttle its I/O priority so it doesn't starve the foreground application."),
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
            return cand

skipped = []
base_time = datetime(2026, 7, 28, 18, 30, 0)
i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goals:
        skipped.append(goal)
        continue
    created = base_time + timedelta(minutes=6 * i)
    feedback_at = created + timedelta(minutes=3)
    i += 1
    steps = [{"command": c, "blocked": False, "exitCode": 0, "stdout": o, "stderr": e, "reason": None} for c, o, e in commands]
    entry = {
        "id": next_id(),
        "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal,
        "domain": domain,
        "plan": [f"Correlate multiple diagnostic signals for this {domain} issue", "Identify the true root cause among several plausible candidates", "Apply the appropriate fix or escalation"],
        "steps": steps,
        "resolved": True,
        "summary": summary,
        "recommendation": recommendation,
        "feedback": {"worked": True, "note": "", "at": feedback_at.strftime("%Y-%m-%dT%H:%M:%S.000Z")}
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

print("Added:", i, "Skipped duplicates:", len(skipped), skipped)
print("Total JSON entries:", len(data))
print("Total JSONL lines:", len(jsonl_lines))

ids = [d["id"] for d in data]
assert len(ids) == len(set(ids))
goals = [d["goal"] for d in data]
assert len(goals) == len(set(goals))
with open(JSONL_PATH, encoding="utf-8") as f:
    ulines = [json.loads(l) for l in f if l.strip()]
users = [m["content"] for o in ulines for m in o["messages"] if m["role"] == "user"]
assert len(users) == len(set(users))
print("All validation passed: no duplicate ids/goals/prompts")
