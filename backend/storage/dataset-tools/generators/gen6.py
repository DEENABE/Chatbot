import json
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

# Event Viewer event-ID focused scenarios: (domain, goal, summary, [(cmd, stdout, stderr)], recommendation)
NEW = [
("eventlog","Event Viewer shows repeated Event ID 6008 'The previous system shutdown was unexpected'",
 "Event 6008 logs every time Windows finds it wasn't shut down cleanly; here they align with the household's evening power flickers rather than crashes -- there are no matching bugcheck (1001) events, so it's power loss, not BSODs.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=6008} -MaxEvents 5 | Select-Object TimeCreated","5 events, all between 18:00-19:00 on different days",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001; ProviderName='Microsoft-Windows-WER-SystemErrorReporting'} -MaxEvents 5","(no bugcheck events in the same window)","")],
 "Put the PC on a UPS (uninterruptible power supply) if evening power dips are common; the absence of paired bugcheck events rules out software crashes."),
("eventlog","Event ID 7000 says a service 'failed to start due to a logon failure'",
 "Event 7000 with a logon failure means the service's run-as account password stored in the Service Control Manager no longer matches the account's real password -- the account's password was rotated but the service credential was never updated.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=7000} -MaxEvents 3 | Select-Object -ExpandProperty Message","The BackupAgent service failed to start due to the following error: The service did not start due to a logon failure.",""),
  ("Get-CimInstance Win32_Service -Filter \"Name='BackupAgent'\" | Select-Object StartName","StartName\n---------\nCORP\\svc-backup","")],
 "Update the service's stored credential (services.msc > Log On tab, or 'sc config BackupAgent password=') with the account's current password, and coordinate future rotations with service credential updates -- or move to a Group Managed Service Account (gMSA) to eliminate manual rotation."),
("eventlog","Event ID 7009 'Timeout waiting for the service to connect' for a service that eventually works after boot",
 "Event 7009 means the service didn't report ready within the default 30-second startup window -- on this HDD-based system with heavy boot load, the service is healthy but slow, and SCM gives up before it finishes initializing.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=7009} -MaxEvents 3 | Select-Object -ExpandProperty Message","A timeout was reached (30000 milliseconds) while waiting for the AppMonitor service to connect.","")],
 "Raise the service startup timeout via HKLM\\SYSTEM\\CurrentControlSet\\Control ServicesPipeTimeout (e.g., 60000 ms) and reduce boot-time contention; the long-term fix is moving the OS to an SSD."),
("eventlog","Event ID 7034 shows a service 'terminated unexpectedly' several times a day",
 "Event 7034 records outright crashes of the service process; pairing timestamps with Application-log Event 1000 identifies the faulting module inside the service, a plug-in DLL added by a recent third-party update.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=7034} -MaxEvents 5 | Select-Object TimeCreated","5 crashes across the last 24 hours",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000} -MaxEvents 5 | Select-Object -ExpandProperty Message","Faulting application: agentsvc.exe, faulting module: vendor_plugin.dll","")],
 "Update or remove the identified plug-in DLL's parent software; SCM recovery options (restart on failure) can mask the symptom meanwhile, but the module fix is the real solution."),
("eventlog","Event ID 10016 DCOM errors flood the System log constantly",
 "Event 10016 logs a process being denied a DCOM activation permission; the vast majority of these (including the RuntimeBroker/ShellServiceHost ones here) are benign by-design denials that Microsoft explicitly says can be ignored.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-DistributedCOM'; Id=10016} -MaxEvents 3 | Select-Object -ExpandProperty Message","CLSID {D63B10C5-BB46-4990-A94F-E40B9D520160} (RuntimeBroker) local activation denied for SYSTEM","")],
 "No action needed for the well-known RuntimeBroker/immersive-shell 10016 entries -- they're cosmetic. Only investigate 10016 if the CLSID belongs to an app that's actually malfunctioning, in which case grant that specific principal Local Activation via dcomcnfg."),
("eventlog","Application Event ID 1002 shows an app 'stopped interacting with Windows' (hang) daily",
 "Event 1002 records app hangs (not crashes); this app hangs at the same time daily, matching a scheduled antivirus scan that locks the same project files the app has open -- a resource contention deadlock, not app corruption.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1002} -MaxEvents 5 | Select-Object TimeCreated","All 5 hang events within minutes of 13:00 daily",""),
  ("Get-ScheduledTaskInfo -TaskName '\\Vendor\\DailyScan' | Select-Object LastRunTime","LastRunTime : 1:00:00 PM daily","")],
 "Reschedule the daily scan outside working hours or exclude the app's working directories from real-time/scheduled scanning to remove the file-lock contention."),
