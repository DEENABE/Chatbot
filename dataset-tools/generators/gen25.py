#!/usr/bin/env python3
"""gen25.py - Round 7: repair-only. Fresh ground - Outlook/mail, OneDrive/cloud sync,
Teams, scanning, mobile hotspot/tethering, accessibility, search/indexing, clock/time sync,
credential manager, task scheduler faults, shell extensions, more BSOD stop codes."""
import json, collections, uuid
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

NEW = [
# ===================== OUTLOOK / MAIL =====================
("office","Outlook","Outlook keeps asking for my password over and over",
 ["Check whether a stale credential is being replayed","Look at the authentication method in use","Identify what to clear"],
 [("cmdkey /list | Select-String 'MicrosoftOffice|outlook'",0,"Target: MicrosoftOffice16_Data:orgid:jdoe@corp.com\nTarget: MicrosoftOffice16_Data:live.com:jdoe@corp.com",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Office\\16.0\\Common\\Identity' -Name EnableADAL -ErrorAction SilentlyContinue",0,"EnableADAL : 0",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Outlook'} -MaxEvents 3 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Message",0,"The connection to Microsoft Exchange is unavailable. Outlook must be online...","")],
 True,
 "Two credentials exist for the same mailbox - an organisational one and a personal live.com one - and modern authentication is disabled by the EnableADAL=0 key. Outlook falls back to basic auth, the wrong cached credential is offered, the server rejects it, and the prompt reappears.",
 "Delete both Office credentials from Credential Manager and remove the EnableADAL value so modern authentication is used. Basic authentication is disabled on Exchange Online, so leaving ADAL off guarantees this loop rather than merely risking it.",
 (True,"cleared the credentials and it signed in once, properly")),

("office","Outlook","Outlook is stuck on 'Trying to connect' but the internet works",
 ["Check whether the mail endpoint specifically is reachable","Look at the autodiscover path","Distinguish general network from mail-service reachability"],
 [("Test-NetConnection outlook.office365.com -Port 443 -InformationLevel Quiet",0,"True",""),
  ("Resolve-DnsName autodiscover.corp.com -Type CNAME -ErrorAction SilentlyContinue",1,"","DNS name does not exist"),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Office\\16.0\\Outlook\\AutoDiscover' -ErrorAction SilentlyContinue | Select-Object ExcludeHttpsRootDomain, PreferLocalXML",0,"ExcludeHttpsRootDomain : 1\nPreferLocalXML         : 1",""),
  ("Get-ChildItem 'C:\\ProgramData\\Autodiscover' -ErrorAction SilentlyContinue | Select-Object Name",1,"","(path not found)")],
 True,
 "The mail service is reachable on 443, so this is not connectivity. Outlook is configured to prefer a local Autodiscover XML file that does not exist, and the autodiscover DNS record is missing - so it never learns which server to talk to and sits at 'Trying to connect'.",
 "Remove the PreferLocalXML and ExcludeHttpsRootDomain values so Outlook uses the normal Autodiscover sequence, and have DNS publish the autodiscover CNAME. Rebuilding the profile would not help while these overrides point at a file that is not there.",
 (True,"leftover keys from an old migration script")),

("office","Outlook","Sent emails sit in the Outbox and never leave",
 ["Check whether the item is genuinely stuck or just large","Look at the send path","Identify the blocker"],
 [("Get-Process OUTLOOK -ErrorAction SilentlyContinue | Select-Object Id, Responding, WorkingSet64",0,"  Id Responding WorkingSet64\n  -- ---------- ------------\n8420       True   1284206841",""),
  ("Get-ChildItem \"$env:LOCALAPPDATA\\Microsoft\\Outlook\" -Filter '*.ost' | Select-Object Name, @{N='GB';E={[math]::Round($_.Length/1GB,2)}}",0,"Name           GB\n----           --\njdoe@corp.ost 48.20",""),
  ("Test-NetConnection outlook.office365.com -Port 443 -InformationLevel Quiet",0,"True","")],
 True,
 "Outlook is responsive and the server is reachable, but the OST has grown to 48 GB. Above roughly 50 GB the file becomes unstable and synchronisation stalls - the send queue is blocked behind a sync operation that cannot complete, not by a network fault.",
 "Reduce the mail-to-keep-offline window under Account Settings so the OST shrinks, then let it resync. Archive older mail to an online archive rather than a local PST; a PST on a network drive would create a different and worse set of problems.",
 (True,"cut offline mail to 12 months, OST dropped to 9 GB")),

("office","Outlook","Search in Outlook returns nothing even for emails I can see",
 ["Check whether Outlook is included in the index","Look at the index status","Identify what excludes it"],
 [("Get-Service WSearch | Select-Object Status, StartType",0,"Status  StartType\n------  ---------\nRunning Automatic",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search' -Name PreventIndexingOutlook -ErrorAction SilentlyContinue",0,"PreventIndexingOutlook : 1",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows Search' -Name SetupCompletedSuccessfully",0,"SetupCompletedSuccessfully : 1","")],
 True,
 "The search service is running and set up correctly, but a policy value explicitly prevents Outlook data from being indexed. Outlook then falls back to a client-side search that returns nothing for a cached mailbox of this size, which is why messages you can see are not found.",
 "Remove the PreventIndexingOutlook policy value and let the index rebuild - allow several hours for a large mailbox. Rebuilding the index first would have achieved nothing while the policy kept excluding the data.",
 (True,"a policy from an old GPO nobody remembered")),

# ===================== ONEDRIVE / CLOUD SYNC =====================
("cloud","OneDrive","OneDrive says 'Processing changes' for hours and never finishes",
 ["Check how many items are being tracked","Look for a file the sync engine cannot handle","Identify the stall point"],
 [("Get-Process OneDrive -ErrorAction SilentlyContinue | Select-Object Id, CPU, WorkingSet64",0,"  Id      CPU WorkingSet64\n  --      --- ------------\n6204 3842.18   2184206841",""),
  ("Get-ChildItem \"$env:USERPROFILE\\OneDrive\" -Recurse -File -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count\n-----\n412804",""),
  ("Get-ChildItem \"$env:USERPROFILE\\OneDrive\" -Recurse -Directory -ErrorAction SilentlyContinue | Where-Object { $_.FullName.Length -gt 240 } | Measure-Object | Select-Object Count",0,"Count\n-----\n   18","")],
 True,
 "OneDrive is tracking 412,000 files, well beyond the 300,000 it is designed for, and 18 folders have paths over 240 characters. It is not hung - it is churning through a set it cannot finish, and the over-length paths will fail even when it gets to them.",
 "Move the large archive folders out of OneDrive and keep them in a normal local folder or an offline archive. Shorten the deep paths as well. Resetting OneDrive is the usual first suggestion but it just restarts the same impossible scan.",
 (True,"moved a 200k-file photo archive out and it finished in 20 minutes")),

("cloud","OneDrive","Files show a cloud icon and won't open when I'm offline",
 ["Check the Files On-Demand state","Look at whether the files are pinned","Explain the icon states"],
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\OneDrive' -Name EnableAllOcsiClients -ErrorAction SilentlyContinue",0,"EnableAllOcsiClients : 1",""),
  ("(Get-Item \"$env:USERPROFILE\\OneDrive\\Docs\\plan.docx\").Attributes",0,"Archive, ReparsePoint, Offline",""),
  ("Get-Volume C | Select-Object SizeRemaining, @{N='FreeGB';E={[int]($_.SizeRemaining/1GB)}}",0,"SizeRemaining      FreeGB\n-------------      ------\n 21474836480          20","")],
 True,
 "Files On-Demand is enabled and this file carries the Offline reparse attribute - meaning it is a placeholder with no local content. That is the intended behaviour, not a fault: cloud-only files need a connection to download on first open.",
 "Right-click the folders you need on the road and choose 'Always keep on this device' before travelling. With 20 GB free there is room to pin a working set; pinning the entire OneDrive would fill the disk and cause a different problem.",
 (True,"pinned my current project folder, works offline now")),

("cloud","OneDrive","Two computers keep creating duplicate files with my PC name appended",
 ["Confirm the pattern of the duplicates","Check what edits the file on each machine","Identify the conflict source"],
 [("Get-ChildItem \"$env:USERPROFILE\\OneDrive\" -Recurse -Filter '*-DESKTOP-*' -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count\n-----\n   64",""),
  ("Get-ChildItem \"$env:USERPROFILE\\OneDrive\" -Recurse -Filter '*.xlsx' -ErrorAction SilentlyContinue | Where-Object Name -match '-DESKTOP-' | Select-Object -First 2 Name, LastWriteTime",0,"Name                      LastWriteTime\n----                      -------------\nbudget-DESKTOP-A1B2.xlsx  8/14/2026 4:12:08 PM",""),
  ("Get-Process EXCEL, OneDrive -ErrorAction SilentlyContinue | Select-Object Name, Id",0,"Name     Id\n----     --\nOneDrive 6204","")],
 True,
 "The name-suffixed copies are OneDrive's conflict resolution: the same file was changed on two machines before either finished syncing, so rather than lose an edit it keeps both. It is data preservation working, not corruption - but 64 of them means the pattern is habitual.",
 "Close files fully on one machine and wait for the sync icon to show complete before opening them on the other. For files edited from both regularly, use the web or desktop app's co-authoring instead, which merges rather than forking.",
 (True,"was leaving Excel open on the laptop overnight")),

# ===================== TEAMS / COLLABORATION =====================
("office","Teams","My microphone works everywhere except in Teams",
 ["Check the OS-level app permission","Confirm the device is not exclusively held","Identify the block"],
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone' -Name Value",0,"Value : Allow",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Teams#ms-teams.exe' -Name Value -ErrorAction SilentlyContinue",0,"Value : Deny",""),
  ("Get-PnpDevice -Class AudioEndpoint | Where-Object FriendlyName -match 'Micro' | Select-Object Status, FriendlyName",0,"Status FriendlyName\n------ ------------\nOK     Microphone (USB Audio Device)","")],
 True,
 "Microphone access is allowed globally, but there is a per-application Deny specifically for the Teams executable. Windows blocks the capture at the OS level, so Teams shows a device but receives silence - nothing inside Teams can override this.",
 "Set Teams to Allow under Settings > Privacy & security > Microphone, in the desktop-apps section at the bottom of that page. The global toggle being on is what makes this confusing; the per-app entry is separate and takes precedence.",
 (True,"the per-app list was below the fold, never saw it")),

("office","Teams","Teams screen sharing shows a black rectangle to everyone else",
 ["Check which GPU renders the shared content","Look at hardware acceleration in the capture path","Identify the mismatch"],
 [("Get-CimInstance Win32_VideoController | Select-Object Name, Status",0,"Name                      Status\n----                      ------\nIntel(R) Iris Xe Graphics OK\nNVIDIA GeForce RTX 3050   OK",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences' -ErrorAction SilentlyContinue | Select-Object -First 1",0,"C:\\Program Files\\Teams\\ms-teams.exe : GpuPreference=1;",""),
  ("Get-CimInstance Win32_PnPSignedDriver | Where-Object DeviceName -match 'NVIDIA' | Select-Object DriverVersion",0,"DriverVersion\n-------------\n31.0.15.4633","")],
 True,
 "The shared application renders on the NVIDIA GPU while Teams is pinned to the integrated Intel GPU by an explicit preference. The capture path cannot read another adapter's framebuffer, so it sends black - which is why audio and everything else works.",
 "Set Teams and the application being shared to the same GPU in Graphics settings, or remove the override so Windows decides. This affects all hybrid-graphics laptops and is not a Teams bug; the same happens with other capture software.",
 (True,"set both to the same GPU and sharing works")),

# ===================== SCANNING =====================
("printer","scanner","The scanner is detected but scanning fails with a communication error",
 ["Check the imaging service state","Confirm the device driver stack","Identify the broken link"],
 [("Get-Service stisvc | Select-Object Status, StartType",0,"Status  StartType\n------  ---------\nStopped   Disabled",""),
  ("Get-PnpDevice -Class Image | Select-Object Status, FriendlyName",0,"Status FriendlyName\n------ ------------\nOK     Canon MF4700 Series",""),
  ("Get-Service WiaRpc -ErrorAction SilentlyContinue | Select-Object Status",1,"","(service not found on this build)")],
 True,
 "The device is enumerated correctly, but the Windows Image Acquisition service is stopped and disabled. Every WIA scan request goes through that service, so scanning fails while printing on the same multifunction device keeps working - printing uses the spooler instead.",
 "Set stisvc to Automatic and start it. It is often disabled by 'services to disable' guides, which do not account for multifunction devices where the scan half depends on it and the print half does not.",
 (True,"a debloat script had disabled it")),

("printer","scanner","Scanned PDFs come out enormous - 40 MB for a couple of pages",
 ["Check the resolution the scan is being made at","Look at the colour mode","Identify what drives the size"],
 [("Get-ChildItem \"$env:USERPROFILE\\Documents\\Scans\" -Filter '*.pdf' | Select-Object -First 3 Name, @{N='MB';E={[math]::Round($_.Length/1MB,1)}}",0,"Name        MB\n----        --\nscan001.pdf 41.2\nscan002.pdf 38.7",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows Photo Viewer\\Scan' -ErrorAction SilentlyContinue",1,"","(no saved scan profile)"),
  ("Get-PnpDevice -Class Image | Select-Object FriendlyName",0,"FriendlyName\n------------\nCanon MF4700 Series","")],
 True,
 "The scan profile is set to 1200 dpi in full colour, which is archival-photograph quality applied to text documents. Nothing is malfunctioning - each page is simply being captured at roughly sixteen times the data of a normal document scan.",
 "Set the profile to 300 dpi and greyscale for text, which is fully legible and produces files around 1 MB per page. Keep 600 dpi colour for photographs or anything that will be OCR'd from poor originals.",
 (True,"300 dpi greyscale, files are 900 KB now")),

# ===================== HOTSPOT / TETHERING =====================
("network","mobile hotspot","Mobile hotspot turns on then switches itself off after a minute",
 ["Check the hosted network capability","Look for a power-saving interaction","Identify what stops it"],
 [("Get-NetAdapter | Where-Object Name -match 'Local Area Connection\\*' | Select-Object Name, Status, InterfaceDescription",0,"Name                        Status InterfaceDescription\n----                        ------ --------------------\nLocal Area Connection* 12      Up  Microsoft Wi-Fi Direct Virtual Adapter",""),
  ("Get-NetAdapterPowerManagement -Name 'Wi-Fi' | Select-Object AllowComputerToTurnOffDevice",0,"AllowComputerToTurnOffDevice : Enabled",""),
  ("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\icssvc\\Settings' -Name PeerlessTimeoutEnabled -ErrorAction SilentlyContinue",1,"","(value not present)")],
 True,
 "The hotspot shuts down because no client connects within the idle timeout, and the Wi-Fi adapter is additionally allowed to power down. Both push in the same direction: a hotspot with nothing attached is treated as idle and torn down.",
 "Set PeerlessTimeoutEnabled to 0 under the icssvc Settings key to stop the idle shutdown, and untick 'Allow the computer to turn off this device' on the Wi-Fi adapter. Connect a client promptly and neither would trigger.",
 (True,"needed the hotspot up before the other device booted")),

("network","mobile hotspot","Devices connect to my hotspot but get no internet",
 ["Check whether sharing is bound to the right connection","Look at the shared adapter's addressing","Identify the break in the path"],
 [("Get-NetAdapter | Select-Object Name, Status, InterfaceDescription",0,"Name                       Status InterfaceDescription\n----                       ------ --------------------\nEthernet                       Up  Realtek PCIe GbE\nLocal Area Connection* 12      Up  Wi-Fi Direct Virtual Adapter",""),
  ("Get-NetIPAddress -InterfaceAlias 'Local Area Connection* 12' -AddressFamily IPv4 | Select-Object IPAddress",0,"IPAddress\n---------\n192.168.137.1",""),
  ("Get-Service SharedAccess | Select-Object Status, StartType",0,"Status  StartType\n------  ---------\nRunning Automatic",""),
  ("Get-NetNat -ErrorAction SilentlyContinue | Select-Object Name, InternalIPInterfaceAddressPrefix",1,"","(no NAT rules configured)")],
 True,
 "Clients receive the 192.168.137.x address so DHCP is working, and the sharing service is running - but no NAT translation exists, so traffic reaches the host and stops there. The connection is established but nothing is forwarded upstream.",
 "Turn the hotspot off and on to have Windows recreate the sharing configuration, which rebuilds the NAT rule. If it does not return, a third-party VPN or firewall that installs its own NAT is usually the reason it was removed.",
 (True,"the VPN client had taken over NAT, reconnecting fixed it")),

# ===================== ACCESSIBILITY =====================
("settings","accessibility","The screen colours look wrong - everything is washed out or inverted",
 ["Check whether a colour filter is active","Look at the night light setting","Identify which one is applied"],
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\ColorFiltering' -Name Active, FilterType -ErrorAction SilentlyContinue",0,"Active     : 1\nFilterType : 1",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current\\default$windows.data.bluelightreduction.settings' -ErrorAction SilentlyContinue | Select-Object PSChildName",1,"","(night light not configured)"),
  ("Get-CimInstance Win32_VideoController | Select-Object Name, Status",0,"Name             Status\n----             ------\nIntel UHD 630    OK","")],
 True,
 "A colour filter is active with FilterType 1, which is the greyscale-family filter. Night light is not configured and the display adapter is healthy - the washed-out appearance is an accessibility filter applied system-wide, not a display or driver fault.",
 "Turn it off under Settings > Accessibility > Colour filters, or press Windows + Ctrl + C. That shortcut is easy to hit accidentally, which is the usual way this gets switched on without anyone realising.",
 (True,"the keyboard shortcut, hit it while copying something")),

("settings","accessibility","Windows reads everything out loud and I can't make it stop",
 ["Identify which assistive feature is speaking","Check how it was started","Turn it off and prevent recurrence"],
 [("Get-Process Narrator -ErrorAction SilentlyContinue | Select-Object Id, StartTime",0,"  Id StartTime\n  -- ---------\n5108 8/17/2026 9:02:41 AM",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Narrator' -Name WinEnterLaunchEnabled -ErrorAction SilentlyContinue",0,"WinEnterLaunchEnabled : 1",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Narrator\\NoRoam' -Name AutoStartOnLogon -ErrorAction SilentlyContinue",0,"AutoStartOnLogon : 0","")],
 True,
 "Narrator is running, launched by the Windows + Ctrl + Enter shortcut which is enabled. It is not set to start at logon, so it only appears when that key combination is pressed - which explains why it comes and goes rather than being constant.",
 "Press Windows + Ctrl + Enter to stop it now, and turn off the keyboard shortcut in Narrator settings if it keeps being triggered. Leave Narrator itself installed - disabling the shortcut is enough and keeps the feature available if it is ever needed.",
 (True,"turned off the shortcut, no more surprises")),

# ===================== SEARCH / INDEXING =====================
("windows","Windows Search","Start menu search finds nothing, not even installed apps",
 ["Check the search service and index size","Look for index corruption","Decide between repair and rebuild"],
 [("Get-Service WSearch | Select-Object Status, StartType",0,"Status  StartType\n------  ---------\nRunning Automatic",""),
  ("Get-Item \"$env:ProgramData\\Microsoft\\Search\\Data\\Applications\\Windows\\Windows.edb\" | Select-Object @{N='MB';E={[int]($_.Length/1MB)}}, LastWriteTime",0,"MB LastWriteTime\n-- -------------\n 12 6/02/2026 3:14:22 AM",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-Search'} -MaxEvents 3 | Select-Object -ExpandProperty Message",0,"The search service has detected corrupted data files in the index. The service will attempt to automatically correct this problem.","")],
 True,
 "The service is running but the index database is only 12 MB and has not been written to since June - it is corrupt and the automatic repair is not succeeding. An index of this size holds nothing, which is why even application names are not found.",
 "Rebuild the index from Indexing Options > Advanced. It will take a few hours and search will be incomplete meanwhile. If it corrupts again within days, check disk health - repeat index corruption is often the first visible symptom of failing storage.",
 (True,"rebuilt overnight, search works again")),

("windows","Windows Search","File search finds nothing in a specific folder but works elsewhere",
 ["Check whether that location is in the indexed scope","Look for an exclusion","Explain the difference"],
 [("Get-Service WSearch | Select-Object Status",0,"Status\n------\nRunning",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows Search\\CrawlScopeManager\\Windows\\SystemIndex\\DefaultRules' -ErrorAction SilentlyContinue | Select-Object PSChildName",0,"PSChildName\n-----------\nDefaultRules",""),
  ("(Get-Item 'D:\\Archive').Attributes",0,"Directory, NotContentIndexed","")],
 True,
 "The folder carries the NotContentIndexed attribute, so the indexer skips it entirely. Search still walks the folder for file names in some views but never sees the contents - which is why searching for text inside those files returns nothing while other folders are fine.",
 "Clear 'Allow files in this folder to have contents indexed' in the folder's Advanced attributes, then add the location under Indexing Options. Expect it to take time to catch up on a large archive folder.",
 (True,"the attribute was set when the folder was copied from an old drive")),

# ===================== TIME / CLOCK =====================
("windows","time synchronization","The clock keeps drifting even after I set it correctly",
 ["Check the time service configuration","Look at what it is syncing against","Identify the failure"],
 [("w32tm /query /status",0,"Leap Indicator: 3(not synchronized)\nStratum: 0 (unspecified)\nSource: Local CMOS Clock",""),
  ("Get-Service W32Time | Select-Object Status, StartType",0,"Status  StartType\n------  ---------\nRunning    Manual",""),
  ("w32tm /query /peers",0,"#Peers: 1\nPeer: time.windows.com,0x9\nState: Pending\nLast Successful Sync Time: unspecified","")],
 True,
 "The service is running but has never successfully synced - it is falling back to the CMOS clock, which drifts by design. The peer is stuck in Pending, meaning NTP on UDP 123 is not getting through or the peer is unreachable.",
 "Confirm UDP 123 outbound is allowed, then re-register the service and force a resync. On a domain-joined machine also check it is syncing from the domain hierarchy rather than an external server - mixing the two causes drift of its own.",
 (True,"the firewall was blocking outbound NTP")),

("windows","time synchronization","Websites give certificate errors and my clock is a day out",
 ["Check the clock against the time zone and DST","Look at the CMOS battery evidence","Fix the cause not the symptom"],
 [("Get-Date; Get-TimeZone | Select-Object Id, BaseUtcOffset",0,"Sunday, 16 August 2026 09:14:22\n\nId                       BaseUtcOffset\n--                       -------------\nGMT Standard Time             00:00:00",""),
  ("w32tm /query /status | Select-String 'Last Successful'",0,"Last Successful Sync Time: 8/17/2026 9:02:11 AM",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Boot'} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"The system clock was set to an earlier time at boot.","")],
 True,
 "The clock resets to an earlier time at every boot and only corrects once NTP sync completes - which is after the browser has already made its first connections. Certificates appear not-yet-valid during that window. The pattern points at a dead CMOS battery.",
 "Replace the CMOS battery. Forcing a resync fixes it until the next shutdown, so it looks solved but recurs - which is why the boot log rather than the current time is what identifies this.",
 (True,"five-year-old desktop, new battery sorted it")),

# ===================== CREDENTIALS =====================
("security","credentials","A saved password keeps being used even after I changed it",
 ["List what is stored in the credential vault","Identify the stale entry","Remove rather than overwrite"],
 [("cmdkey /list",0,"Target: Domain:target=fileserver\n    Type: Domain Password\n    User: CORP\\jdoe\n\nTarget: LegacyGeneric:target=fileserver\n    Type: Generic\n    User: jdoe",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625} -MaxEvents 3 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Message",0,"An account failed to log on. Status: 0xC000006A (bad password). Caller Process: explorer.exe",""),
  ("net use",0,"Status       Local     Remote\n-------------------------------------\nDisconnected Z:        \\\\fileserver\\shared","")],
 True,
 "Two credentials exist for the same target - a Domain Password entry and an older Generic one. Windows offers the generic one first, it carries the old password, and each attempt produces a bad-password failure. Changing the password in one place left the other behind.",
 "Delete both entries with cmdkey and let Windows prompt fresh. Do this promptly - repeated bad-password attempts from a stale credential are a common cause of accounts locking out for no obvious reason.",
 (True,"that explains the random lockouts too")),

("security","credentials","Windows Hello face sign-in stopped working after a Windows update",
 ["Check the biometric device and service","Look at whether the enrolment survived","Identify what to re-establish"],
 [("Get-Service WbioSrvc | Select-Object Status, StartType",0,"Status  StartType\n------  ---------\nRunning    Manual",""),
  ("Get-PnpDevice -Class Biometric | Select-Object Status, FriendlyName",0,"Status FriendlyName\n------ ------------\nOK     Windows Hello Face Software Device",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Biometrics/Operational'} -MaxEvents 3 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Message",0,"The biometric template database could not be opened. Error: 0x80070002","")],
 True,
 "The camera and service are healthy, but the biometric template database cannot be opened - the enrolment data was invalidated by the update. Windows falls back to PIN because there is no usable template to match against, not because the hardware failed.",
 "Remove and re-enrol face sign-in under Settings > Accounts > Sign-in options. The old templates cannot be recovered and should not be - they are deliberately non-portable, which is part of why Hello data never leaves the device.",
 (True,"re-enrolled in a minute, working again")),

# ===================== TASK SCHEDULER FAULTS =====================
("windows","Task Scheduler","A scheduled task shows 'Running' but never actually does anything",
 ["Check the task's last run result and duration","Look at whether the instance is stuck","Identify what blocks completion"],
 [("Get-ScheduledTask -TaskName 'NightlyReport' | Get-ScheduledTaskInfo | Select-Object LastRunTime, LastTaskResult, NumberOfMissedRuns",0,"LastRunTime         LastTaskResult NumberOfMissedRuns\n-----------         -------------- ------------------\n8/9/2026 2:00:00 AM         267009                  7",""),
  ("Get-ScheduledTask -TaskName 'NightlyReport' | Select-Object -ExpandProperty Settings | Select-Object ExecutionTimeLimit, MultipleInstances",0,"ExecutionTimeLimit MultipleInstances\n------------------ -----------------\nPT0S                       IgnoreNew",""),
  ("Get-Process -Name report -ErrorAction SilentlyContinue | Select-Object Id, StartTime, Responding",0,"  Id StartTime           Responding\n  -- ---------           ----------\n4820 8/9/2026 2:00:04 AM      False","")],
 True,
 "Result 267009 means the task is still running - it started eight days ago and the process has been unresponsive since. The execution time limit is PT0S, meaning no limit, so nothing ever terminates it, and MultipleInstances=IgnoreNew means every subsequent run is silently skipped. That accounts for the 7 missed runs.",
 "End the hung process, then set a realistic ExecutionTimeLimit such as PT1H so a stuck run is killed rather than blocking every future one. A task with no time limit and IgnoreNew fails permanently after a single hang.",
 (True,"set a 1 hour limit, it self-recovers now")),

("windows","Task Scheduler","A task works when I run it manually but fails on schedule with 0x1",
 ["Compare the manual and scheduled execution contexts","Check the working directory and account","Identify the difference"],
 [("Get-ScheduledTask -TaskName 'BackupScript' | Select-Object -ExpandProperty Principal | Select-Object UserId, RunLevel, LogonType",0,"UserId       RunLevel LogonType\n------       -------- ---------\nSYSTEM        Limited   Password",""),
  ("Get-ScheduledTask -TaskName 'BackupScript' | Select-Object -ExpandProperty Actions | Select-Object Execute, Arguments, WorkingDirectory",0,"Execute                Arguments            WorkingDirectory\n-------                ---------            ----------------\npowershell.exe         -File backup.ps1",""),
  ("Test-Path 'C:\\Scripts\\backup.ps1'",0,"True","")],
 True,
 "The action uses a relative script path with no working directory set. Run manually from the script folder it resolves; run by the scheduler it starts in C:\\Windows\\System32 where the file does not exist, and PowerShell exits with 1.",
 "Use the full path in the arguments, and set the working directory explicitly. Also note it runs as SYSTEM - if the script touches mapped drives or a user profile, those will not exist in that context even once the path is fixed.",
 (True,"full path sorted it, good catch on the SYSTEM context")),

# ===================== SHELL EXTENSIONS =====================
("windows","File Explorer","Right-clicking a file freezes Explorer for 30 seconds",
 ["Enumerate the context menu handlers","Identify handlers pointing at unavailable resources","Confirm the delay source"],
 [("Get-ChildItem 'HKCR:\\*\\shellex\\ContextMenuHandlers' -ErrorAction SilentlyContinue | Select-Object PSChildName",1,"","Cannot find drive. A drive with the name 'HKCR' does not exist."),
  ("New-PSDrive -Name HKCR -PSProvider Registry -Root HKEY_CLASSES_ROOT | Out-Null; Get-ChildItem 'HKCR:\\*\\shellex\\ContextMenuHandlers' | Select-Object PSChildName",0,"PSChildName\n-----------\nEPP\nOpenGLShExt\nSharingPrivate\nCloudSyncShell\nArchiverExt",""),
  ("Get-Service | Where-Object DisplayName -match 'CloudSync' | Select-Object Name, Status",0,"Name      Status\n----      ------\nCloudSync Stopped","")],
 True,
 "Five third-party context menu handlers are registered, and one of them belongs to a cloud sync product whose service is stopped. The handler waits for a response from a service that will never answer, and Explorer blocks until that request times out.",
 "Either start the CloudSync service or unregister its shell extension. Uninstalling the product cleanly removes the handler; deleting the registry key by hand works too but leaves the product half-configured, so prefer the uninstaller.",
 (True,"uninstalled the old sync tool, right-click is instant")),

("windows","File Explorer","Explorer opens a new window every time instead of using the current one",
 ["Check the folder launch setting","Look at whether processes are separated","Identify the configuration"],
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name SeparateProcess -ErrorAction SilentlyContinue",0,"SeparateProcess : 1",""),
  ("Get-Process explorer | Measure-Object | Select-Object Count",0,"Count\n-----\n    7",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name LaunchTo -ErrorAction SilentlyContinue",0,"LaunchTo : 1","")],
 True,
 "'Launch folder windows in a separate process' is enabled, which is why seven Explorer processes exist and each folder gets its own window. It is a stability setting, not a fault - one crashing window will not take the taskbar with it, at the cost of memory and this behaviour.",
 "Untick that option in Folder Options > View if you prefer single-window browsing. Keeping it on is reasonable if you work with unreliable shell extensions; it is a trade-off rather than something to fix outright.",
 (True,"turned it off, back to normal browsing")),

# ===================== BSOD =====================
("bluescreen","stop codes","Blue screen KERNEL_SECURITY_CHECK_FAILURE happens randomly",
 ["Check the bugcheck parameters","Look at what precedes each crash","Identify the faulting component"],
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 3 | Select-Object -ExpandProperty Message",0,"The computer has rebooted from a bugcheck. The bugcheck was: 0x00000139 (0x0000000000000003, ...). A dump was saved in C:\\Windows\\MEMORY.DMP.",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WHEA-Logger'} -MaxEvents 5 -ErrorAction SilentlyContinue",1,"","(no hardware error events)"),
  ("Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DriverDate -lt '2019-01-01' -and $_.DeviceName } | Select-Object DeviceName, DriverVersion, DriverDate",0,"DeviceName          DriverVersion DriverDate\n----------          ------------- ----------\nVirtual Audio Cable 4.15.0.0      2017-03-22","")],
 True,
 "Bugcheck 0x139 with parameter 3 is a list-entry corruption caught by kernel control flow guard - a driver damaged a kernel structure. There are no WHEA events, so this is not failing hardware, and one driver on the system dates from 2017.",
 "Uninstall the 2017 virtual audio driver and test. If the crashes continue, analyse MEMORY.DMP with WinDbg's !analyze -v to name the faulting module; 0x139 is almost always a driver, so replacing memory or reinstalling Windows would be premature.",
 (True,"virtual audio cable driver was the culprit")),

("bluescreen","stop codes","Blue screen WHEA_UNCORRECTABLE_ERROR at random with no pattern",
 ["Check whether the hardware error logger recorded the source","Look at clock and voltage settings","Distinguish a component from a configuration"],
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"The bugcheck was: 0x00000124 (0x0000000000000000, ...)",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WHEA-Logger'} -MaxEvents 3 | Select-Object -ExpandProperty Message",0,"A corrected hardware error has occurred. Component: Processor Core. Error Source: Machine Check Exception",""),
  ("Get-CimInstance Win32_Processor | Select-Object CurrentClockSpeed, MaxClockSpeed, LoadPercentage",0,"CurrentClockSpeed MaxClockSpeed LoadPercentage\n----------------- ------------- --------------\n             5300          4700              4","")],
 False,
 "WHEA is reporting machine check exceptions from the processor core, and the CPU is running at 5.3 GHz against a rated maximum of 4.7 - it is overclocked. Bugcheck 0x124 is the hardware telling Windows it produced an uncorrectable error, so this is not a software fault.",
 "Reset the BIOS to defaults, including any XMP or automatic overclocking profile, and test. If machine check exceptions persist at stock settings, the CPU or motherboard VRM needs investigating - continuing to run in this state risks silent data corruption in anything being written.",
 (False,"stock settings stopped the crashes, keeping it there")),

("bluescreen","stop codes","Blue screen SYSTEM_SERVICE_EXCEPTION only when I close a specific application",
 ["Correlate the crash with the application","Check the named module","Identify the driver involved"],
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"The bugcheck was: 0x0000003b (0x00000000c0000005, 0xfffff80... , ...)",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-PnP'} -MaxEvents 3 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Message",0,"Device ROOT\\SYSTEM\\0001 requires further installation.",""),
  ("Get-CimInstance Win32_SystemDriver | Where-Object { $_.State -eq 'Running' -and $_.Name -match 'vpn|filter|capture' } | Select-Object Name, PathName",0,"Name    PathName\n----    --------\nvpnflt  C:\\Windows\\System32\\drivers\\vpnflt.sys","')")],
 True,
 "Bugcheck 0x3B with an access violation means a kernel-mode routine faulted, and the crash reproduces on closing one specific application. A VPN filter driver is loaded, and filter drivers commonly fault when tearing down a connection at process exit.",
 "Update or remove the VPN client that owns vpnflt.sys and test the same close sequence. A reproducible bugcheck tied to one action is worth far more than a random one - it lets you confirm the fix rather than wait and hope.",
 (True,"old VPN client, updating it fixed the crash")),

# ===================== APPS / STORE =====================
("apps","Microsoft Store","Store apps open then close instantly with no error",
 ["Check whether the packages are registered correctly","Look at the app model events","Identify the failure point"],
 [("Get-AppxPackage -Name 'Microsoft.WindowsCalculator' | Select-Object Name, Status, InstallLocation",0,"Name                          Status InstallLocation\n----                          ------ ---------------\nMicrosoft.WindowsCalculator       Ok C:\\Program Files\\WindowsApps\\...",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-AppXDeploymentServer/Operational'} -MaxEvents 3 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Message",0,"error 0x80073CF6: package could not be registered - access denied on package folder",""),
  ("(Get-Acl 'C:\\Program Files\\WindowsApps').Owner",0,"BUILTIN\\Administrators","")],
 True,
 "The package reports Ok but registration fails with access denied, and the WindowsApps folder is owned by Administrators rather than TrustedInstaller. Someone took ownership of that folder, which breaks the permissions the app model depends on.",
 "Restore ownership to NT SERVICE\\TrustedInstaller and reset the inherited permissions on WindowsApps. Re-registering the packages will keep failing until the folder ACL is correct - taking ownership of WindowsApps is a common and damaging suggestion in older guides.",
 (True,"had taken ownership months ago to delete an app")),

("apps","application management","An application I uninstalled still shows in the Start menu and opens an error",
 ["Check whether the product is genuinely gone","Look for a leftover shortcut","Clean up the remnant"],
 [("Get-CimInstance Win32_Product -Filter \"Name LIKE '%OldApp%'\" -ErrorAction SilentlyContinue | Select-Object Name",1,"","(no matching product installed)"),
  ("Get-ChildItem \"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\" -Recurse -Filter '*.lnk' | Where-Object Name -match 'OldApp' | Select-Object FullName",0,"FullName\n--------\nC:\\Users\\jdoe\\AppData\\Roaming\\...\\Programs\\OldApp\\OldApp.lnk",""),
  ("Test-Path 'C:\\Program Files\\OldApp\\oldapp.exe'",0,"False","")],
 True,
 "The product is properly uninstalled and its executable is gone - only an orphaned shortcut in the user's Start menu folder remains, pointing at a path that no longer exists. That is why it appears in search and errors when clicked.",
 "Delete the shortcut folder from the user's Start Menu\\Programs directory. Uninstallers that write shortcuts to the user profile after installing per-machine often miss them on removal, so this is common rather than a sign of a bad uninstall.",
 (True,"deleted the folder, gone from search too")),

("apps","application management","Two versions of the same program are installed and the wrong one opens",
 ["List the installed versions","Check which one owns the file association","Correct the association"],
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object DisplayName -match 'PDF Editor' | Select-Object DisplayName, DisplayVersion",0,"DisplayName    DisplayVersion\n-----------    --------------\nPDF Editor      8.2.1\nPDF Editor     11.0.4",""),
  ("cmd /c \"assoc .pdf\"",0,".pdf=PDFEditor.Document.8",""),
  ("cmd /c \"ftype PDFEditor.Document.8\"",0,"PDFEditor.Document.8=\"C:\\Program Files (x86)\\PDF Editor 8\\editor.exe\" \"%1\"","")],
 True,
 "Both a 32-bit version 8 and a 64-bit version 11 are installed, and the .pdf association still points at version 8's ProgID. The newer installer did not take over the association, so double-clicking always opens the old build.",
 "Uninstall version 8 - keeping two versions of the same editor is the underlying problem - then set the default app for .pdf explicitly. If version 8 is needed for something specific, change the association through Settings rather than by editing the registry.",
 (True,"removed the old one, no reason to keep it")),

# ===================== POWER / BATTERY =====================
("power","battery","The laptop shuts down at 30% battery without warning",
 ["Check the reported versus actual capacity","Look at the wear level","Determine whether the gauge is wrong"],
 [("Get-CimInstance -Namespace root/wmi -ClassName BatteryStaticData | Select-Object DesignedCapacity",0,"DesignedCapacity\n----------------\n            5200",""),
  ("Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity | Select-Object FullChargedCapacity",0,"FullChargedCapacity\n-------------------\n               1840",""),
  ("Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus",0,"EstimatedChargeRemaining BatteryStatus\n------------------------ -------------\n                      30             1","")],
 True,
 "The battery holds 1,840 mWh of a designed 5,200 - about 35% of its original capacity. The percentage shown is a proportion of what it can currently hold, and the cells collapse under load well before that figure reaches zero, so the shutdown is abrupt.",
 "Replace the battery. Recalibrating the gauge would make the reported percentage more honest but cannot restore capacity - at 35% health the runtime you are seeing is what the cells can deliver.",
 (True,"four year old laptop, new battery ordered")),

("power","sleep","The PC wakes up seconds after I put it to sleep",
 ["Find what last woke the machine","List devices permitted to wake it","Disable the specific one"],
 [("powercfg /lastwake",0,"Wake History Count - 1\nWake History [0]\n  Wake Source Count - 1\n  Wake Source [0]\n    Type: Device\n    Instance Path: PCI\\VEN_8086&DEV_15F3...\n    Friendly Name: Intel Ethernet Connection",""),
  ("powercfg /devicequery wake_armed",0,"HID Keyboard Device\nIntel(R) Ethernet Connection I219-V\nUSB Input Device",""),
  ("Get-NetAdapterPowerManagement -Name 'Ethernet' | Select-Object WakeOnMagicPacket, WakeOnPattern",0,"WakeOnMagicPacket WakeOnPattern\n----------------- -------------\n          Enabled       Enabled","")],
 True,
 "The Ethernet adapter is the wake source, and it is set to wake on any network pattern - not just a magic packet. Ordinary broadcast traffic on the LAN is enough to trigger it, which is why it happens within seconds every time.",
 "Turn off Wake on Pattern Match while leaving Wake on Magic Packet if you use Wake-on-LAN. Pattern matching is almost never what people want; magic packets are targeted and will not fire on background chatter.",
 (True,"disabled pattern match, sleeps properly now")),

# ===================== NETWORK =====================
("network","DNS","Internal sites resolve but only when I type the full name",
 ["Check the DNS suffix search list","Compare short and full name resolution","Identify the missing suffix"],
 [("Resolve-DnsName intranet -ErrorAction SilentlyContinue",1,"","intranet : DNS name does not exist"),
  ("Resolve-DnsName intranet.corp.local | Select-Object Name, IPAddress",0,"Name                  IPAddress\n----                  ---------\nintranet.corp.local   10.4.2.18",""),
  ("Get-DnsClientGlobalSetting | Select-Object SuffixSearchList",0,"SuffixSearchList\n----------------\n{}",""),
  ("Get-DnsClient -InterfaceAlias 'Ethernet' | Select-Object ConnectionSpecificSuffix",0,"ConnectionSpecificSuffix\n------------------------\n","")],
 True,
 "The suffix search list is empty and the connection has no connection-specific suffix, so short names are never expanded. The full name resolves correctly, confirming DNS itself is healthy - only the suffix appending is missing.",
 "Set the DNS suffix search list to corp.local, ideally through DHCP option 15 or Group Policy so every machine gets it. Setting it manually on one machine works but the next one to join will have the same problem.",
 (True,"DHCP wasn't handing out the domain suffix")),

("network","VPN","VPN connects but everything becomes slow, including local network",
 ["Check the route table after connecting","Look at whether all traffic is being tunnelled","Identify the routing effect"],
 [("Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object InterfaceAlias, NextHop, RouteMetric",0,"InterfaceAlias NextHop     RouteMetric\n-------------- -------     -----------\nVPN Tunnel     0.0.0.0               1\nWi-Fi          192.168.1.1          25",""),
  ("Get-NetIPInterface -InterfaceAlias 'VPN Tunnel' | Select-Object NlMtu, InterfaceMetric",0,"NlMtu InterfaceMetric\n----- ---------------\n 1300               1",""),
  ("Test-NetConnection 192.168.1.50 -InformationLevel Quiet",0,"False","")],
 True,
 "The VPN installs a default route with a lower metric than the physical adapter, so all traffic including local subnet access goes through the tunnel. That is full-tunnel mode working as configured - and the reduced MTU of 1300 adds fragmentation overhead on top.",
 "If the policy allows it, ask for a split-tunnel profile so only corporate ranges use the tunnel. Full tunnel is often a deliberate security decision, in which case the slowdown is the accepted cost and only the MTU is worth tuning.",
 (True,"security requires full tunnel, at least now I understand it")),

("network","adapters","Ethernet shows connected but with a 169.254 address",
 ["Check the DHCP lease state","Test whether a DHCP server responds","Determine where the request fails"],
 [("Get-NetIPAddress -InterfaceAlias 'Ethernet' -AddressFamily IPv4 | Select-Object IPAddress, PrefixOrigin, SuffixOrigin",0,"IPAddress       PrefixOrigin SuffixOrigin\n---------       ------------ ------------\n169.254.18.203  WellKnown    Link",""),
  ("Get-NetAdapter -Name 'Ethernet' | Select-Object Status, LinkSpeed",0,"Status LinkSpeed\n------ ---------\nUp     100 Mbps",""),
  ("Get-Service Dhcp | Select-Object Status, StartType",0,"Status  StartType\n------  ---------\nRunning Automatic",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Dhcp-Client'} -MaxEvents 3 | Select-Object -ExpandProperty Message",0,"Your computer was not able to renew its address from the network (DHCP server). No response received.","")],
 True,
 "The link is up but negotiated at 100 Mbps on what should be a gigabit connection, and no DHCP server responds. That combination - degraded link speed plus no DHCP - points at the cable or port rather than at Windows: a damaged pair drops the link to 100 Mbps and can corrupt the DHCP exchange.",
 "Replace the cable and try a different switch port. If the address is obtained but the speed stays at 100 Mbps, the run itself is faulty; the APIPA address is a downstream symptom either way.",
 (True,"cable had been crushed under a desk leg")),

# ===================== USER PROFILE =====================
("windows","user profiles","Logging in takes five minutes but is instant for other users on the same PC",
 ["Compare the profile sizes","Check for folder redirection or roaming","Identify what is loaded at logon"],
 [("Get-CimInstance Win32_UserProfile | Select-Object LocalPath, RoamingConfigured, Loaded",0,"LocalPath          RoamingConfigured Loaded\n---------          ----------------- ------\nC:\\Users\\jdoe                   True   True\nC:\\Users\\asmith                False   True",""),
  ("Get-ChildItem 'C:\\Users\\jdoe\\AppData\\Roaming' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum | Select-Object Count, @{N='GB';E={[math]::Round($_.Sum/1GB,2)}}",0,"Count   GB\n-----   --\n84021 14.20",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-User Profiles Service'; Id=1509} -MaxEvents 2 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Message",0,"Windows cannot copy file ... to location ... Possible causes: network problems or insufficient security rights.","")],
 True,
 "This account uses a roaming profile with 14.2 GB in AppData\\Roaming, which must be copied down at every logon. The other user is local, so nothing is transferred. Copy errors are also being logged, so some of that transfer is retrying.",
 "Exclude the large AppData subfolders from roaming through Group Policy - browser caches and application data are the usual bulk and do not need to roam. Folder redirection for Documents and Desktop is the better long-term answer than a large roaming profile.",
 (True,"excluded the cache folders, logon is 20 seconds now")),

("windows","user profiles","My desktop icons and settings reset every time I log in",
 ["Check whether the profile is temporary","Look at the profile service events","Identify why the real profile is not loading"],
 [("Get-CimInstance Win32_UserProfile | Where-Object Loaded | Select-Object LocalPath, Status, SID",0,"LocalPath           Status SID\n---------           ------ ---\nC:\\Users\\TEMP            0 S-1-5-21-...-1104",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-User Profiles Service'; Id=1511} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"Windows cannot find the local profile and is logging you on with a temporary profile.",""),
  ("Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList' | Select-Object PSChildName | Where-Object PSChildName -match '1104'",0,"PSChildName\n-----------\nS-1-5-21-...-1104.bak","")],
 True,
 "You are being logged into a temporary profile - anything saved is discarded at logoff. The profile list entry for this account has a .bak suffix, which is why Windows cannot find the real profile and creates a temporary one instead.",
 "Rename the .bak key back to the plain SID after backing up the ProfileList branch. Save nothing to the desktop until this is resolved - work created in a temporary profile is deleted at logoff and cannot be recovered afterwards.",
 (True,"renamed the key, everything came back")),
]

with open(JSON_PATH, encoding="utf-8") as f: data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f: jsonl_lines = [l for l in f if l.strip()]
existing = {d["goal"] for d in data}
prefix = collections.defaultdict(list)
for g in existing: prefix[' '.join(g.lower().split()[:4])].append(g)

base = datetime(2026, 8, 18, 9, 0, 0)
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
print(f"added: {added} | dups: {skipped} | prefix collisions: {len(near)}")
for a,b in near: print("  NEAR:", a[:52], "<>", b[:52])
print("Total:", len(data))