("eventlog","Disk Event ID 153 'The IO operation was retried' appearing frequently",
 "Event 153 means the storage stack had to retry I/O requests -- an early-warning sign of a struggling disk, controller, or cable rather than data loss yet; here it targets the same device consistently, pointing at that specific drive/cable.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=153} -MaxEvents 5 | Select-Object -ExpandProperty Message","The IO operation at logical block address 0x1a2b3c for Disk 1 was retried.",""),
  ("Get-PhysicalDisk | Select-Object DeviceId, FriendlyName, HealthStatus","DeviceId FriendlyName    HealthStatus\n1        WDC WD20EZRZ    Warning","")],
 "Back up Disk 1 now, swap its SATA cable/port first (cheap and common culprit), and if 153 events continue, replace the drive before retries escalate into timeouts and data errors."),
("eventlog","Event ID 129 'Reset to device \\Device\\RaidPort0 was issued' with periodic system freezes",
 "Event 129 means the storport driver reset the storage adapter after commands timed out -- the classic signature of an SSD firmware hang or an incompatible LPM (link power management) setting freezing the drive under light load.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=129} -MaxEvents 5 | Select-Object TimeCreated","5 resets, each matching a reported 10-20 second system freeze","")],
 "Update the SSD firmware and storage driver, and disable aggressive link power management (HIPM/DIPM or 'AHCI Link Power Management' in the power plan) which is the most common trigger for storport 129 resets on desktop SSDs."),
("eventlog","Event ID 51 'An error was detected on device ...\\DR3 during a paging operation' fills the log",
 "Event 51 during paging operations against a specific device indicates the pagefile's disk had transient errors while servicing memory paging -- on this machine the pagefile sits on an aging secondary HDD, not the healthy system SSD.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=51} -MaxEvents 3 | Select-Object -ExpandProperty Message","An error was detected on device \\Device\\Harddisk2\\DR3 during a paging operation.",""),
  ("Get-CimInstance Win32_PageFileUsage | Select-Object Name","Name\n----\nD:\\pagefile.sys","")],
 "Move the pagefile back to the healthy system SSD (System Properties > Virtual Memory), then test the aging HDD with the vendor diagnostic and plan replacement if it reports pending sectors."),
("eventlog","NTFS Event ID 55 'The file system structure on the disk is corrupt and unusable'",
 "NTFS Event 55 is a genuine file-system corruption flag on the named volume; combined with the drive's Warning health state, this is a failing-disk pattern rather than a one-off dirty shutdown.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Ntfs'; Id=55} -MaxEvents 3 | Select-Object -ExpandProperty Message","The file system structure on volume D: is corrupt and unusable. Please run chkdsk.",""),
  ("Get-Volume -DriveLetter D | Select-Object HealthStatus","HealthStatus\n------------\nWarning","")],
 "Back up volume D: immediately, then run 'chkdsk D: /f' in a maintenance window; recurring Event 55 after a successful chkdsk means the underlying disk is failing and should be replaced."),
("eventlog","Event ID 98 shows a volume being mounted with errors ('Volume ... needs to be taken offline to perform a Full Chkdsk')",
 "NTFS Event 98 with a full-chkdsk request means online 'spot fixing' found issues it can't repair while the volume is mounted -- Windows has been quietly queueing deeper repair work for this volume.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Ntfs'; Id=98} -MaxEvents 3","Volume D: (\\Device\\HarddiskVolume5) needs to be taken offline to perform a Full Chkdsk.","")],
 "Schedule the full offline repair with 'chkdsk D: /f /x' (or at next reboot for the system volume); until it runs, the volume stays flagged and minor errors can compound."),
("eventlog","Security log full of Event ID 4740 'A user account was locked out' for one specific user",
 "Event 4740 includes the caller computer name, and every lockout here originates from the same machine -- a stale saved credential (old password) on that specific device keeps retrying and locking the account, not an attacker guessing.",
 [("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4740} -MaxEvents 5 | Select-Object -ExpandProperty Message","Caller Computer Name: MEETINGROOM-PC (same on all 5 lockout events)","")],
 "On MEETINGROOM-PC, clear the user's stale credentials (Credential Manager, mapped drives, scheduled tasks, and any signed-in mail clients), then unlock the account; the lockouts stop once the stale password source is removed."),
("eventlog","Kerberos Event ID 4771 'Kerberos pre-authentication failed' repeating for a service account",
 "Event 4771 with failure code 0x18 (bad password) from a single source IP identifies exactly where the wrong credential is coming from: an application server still running a scheduled job with the service account's old password.",
 [("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4771} -MaxEvents 5 | Select-Object -ExpandProperty Message","Failure Code: 0x18, Client Address: 10.0.2.45 (same on all events)","")],
 "On the 10.0.2.45 server, update the scheduled task/service using the old password; until fixed, those retries will keep tripping the account lockout threshold."),
("eventlog","NETLOGON Event ID 5719 'This computer was not able to set up a secure session with a domain controller'",
 "Event 5719 at boot on this laptop is a timing artifact: the wireless NIC comes up after NETLOGON's first attempt, so the initial failure logs even though connectivity succeeds moments later -- benign unless it persists during the session.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=5719} -MaxEvents 3 | Select-Object TimeCreated","All events within 30 seconds of each boot, none during steady state",""),
  ("nltest /sc_query:corp.local","The secure channel is in a good state (Trusted DC: DC01.corp.local)","")],
 "Boot-time-only 5719 on Wi-Fi/802.1x clients can be ignored or silenced by enabling 'Always wait for the network at computer startup and logon' GPO; investigate only if 5719 also appears mid-session."),
("eventlog","DNS Client Event ID 1014 'Name resolution for the name ... timed out' appearing sporadically",
 "Event 1014 logs individual resolution timeouts; here they cluster against one specific configured DNS server while the secondary answers fine -- the primary resolver is intermittently overloaded/unreachable, adding delays before fallback.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-DNS-Client'; Id=1014} -MaxEvents 5","Timeouts all reference the primary configured DNS server",""),
  ("Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, ServerAddresses","Wi-Fi  {192.168.1.1, 1.1.1.1}","")],
 "Investigate or replace the flaky primary DNS server (here the router at 192.168.1.1 -- a firmware update often fixes its DNS proxy), or reorder so a reliable resolver is primary."),
("eventlog","Schannel Event ID 36871 'A fatal error occurred while creating a TLS client credential' spamming the log",
 "Event 36871 with error 10013 typically appears when applications request TLS versions the OS has disabled (or vice versa); here legacy TLS 1.0/1.1 were disabled by hardening policy and an old agent keeps retrying with them.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=36871} -MaxEvents 3 | Select-Object -ExpandProperty Message","A fatal error occurred while creating a TLS client credential. The internal error state is 10013.",""),
  ("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\TLS 1.0\\Client' -Name Enabled -ErrorAction SilentlyContinue","Enabled : 0","")],
 "Identify and update the legacy application still attempting TLS 1.0/1.1 (correlate timestamps with process network activity); keep the old protocols disabled rather than re-enabling them to silence the log."),
("eventlog","WHEA-Logger Event ID 17 'A corrected hardware error has occurred' (PCI Express) repeating",
 "WHEA 17 corrected errors on a PCIe root port mean the link is detecting and fixing transmission errors -- functional for now, but recurring corrected errors on the same port usually trace to a poorly seated card or riser cable signal integrity.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WHEA-Logger'; Id=17} -MaxEvents 5 | Select-Object -ExpandProperty Message","Corrected hardware error. Component: PCI Express Root Port (same port each time)","")],
 "Power off and reseat the GPU/riser cable on that port (or move the card to another slot); if errors continue, test without the riser -- rising corrected-error counts eventually become uncorrected crashes."),
("eventlog","User Profile Service Event ID 1530 'Windows detected your registry file is still in use by other applications or services'",
 "Event 1530 at logoff means a process kept the user's registry hive open, forcing Windows to unload it forcibly; the named process here is a third-party updater service running in the user context after logoff.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-User Profiles Service'; Id=1530} -MaxEvents 3 | Select-Object -ExpandProperty Message","5 user registry handles leaked from \\Registry\\User\\S-1-5-21-... by process vendor_updater.exe","")],
 "Update or reconfigure the named process (run its updater as a system service instead of per-user); occasional 1530s are harmless, but chronic ones can slow logoffs and corrupt roaming profiles."),
("eventlog","User Profile Service Event ID 1511 'Windows cannot find the local profile and is logging you on with a temporary profile'",
 "Event 1511 confirms the temporary-profile symptom's cause: the ProfileList registry entry for this user points at a profile path that no longer exists (folder renamed during a cleanup), so Windows falls back to TEMP each logon.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1511} -MaxEvents 2","Windows cannot find the local profile and is logging you on with a temporary profile.",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\S-1-5-21-...-1001' -Name ProfileImagePath","ProfileImagePath : C:\\Users\\jdoe (folder currently named C:\\Users\\jdoe.old)","")],
 "Log the user off, rename the folder back to match ProfileImagePath (or update ProfileImagePath to the real folder), remove any .bak duplicate ProfileList keys, then log in again."),
("eventlog","Resource-Exhaustion-Detector Event ID 2004 'Windows successfully diagnosed a low virtual memory condition'",
 "Event 2004 names the top commit consumers at the moment of exhaustion, which is more reliable than Task Manager after the fact -- here a browser plus an Electron app consumed the bulk of commit against an undersized fixed pagefile.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=2004} -MaxEvents 1 | Select-Object -ExpandProperty Message","Programs consumed the most virtual memory: chrome.exe (9,214,152 KB), Teams.exe (4,102,336 KB)","")],
 "Set the pagefile back to system-managed (it was fixed at 2 GB), and trim the heaviest consumers listed in the event; recurring 2004 events with managed pagefile mean it's time for more RAM."),
("eventlog","Srv Event ID 2019 'The server was unable to allocate from the system nonpaged pool' on an older file server",
 "Event 2019 means kernel nonpaged pool exhaustion; tracking pool tags shows steady growth in one driver's allocation tag over uptime -- a kernel memory leak in that driver, which eventually starves SMB and other services.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=2019} -MaxEvents 2","The server was unable to allocate from the system nonpaged pool because the pool was empty.","")],
 "Identify the leaking pool tag with 'poolmon' (or WPA), map it to its driver via findstr on .sys files, and update/remove that driver; reboots only reset the leak timer until the driver is fixed."),
("eventlog","VSS Event ID 8193 'Volume Shadow Copy Service error: Unexpected error calling routine' during every backup",
 "VSS 8193 with 'Access is denied' converting a SID indicates the VSS service account context lost required registry permissions -- commonly after an aggressive security-hardening script tightened HKLM permissions beyond defaults.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='VSS'; Id=8193} -MaxEvents 2 | Select-Object -ExpandProperty Message","ConvertStringSidToSid failed, Access is denied (0x80070005)","")],
 "Restore default permissions on HKLM\\SYSTEM\\CurrentControlSet\\Services\\VSS (NETWORK SERVICE needs read), or use 'vssadmin list writers' to find the failed writer and re-register VSS components; avoid blanket registry-hardening scripts on servers running backups."),
("eventlog","Time-Service Event ID 36 'The time service has not synchronized the system time for 86400 seconds'",
 "Event 36 means W32Time hasn't successfully synced in a full day; the configured NTP peer is a decommissioned internal server, so every poll fails silently until the clock drifts enough to break Kerberos.",
 [("w32tm /query /peers","Peer: oldtime.corp.local (unreachable)\nState: Error","")],
 "Point W32Time at a valid source ('w32tm /config /manualpeerlist:time.windows.com /syncfromflags:manual /update' for standalone, or domhier for domain members), restart the service, and confirm with 'w32tm /query /status'."),
("eventlog","Task Scheduler Event ID 101 'Task Scheduler failed to start ... Additional Data: Error Value: 2147943785' for one task",
 "Error 2147943785 decodes to 'logon failure: the user has not been granted the requested logon type' -- the task runs as a service account that lost the 'Log on as a batch job' right when a new security baseline GPO was applied.",
 [("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational'; Id=101} -MaxEvents 3 | Select-Object -ExpandProperty Message","Task Scheduler failed to start \\Corp\\NightlyETL task for user CORP\\svc-etl. Error Value: 2147943785",""),
  ("whoami /priv","(run as the service account: SeBatchLogonRight not present)","")],
 "Add the service account back to 'Log on as a batch job' (secpol.msc > User Rights Assignment, or fix the GPO baseline), after which the scheduled task runs again without modification."),
("eventlog","WLAN-AutoConfig Event ID 8002 'WLAN AutoConfig service failed to connect to a wireless network' with reason 'network not available'",
 "Event 8002's failure reason plus the roaming history shows the laptop keeps attempting a 'remembered' hidden SSID from another site; the retry storm delays connecting to the correct local network at each wake.",
 [("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-WLAN-AutoConfig/Operational'; Id=8002} -MaxEvents 5","Failure to connect to SSID 'BranchOffice-Hidden' -- network not available (repeated at every wake)","")],
 "Remove or de-prioritize the stale hidden network profile ('netsh wlan delete profile name=\"BranchOffice-Hidden\"'), since hidden SSIDs are actively probed and slow down reconnection when out of range."),
("eventlog","DHCP-Client Event ID 1002 'The IP address lease ... has been denied by the DHCP server' after moving desks",
 "Event 1002 (DHCPNAK) means the DHCP server refused to renew the old lease -- expected when a device moves to a different subnet/VLAN and requests its previous subnet's address; the client recovers by requesting a fresh lease.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Dhcp-Client'; Id=1002} -MaxEvents 2","The IP address lease 10.1.4.87 for the Network Card has been denied by the DHCP server 10.2.0.1 (DHCPNAK)","")],
 "One-time 1002 events after moving between networks are normal; only investigate if they repeat continuously on a stationary machine, which then points at overlapping DHCP scopes or a rogue DHCP server."),
("eventlog","Print-Service Event ID 372 'The document failed to print' repeatedly for one printer",
 "Event 372 with Win32 error 5 (access denied) on a single printer shows the share's permissions were changed -- the user retains the ability to see the queue but no longer holds Print permission after a permissions cleanup.",
 [("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-PrintService/Admin'; Id=372} -MaxEvents 3 | Select-Object -ExpandProperty Message","The document Print Document owned by jdoe failed to print on printer \\\\printsrv\\Finance-HP. Win32 error code returned by the print processor: 5.","")],
 "Restore the user's (or their group's) Print permission on the printer's Security tab on the print server -- error 5 on 372 is a permissions issue, not a driver or spooler fault."),
("eventlog",".NET Runtime Event ID 1026 accompanies an app crash with an unhandled exception",
 "Event 1026 captures the .NET exception type that Application Error 1000 doesn't show: a System.IO.FileNotFoundException for a specific assembly version -- the app's config binds to a version newer than what's installed.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='.NET Runtime'; Id=1026} -MaxEvents 2 | Select-Object -ExpandProperty Message","Unhandled exception: System.IO.FileNotFoundException: Could not load file or assembly 'Newtonsoft.Json, Version=13.0.0.0'","")],
 "Install the missing assembly version alongside the app (or add a bindingRedirect in the app's .config to the installed version); the 1026+1000 event pair identifies exact assembly and version needed."),
("eventlog","Kernel-Processor-Power Event ID 37 'The speed of processor ... is being limited by system firmware' logged constantly",
 "Event 37 means firmware (not Windows) is throttling the CPU; sustained on AC power it indicates the laptop firmware is capping performance due to a thermal/power condition -- here a failing fan confirmed by its 0 RPM reading in vendor diagnostics.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=37} -MaxEvents 3 | Select-Object -ExpandProperty Message","The speed of processor 0 in group 0 is being limited by system firmware. The processor has been in this reduced performance state for 71 seconds.","")],
 "Fix the cooling: clean or replace the failed fan (vendor diagnostics show 0 RPM); firmware throttling clears itself once temperatures normalize. Also check for BIOS updates addressing over-aggressive throttle curves."),
("eventlog","Kernel-Boot Event ID 29 'Windows failed fast startup with error status 0xC00000D4'",
 "Event 29 means the hibernation-based fast-startup image couldn't be written/used; status 0xC00000D4 here follows an in-place disk layout change (drive shrink for dual boot) that invalidated the hiberfile location.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Boot'; Id=29} -MaxEvents 2","Windows failed fast startup with error status 0xC00000D4.","")],
 "Rebuild the hibernation file: 'powercfg /h off' then 'powercfg /h on' recreates hiberfil.sys in the current layout; if the error continues, leave fast startup off -- boots will be marginally slower but fully reliable."),
("eventlog","Security Event ID 4776 'The computer attempted to validate the credentials' failing with error C0000234 (account locked)",
 "The 4776/C0000234 stream on the DC shows NTLM validation attempts against an already-locked account continuing from one workstation -- the workstation runs a background sync tool that never stopped retrying the locked account's old password.",
 [("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4776} -MaxEvents 5 | Select-Object -ExpandProperty Message","Error Code: 0xC0000234, Source Workstation: DESIGN-07 (all events)","")],
 "On DESIGN-07, stop the sync tool and update its stored credential; then unlock the account. Pair 4776 (validation source) with 4740 (lockout record) to pinpoint retry sources quickly in future lockout storms."),
("eventlog","Windows Error Reporting fills the Application log with Event 1001 'Fault bucket' entries for the same app",
 "Repeating WER 1001 fault buckets with an identical bucket ID mean the same crash signature recurs -- useful because the bucket's module+offset stays constant, confirming one specific bug rather than random instability.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Windows Error Reporting'; Id=1001} -MaxEvents 5 | Select-Object -ExpandProperty Message","Fault bucket 128745abc, type 4, Event Name: APPCRASH, P4: renderlib.dll, P7: 0x0004f2a1 (identical across events)","")],
 "Report the consistent fault bucket details (module renderlib.dll, offset 0x0004f2a1, app version) to the software vendor -- an identical bucket across crashes is exactly what their developers need to locate the bug; check for an updated build first."),
("eventlog","Kernel-PnP Event ID 219 'The driver \\Driver\\WudfRd failed to load for the device' at every boot",
 "Event 219 for WudfRd at boot is usually a harmless race (a user-mode driver framework device probed before the framework is ready), but for this device instance it corresponds to a biometric sensor whose driver package was half-removed.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=219} -MaxEvents 3 | Select-Object -ExpandProperty Message","The driver \\Driver\\WudfRd failed to load for the device WINBIO\\WINBIO_SENSOR\\...",""),
  ("Get-PnpDevice -Class Biometric | Select-Object Status, FriendlyName","Status FriendlyName\n------ ------------\nError  Fingerprint Sensor","")],
 "Reinstall the fingerprint sensor's full driver package from the laptop vendor; if the device shows OK and 219 still logs once per boot with no functional impact, it's a benign timing entry that can be ignored."),
("eventlog","DistributedCOM Event ID 10010 'The server did not register with DCOM within the required timeout' tied to shell freezes",
 "Event 10010's CLSID resolves to a third-party shell extension COM server that hangs on registration; each occurrence matches an Explorer freeze, distinguishing this from the benign 10016 permission noise.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=10010} -MaxEvents 3 | Select-Object -ExpandProperty Message","The server {B8E7A1C2-...} did not register with DCOM within the required timeout.","")],
 "Resolve the CLSID in the registry (HKCR\\CLSID\\{...}) to identify the owning software, then update or uninstall it; unlike 10016, recurring 10010 events with matching UI freezes indicate a real malfunctioning component."),
("eventlog","Windows Defender Event ID 1116 'detected malware' but no visible alert was shown to the user",
 "Defender's Operational log (1116 detection, followed by 1117 action-taken) shows the threat was detected and already remediated silently -- the notification was suppressed by Focus Assist, not a failure to act.",
 [("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1116} -MaxEvents 2 | Select-Object -ExpandProperty Message","Detected: Trojan:Win32/Wacatac.B!ml, file: C:\\Users\\jdoe\\Downloads\\keygen.exe",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1117} -MaxEvents 2","Action: Quarantine, succeeded","")],
 "The threat was quarantined successfully (1117 confirms remediation); review Protection History for details, run a full scan for confidence, and counsel the user about the source of the quarantined download."),
("eventlog","Event ID 1074 shows the system restarting unexpectedly overnight -- who or what initiated it?",
 "Event 1074 records exactly which process/user requested each shutdown: the overnight restarts were initiated by the Windows Update Orchestrator within the configured active-hours gap, not by a person or a crash.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1074} -MaxEvents 3 | Select-Object -ExpandProperty Message","The process C:\\Windows\\uus\\...\\MoUsoCoreWorker.exe has initiated the restart of computer on behalf of NT AUTHORITY\\SYSTEM: Operating System: Servicing (Planned)","")],
 "Adjust Active Hours (Settings > Windows Update) to cover the times the machine must stay up, or use Group Policy to require scheduled restart approval; 1074 is the authoritative answer to 'what rebooted this machine'."),
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
base_time = datetime(2026, 7, 30, 14, 0, 0)
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
        "plan": ["Pull the relevant Event Viewer records", "Interpret the event ID and its data fields", "Correlate with system state to find the root cause", "Apply the appropriate fix or explain why no action is needed"],
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
assert set(users) == set(goals), "json/jsonl mismatch"
print("All validation passed: no duplicates, files fully mirrored")
