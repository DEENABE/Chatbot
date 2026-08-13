#!/usr/bin/env python3
"""gen23.py - Round 4: printer/scanner, security ("is my PC safe?"),
startup/boot and power - all in plain user language, root causes distinct
from the existing technical records."""
import json, collections, uuid
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

NEW = [
# ============================== PRINTER ==============================
("printer","printing","Everything prints really small with huge margins",
 ["Check the paper size the driver is set to","Compare against the paper actually loaded","Correct the mismatch"],
 [("Get-PrintConfiguration -PrinterName 'HP LaserJet' | Select-Object PaperSize, Collate, DuplexingMode",0,"PaperSize Collate DuplexingMode\n--------- ------- -------------\nLetter       True OneSided",""),
  ("Get-Culture | Select-Object Name, @{N='Region';E={(Get-WinHomeLocation).HomeLocation}}",0,"Name  Region\n----  ------\nen-GB     242",""),
  ("Get-Printer -Name 'HP LaserJet' | Select-Object Name, DriverName",0,"Name        DriverName\n----        ----------\nHP LaserJet HP Universal Printing PCL 6","")],
 True,
 "The driver is set to US Letter while the tray holds A4. Letter is shorter and wider, so the printer scales the page down to fit and adds margins to compensate - the document is correct, the paper definition is not.",
 "Set the default paper size to A4 in Printing Preferences and also in the Advanced tab's printing defaults, since the two are separate. Applications that specify their own size will still override this per document.",
 (True,"was set to Letter from the day it was installed")),

("printer","printing","Only the top half of the page prints, then it stops",
 ["Check whether the job completes or errors","Look at the printer's memory and rendering mode","Identify where the page is being truncated"],
 [("Get-PrintJob -PrinterName 'OfficeJet' -ErrorAction SilentlyContinue | Select-Object Id, JobStatus, Size",1,"","(no jobs queued - each one completes)"),
  ("Get-PrintConfiguration -PrinterName 'OfficeJet' | Select-Object PaperSize",0,"PaperSize\n---------\nA4",""),
  ("Get-Printer -Name 'OfficeJet' | Select-Object Name, DriverName, RenderingMode",0,"Name      DriverName                  RenderingMode\n----      ----------                  -------------\nOfficeJet HP Universal PCL 6          SSR","")],
 True,
 "The job completes without error, so nothing is failing in Windows - the page is being truncated at the device. With client-side rendering the whole page is sent as a bitmap, and this printer's memory cannot hold a full A4 page at the current resolution, so it prints what it has and ejects.",
 "Lower the print resolution to 600 dpi, or switch the driver to send PCL commands rather than a rendered bitmap. Adding memory to the printer is the hardware fix if high resolution is genuinely needed.",
 (True,"600 dpi prints the full page fine")),

("printer","printing","I click print and nothing happens - no error, no paper",
 ["Check which printer the job actually went to","Look for the job in any queue","Identify where it was sent"],
 [("Get-Printer | Select-Object Name, PrinterStatus, @{N='Default';E={$_.Name -eq (Get-CimInstance Win32_Printer -Filter 'Default=True').Name}}",0,"Name                 PrinterStatus Default\n----                 ------------- -------\nHP LaserJet          Normal          False\nMicrosoft Print to PDF Normal         True",""),
  ("Get-ChildItem \"$env:USERPROFILE\\Documents\" -Filter '*.pdf' | Sort-Object LastWriteTime -Descending | Select-Object -First 3 Name, LastWriteTime",0,"Name              LastWriteTime\n----              -------------\nDocument.pdf      8/14/2026 2:14 PM\nDocument(2).pdf   8/14/2026 2:11 PM",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows' -Name LegacyDefaultPrinterMode -ErrorAction SilentlyContinue",0,"LegacyDefaultPrinterMode : 0  (Windows manages the default printer)","")],
 True,
 "The jobs are printing successfully - to Microsoft Print to PDF, which has become the default. Three PDFs appeared in Documents at exactly the times printing was attempted. Windows manages the default printer automatically and set it to the last one used.",
 "Set HP LaserJet as default and turn off 'Let Windows manage my default printer' in Printers & scanners, otherwise it will switch again the next time another printer is used.",
 (True,"found all my documents as PDFs in Documents, mystery solved")),

("printer","printing","When I turn the printer on it prints a pile of old documents",
 ["Check what is sitting in the queue","Establish how long they have been there","Clear them safely"],
 [("Get-PrintJob -PrinterName 'HP LaserJet' | Select-Object Id, DocumentName, JobStatus, SubmittedTime",0,"Id DocumentName        JobStatus SubmittedTime\n-- ------------        --------- -------------\n12 Invoice-July.pdf    Normal    8/2/2026 9:14:02 AM\n13 Report.docx         Normal    8/5/2026 4:22:18 PM",""),
  ("Get-Service Spooler | Select-Object Status",0,"Status\n------\nRunning",""),
  ("Get-Printer -Name 'HP LaserJet' | Select-Object PrinterStatus, WorkOffline",0,"PrinterStatus WorkOffline\n------------- -----------\nNormal               True","")],
 True,
 "The printer was set to 'Use Printer Offline', so every job since 2 August queued locally instead of failing. Turning the printer on cleared the offline state and the spooler released the whole backlog at once.",
 "Clear the queue before printing anything new, then uncheck 'Use Printer Offline'. That setting exists to let you queue work deliberately, but it also silently accumulates jobs when it is set by accident.",
 (True,"12 old documents, cleared them before they wasted more paper")),

("printer","printing","My colleague can print to the shared printer but I get access denied",
 ["Confirm the printer is reachable","Compare permissions rather than connectivity","Identify the difference between the two accounts"],
 [("Test-NetConnection printsrv -Port 445 -InformationLevel Quiet",0,"True",""),
  ("Get-Printer -ComputerName printsrv -Name 'Finance-HP' | Select-Object Name, Shared, PrinterStatus",0,"Name       Shared PrinterStatus\n----       ------ -------------\nFinance-HP   True        Normal",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-PrintService/Admin'; Id=372} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"The document failed to print. Win32 error code returned by the print processor: 5.",""),
  ("whoami /groups | Select-String 'Finance'",1,"","(not a member of the Finance group)")],
 True,
 "The print server is reachable and the printer is shared and healthy, so this is not a connectivity problem. Win32 error 5 is access denied, and the account is not in the Finance group that holds Print permission on that queue - which is exactly why a colleague in that group can use it.",
 "Ask whoever administers the print server to add your account to the group with Print permission. Nothing on this machine can grant access, so reinstalling the printer here would not help.",
 (True,"IT added me to the group, printed straight away")),

("printer","printing","Printing takes ages - it sits there for a minute before anything comes out",
 ["Establish whether the delay is in rendering or transmission","Check where the job is being processed","Look at the driver and connection type"],
 [("Get-Printer -Name 'Floor2-HP' | Select-Object Name, RenderingMode, PortName, DriverName",0,"Name      RenderingMode PortName          DriverName\n----      ------------- --------          ----------\nFloor2-HP CSR           \\\\printsrv\\HP     HP Universal PCL 6",""),
  ("Test-NetConnection printsrv -Port 445 -InformationLevel Detailed | Select-Object PingReplyDetails",0,"PingReplyDetails : RoundtripTime 68",""),
  ("Get-PrintJob -PrinterName 'Floor2-HP' -ErrorAction SilentlyContinue | Select-Object Size, JobStatus",0,"    Size JobStatus\n    ---- ---------\n42918400 Spooling","")],
 True,
 "Client-side rendering is on, so the machine converts each document to a 42 MB print stream and then pushes it across a link with 68 ms latency to the print server. The delay is the transfer, not the printer - large rendered jobs over a slow link are exactly this pattern.",
 "Switch this queue to server-side rendering so only the compact document description crosses the network. Client-side rendering makes sense on a fast LAN with a busy server, but not over a high-latency link.",
 (True,"prints almost instantly with server rendering")),

("printer","printing","The scanner scans but I can never find the file afterwards",
 ["Find where the scan is configured to save","Check whether that location is reachable","Confirm the scan actually completed"],
 [("Get-PnpDevice -Class Image | Select-Object Status, FriendlyName",0,"Status FriendlyName\n------ ------------\nOK     Brother MFC-L2750DW",""),
  ("Get-Service stisvc | Select-Object Status",0,"Status\n------\nRunning",""),
  ("Test-Path '\\\\oldserver\\scans'",1,"","False"),
  ("Get-ChildItem \"$env:USERPROFILE\\Pictures\\Scans\" -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count\n-----\n    0","")],
 True,
 "The scanner works and the imaging service is running, so scanning itself succeeds. The destination is a network share that no longer exists, so each scan is written nowhere and the failure is silent - the device reports success because it handed the job off correctly.",
 "Point the scan destination at a local folder in the scanner's software, or restore access to the share. Scan-to-folder failures are usually silent by design, which is why nothing appeared to go wrong.",
 (True,"was pointing at a server we decommissioned last year")),

("printer","printing","Windows can't add the network printer - it says it can't connect to it",
 ["Confirm the print server and share are reachable","Check whether a driver can be obtained","Identify what blocks the connection"],
 [("Test-NetConnection printsrv -Port 445 -InformationLevel Quiet",0,"True",""),
  ("Get-Printer -ComputerName printsrv -ErrorAction SilentlyContinue | Select-Object Name, Shared",0,"Name        Shared\n----        ------\nFinance-HP    True",""),
  ("Get-PrinterDriver -ComputerName printsrv | Select-Object Name, PrinterEnvironment",0,"Name                     PrinterEnvironment\n----                     ------------------\nHP Universal Printing    Windows NT x86",""),
  ("Get-CimInstance Win32_OperatingSystem | Select-Object OSArchitecture",0,"OSArchitecture\n--------------\n64-bit","")],
 True,
 "The server and share are both fine. The print server only hosts a 32-bit driver, and this is a 64-bit client, so there is no driver for Windows to download during the connection - which surfaces as a connection failure rather than a driver error.",
 "Have the print server administrator add the x64 driver for that queue. As a workaround you can install the driver locally and create a port pointing at the printer directly, bypassing the server's driver store.",
 (True,"IT added the 64-bit driver and it connected")),

# ============================== SECURITY ==============================
("security","Windows Security","Is my computer actually safe? I don't really know what to check",
 ["Check the protections that matter, not just the dashboard","Verify each is genuinely active","Give a plain-language verdict"],
 [("Get-MpComputerStatus | Select-Object AMRunningMode, RealTimeProtectionEnabled, AntivirusSignatureAge, QuickScanAge",0,"AMRunningMode             : Normal\nRealTimeProtectionEnabled : True\nAntivirusSignatureAge     : 0\nQuickScanAge              : 1",""),
  ("Get-NetFirewallProfile | Select-Object Name, Enabled",0,"Name    Enabled\n----    -------\nDomain     True\nPrivate    True\nPublic     True",""),
  ("Get-BitLockerVolume -MountPoint C: | Select-Object ProtectionStatus",0,"ProtectionStatus\n----------------\n             Off",""),
  ("Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 1 HotFixID, InstalledOn",0,"HotFixID  InstalledOn\n--------  -----------\nKB5041585 8/8/2026",""),
  ("Get-CimInstance Win32_StartupCommand | Where-Object { $_.Command -match 'AppData|ProgramData|Temp' } | Select-Object Name, Command",1,"","(no startup entries from user-writable locations)")],
 True,
 "Four of five checks are good: Defender is active with today's definitions, the firewall is on for all three profiles, updates are current as of six days ago, and nothing suspicious is starting from user-writable folders. The one gap is disk encryption - C: is not encrypted, so anyone with physical access can read your files by removing the drive.",
 "Turn on BitLocker (or Device Encryption on Home) and save the recovery key to your Microsoft account. Everything else here is genuinely fine - you do not need additional antivirus on top of what is already running.",
 (True,"turned on encryption, good to know the rest was ok")),

("security","Defender","I clicked a link in an email that I don't think was genuine - what should I do?",
 ["Check whether anything was downloaded or executed","Look for new persistence entries","Establish whether action is needed or not"],
 [("Get-ChildItem \"$env:USERPROFILE\\Downloads\" -File | Where-Object LastWriteTime -gt (Get-Date).AddHours(-2) | Select-Object Name, Length",1,"","(nothing downloaded in the last two hours)"),
  ("Get-MpThreatDetection | Where-Object InitialDetectionTime -gt (Get-Date).AddDays(-1) | Measure-Object | Select-Object Count",0,"Count\n-----\n    0",""),
  ("Get-CimInstance Win32_StartupCommand | Where-Object { $_.Command -match 'AppData|Temp|ProgramData' }",1,"","(no new startup entries)"),
  ("Get-ScheduledTask | Where-Object { $_.Date -gt (Get-Date).AddDays(-1).ToString('yyyy-MM-dd') } -ErrorAction SilentlyContinue | Select-Object TaskName",1,"","(no tasks created today)")],
 True,
 "Nothing was downloaded, Defender recorded no detections, and no new startup entries or scheduled tasks were created. Clicking a link that only loads a page does not by itself compromise a machine - the risk is in what you then download or type.",
 "If you entered any credentials on that page, change that password now and enable multi-factor authentication - that is the realistic exposure here, not malware. Run a quick scan for reassurance, but there is no evidence anything ran.",
 (True,"didn't type anything in, just clicked - relieved")),

("security","Defender","A website popped up saying my PC is infected and to call a number",
 ["Determine whether the warning came from Windows or a web page","Check whether any real detection exists","Explain what the message actually is"],
 [("Get-MpThreatDetection | Measure-Object | Select-Object Count",0,"Count\n-----\n    0",""),
  ("Get-MpComputerStatus | Select-Object AMRunningMode, RealTimeProtectionEnabled",0,"AMRunningMode             : Normal\nRealTimeProtectionEnabled : True",""),
  ("Get-Process | Where-Object { $_.Name -match 'chrome|msedge|firefox' } | Select-Object Name, MainWindowTitle",0,"Name   MainWindowTitle\n----   ---------------\nchrome Critical Alert! - Google Chrome",""),
  ("Get-CimInstance Win32_StartupCommand | Where-Object Command -match 'AppData|Temp'",1,"","(nothing installed)")],
 True,
 "Defender reports zero detections and is running normally. The warning is a web page inside Chrome - the window title itself gives it away. Windows never displays security warnings inside a browser and never asks you to call a phone number. This is a tech support scam page, not an infection.",
 "Close the tab, or end the browser process if the page blocks you. Never call the number and never allow remote access. Nothing was installed here, so no cleanup is needed - but clear the browser cache if the page reappears from history.",
 (True,"closed it, didn't call - my neighbour lost money to one of these")),

("security","Defender","Someone sent me a file and I want to know if it's safe before opening it",
 ["Inspect the file without executing it","Check its type, signature and origin","Give a risk assessment"],
 [("Get-Item 'C:\\Users\\jdoe\\Downloads\\Invoice_2026.pdf.exe' | Select-Object Name, Length, CreationTime",0,"Name                   Length CreationTime\n----                   ------ ------------\nInvoice_2026.pdf.exe   842104 8/14/2026 11:02 AM",""),
  ("Get-AuthenticodeSignature 'C:\\Users\\jdoe\\Downloads\\Invoice_2026.pdf.exe' | Select-Object Status, SignerCertificate",0,"Status            SignerCertificate\n------            -----------------\nNotSigned",""),
  ("Get-Item 'C:\\Users\\jdoe\\Downloads\\Invoice_2026.pdf.exe' -Stream Zone.Identifier | Select-Object Length",0,"Length\n------\n    26",""),
  ("Start-MpScan -ScanPath 'C:\\Users\\jdoe\\Downloads\\Invoice_2026.pdf.exe' -ScanType CustomScan",0,"","")],
 True,
 "Three findings, examined without running the file. It is an executable disguised with a double extension - Invoice_2026.pdf.exe is a program, not a document. It carries no digital signature, and it came from the internet. Any one of these warrants caution; together they are a textbook malicious attachment.",
 "Do not open it. Delete it and confirm with the sender through a different channel whether they sent anything - their account may be compromised. A genuine invoice arrives as .pdf, and a legitimate program from a real company is signed.",
 (True,"deleted it - the sender's account had been hacked")),

("security","Defender","My browser homepage and search engine changed on their own",
 ["Check whether browser policy has been set","Look for forced extensions","Identify what applied the change"],
 [("Get-ChildItem 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome' -ErrorAction SilentlyContinue | Select-Object Name",0,"Name\n----\nExtensionInstallForcelist",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome' -Name HomepageLocation, DefaultSearchProviderSearchURL -ErrorAction SilentlyContinue",0,"HomepageLocation               : https://search-portal.example\nDefaultSearchProviderSearchURL : https://search-portal.example/q={searchTerms}",""),
  ("Get-CimInstance Win32_StartupCommand | Where-Object Command -match 'AppData|ProgramData' | Select-Object Name, Command",0,"Name       Command\n----       -------\nSearchHelp C:\\ProgramData\\SearchHelp\\shelper.exe",""),
  ("Get-MpThreatDetection | Select-Object -First 2 ThreatName",0,"ThreatName\n----------\nPUA:Win32/Adware","")],
 True,
 "Enterprise policy keys have been written into Chrome's registry to pin the homepage and search engine, and an extension is force-installed so it cannot be removed from the browser UI. There is also a startup entry running from ProgramData. This is adware, and Defender has already flagged a related component.",
 "This needs proper removal: run a full Microsoft Defender Offline scan, then delete the policy keys under HKLM\\SOFTWARE\\Policies\\Google\\Chrome and the ProgramData startup entry. Changing the homepage in Chrome alone will not hold while the policy exists.",
 (True,"offline scan plus removing the policy keys sorted it")),

("security","account security","I think someone else has used my computer - can you tell?",
 ["Check the sign-in history","Look for account changes","Distinguish normal activity from someone else"],
 [("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4624} -MaxEvents 8 | Where-Object { $_.Message -match 'Logon Type:\\s+(2|10)' } | Select-Object TimeCreated",0,"TimeCreated\n-----------\n8/14/2026 8:41:02 AM\n8/13/2026 11:52:31 PM\n8/13/2026 8:22:14 AM",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4720,4732} -MaxEvents 5 -ErrorAction SilentlyContinue",1,"","(no accounts created, none added to Administrators)"),
  ("Get-LocalUser | Select-Object Name, Enabled, LastLogon",0,"Name          Enabled LastLogon\n----          ------- ---------\njdoe             True 8/14/2026 8:41:02 AM\nAdministrator   False",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625} -MaxEvents 5 -ErrorAction SilentlyContinue",1,"","(no failed sign-in attempts)")],
 True,
 "There is one interactive sign-in at 23:52 last night, outside your usual pattern - but it used your account and there were no failed attempts beforehand, which is what a stranger guessing would produce. No accounts were created and nobody was added to Administrators.",
 "If you were not at the machine at 23:52, someone knew or had your password rather than breaking in - change it and enable a PIN or Hello. If a household member used it, this is simply your own account being shared, which the logs cannot distinguish.",
 (True,"it was my son using my login, told him to use his own")),

("security","Defender","Lots of my files have been renamed with a strange extension and won't open",
 ["Confirm what happened to the files","Check for an active threat","Act to limit further damage"],
 [("Get-ChildItem \"$env:USERPROFILE\\Documents\" -Recurse -File | Group-Object Extension | Sort-Object Count -Descending | Select-Object -First 3 Name, Count",0,"Name     Count\n----     -----\n.locked   1842\n.txt          3",""),
  ("Get-ChildItem \"$env:USERPROFILE\\Documents\" -Filter '*README*' | Select-Object Name, LastWriteTime",0,"Name                 LastWriteTime\n----                 -------------\nREADME_RESTORE.txt   8/14/2026 3:02:11 AM",""),
  ("Get-MpThreatDetection | Select-Object -First 2 ThreatName, InitialDetectionTime",0,"ThreatName                InitialDetectionTime\n----------                --------------------\nRansom:Win32/Filecoder    8/14/2026 3:01:44 AM",""),
  ("Get-MpPreference | Select-Object EnableControlledFolderAccess",0,"EnableControlledFolderAccess\n-----------------------------\n                           0","")],
 False,
 "This is a ransomware attack that ran at around 03:00. 1,842 files have been encrypted and renamed, a ransom note was written, and Defender detected the payload - but Controlled Folder Access was off, so the encryption was not blocked before it ran.",
 "Disconnect this machine from the network immediately to stop it reaching shared drives, and do not pay. Restore from a backup taken before 03:00 today; check whether your backup drive was attached at the time, because ransomware encrypts connected backups too. Preserve the ransom note - it identifies the variant, and free decryptors exist for some.",
 (False,"disconnected it, IT are restoring from Friday's backup")),

("security","security policy","Windows Security keeps showing a red warning but I don't know what it wants",
 ["Read what each protection area actually reports","Identify which one is degraded","Translate it into something actionable"],
 [("Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled, AntivirusSignatureAge, TamperProtectionSource",0,"RealTimeProtectionEnabled : True\nAntivirusSignatureAge     : 0\nTamperProtectionSource    : Intune",""),
  ("Get-NetFirewallProfile | Where-Object Enabled -eq $false | Select-Object Name",0,"Name\n----\nPublic",""),
  ("Get-CimInstance -Namespace root/Microsoft/Windows/DeviceGuard -ClassName Win32_DeviceGuard | Select-Object SecurityServicesRunning",0,"SecurityServicesRunning\n-----------------------\n{}",""),
  ("Get-Tpm | Select-Object TpmPresent, TpmReady",0,"TpmPresent TpmReady\n---------- --------\n      True     True","")],
 True,
 "Antivirus and updates are healthy. Two things are degraded: the firewall is off specifically for Public networks, which is the profile that matters most on café and hotel Wi-Fi, and memory integrity is not running despite the hardware supporting it.",
 "Re-enable the firewall for the Public profile first - that is the meaningful risk. Memory integrity can be turned on under Core isolation, though it may flag an incompatible driver, in which case update that driver rather than leaving the feature off permanently.",
 (True,"public firewall was off, no idea how")),

# ============================== STARTUP / BOOT ==============================
("boot","boot configuration","It sits on the spinning dots for two or three minutes before the login screen",
 ["Separate firmware time from Windows boot time","Check what runs before the logon screen","Identify the delay's source"],
 [("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Diagnostics-Performance/Operational'; Id=100} -MaxEvents 3 | Select-Object -ExpandProperty Message",0,"Windows has started up:\n Boot Duration: 184622ms\n MainPathBootTime: 41200ms\n BootPostBootTime: 143422ms",""),
  ("Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } | Select-Object Name",0,"Name\n----\nVendorSyncSvc",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; Id=7009} -MaxEvents 3 | Select-Object -ExpandProperty Message",0,"A timeout was reached (30000 milliseconds) while waiting for the VendorSyncSvc service to connect.","")],
 True,
 "The boot itself takes 41 seconds; the remaining 143 seconds is post-boot. A vendor service is timing out after 30 seconds on each of several start attempts and never comes up, and the boot sequence waits on it before proceeding.",
 "Set VendorSyncSvc to Manual or Automatic (Delayed Start) so it stops blocking the boot path, then investigate why it fails - the timeout is the symptom of a service that cannot start rather than one that is merely slow.",
 (True,"delayed start took two minutes off the boot")),

("boot","boot configuration","Every time I start up it says 'Preparing Windows, don't turn off your computer'",
 ["Check whether an update is genuinely pending","Look at the servicing state","Determine whether it is progressing or stuck"],
 [("Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 2 HotFixID, InstalledOn",0,"HotFixID  InstalledOn\n--------  -----------\nKB5041585 8/8/2026",""),
  ("Test-Path 'C:\\Windows\\WinSxS\\pending.xml'",0,"True",""),
  ("Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending' -ErrorAction SilentlyContinue",0,"(key present - reboot pending)",""),
  ("DISM /Online /Cleanup-Image /ScanHealth",0,"The component store is repairable.","")],
 True,
 "A servicing transaction has been left pending and never completes, so every startup attempts the same unfinished work and shows the preparing message. The component store also reports as repairable, which is why the transaction cannot commit.",
 "Run DISM /Online /Cleanup-Image /RestoreHealth and reboot. If the message persists, the pending transaction needs reverting from the recovery environment before the update can be reinstalled cleanly - do not simply keep rebooting.",
 (True,"DISM repair then one reboot and the message stopped")),

("boot","boot configuration","It gets to the desktop but nothing works for the first minute - icons load slowly",
 ["Check post-logon activity rather than boot time","Identify what competes at sign-in","Quantify the biggest contributor"],
 [("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Diagnostics-Performance/Operational'; Id=103} -MaxEvents 4 | Select-Object -ExpandProperty Message",0,"This service caused a delay in the startup process:\n Name: Backup Agent\n Total Time: 38210ms",""),
  ("Get-CimInstance Win32_StartupCommand | Measure-Object | Select-Object Count",0,"Count\n-----\n   14",""),
  ("Get-PhysicalDisk | Select-Object MediaType, HealthStatus",0,"MediaType HealthStatus\n--------- ------------\nSSD       Healthy","")],
 True,
 "The performance log names the specific culprit: a backup agent taking 38 seconds during startup, alongside 14 other startup items. The disk is a healthy SSD, so this is contention from software rather than slow storage.",
 "Configure the backup agent to start delayed rather than at logon - it does not need to run before you can use the machine. The 103 events name the slowest items directly, which is a far better guide than disabling startup entries at random.",
 (True,"delayed the backup agent, desktop is usable immediately now")),

# ============================== POWER ==============================
("power","power management","The battery stops charging at 80% and never goes higher",
 ["Check whether Windows reports a fault","Look for a vendor charge policy","Determine whether this is intentional"],
 [("Get-CimInstance Win32_Battery | Select-Object BatteryStatus, EstimatedChargeRemaining",0,"BatteryStatus EstimatedChargeRemaining\n------------- ------------------------\n            2                       80",""),
  ("Get-CimInstance -ClassName BatteryStaticData -Namespace ROOT\\WMI | Select-Object DesignedCapacity",0,"DesignedCapacity\n----------------\n           52000",""),
  ("Get-CimInstance -ClassName BatteryFullChargedCapacity -Namespace ROOT\\WMI | Select-Object FullChargedCapacity",0,"FullChargedCapacity\n-------------------\n              50100","")],
 True,
 "The battery is healthy - full charge capacity is 50,100 of a designed 52,000, which is barely any wear. Charging deliberately stops at 80% because a vendor battery-conservation mode is enabled. Holding a lithium battery at 100% accelerates ageing, so this setting extends its life.",
 "Leave it on if the laptop is mainly used plugged in - that is what it is for. If you need full runtime for a trip, most vendor utilities offer a temporary full-charge option; look in the manufacturer's power or battery app rather than Windows settings.",
 (True,"it was Lenovo conservation mode, turning it off for travel")),

("power","power management","The screen goes off when I close the lid but the fan keeps running and it gets hot in my bag",
 ["Check what the lid action is set to","Look for anything preventing sleep","Confirm what state the machine actually enters"],
 [("powercfg /q SCHEME_CURRENT SUB_BUTTONS LIDACTION",0,"Current AC Power Setting Index: 0x00000001\nCurrent DC Power Setting Index: 0x00000000",""),
  ("powercfg /requests",0,"SYSTEM:\n[PROCESS] \\Device\\HarddiskVolume3\\Program Files\\BackupAgent\\agent.exe\n\nDISPLAY:\nNone.",""),
  ("powercfg /a",0,"The following sleep states are available on this system:\n    Standby (S0 Low Power Idle)","")],
 True,
 "On battery the lid action is set to Do nothing, so closing the lid only turns off the display. Even if it were set to sleep, a backup agent is holding a system power request that would block it. On a modern standby machine the result is a laptop running at full power inside a closed bag.",
 "Set the lid action to Sleep on both AC and battery, and fix the backup agent's power request - update it or configure it not to hold the system awake. This combination is a genuine overheating risk, not just wasted battery.",
 (True,"was cooking my laptop every day without realising")),

("power","power management","I press a key to wake it up and nothing happens - I have to hold the power button",
 ["Check what is permitted to wake the machine","Confirm the last wake source","Identify why input does not wake it"],
 [("powercfg /devicequery wake_armed",0,"NONE",""),
  ("powercfg /lastwake",0,"Wake History Count - 1\nWake History [0]\n  Wake Source Count - 1\n  Wake Source [0]\n    Type: Power Button",""),
  ("Get-PnpDevice -Class Keyboard | Select-Object Status, FriendlyName",0,"Status FriendlyName\n------ ------------\nOK     HID Keyboard Device",""),
  ("powercfg /a",0,"Standby (S3)\nHibernate","")],
 True,
 "No device is armed to wake the machine at all - the wake_armed list is empty. The keyboard is healthy, but its wake capability has been disabled, so the power button is the only remaining wake source. That matches the wake history showing only power-button wakes.",
 "Enable 'Allow this device to wake the computer' on the keyboard and mouse in Device Manager's Power Management tab. This often gets disabled by power-saving tools or after a driver update.",
 (True,"keyboard wake was unticked, works with a keypress now")),

("power","power management","Hibernate has disappeared from the shutdown menu",
 ["Check whether hibernation is enabled at system level","Confirm the hibernation file exists","Re-enable if appropriate"],
 [("powercfg /a",0,"The following sleep states are available on this system:\n    Standby (S3)\n\nThe following sleep states are not available on this system:\n    Hibernate\n        Hibernation has not been enabled.",""),
  ("Test-Path C:\\hiberfil.sys",1,"","False"),
  ("Get-Volume -DriveLetter C | Select-Object @{N='FreeGB';E={[int]($_.SizeRemaining/1GB)}}",0,"FreeGB\n------\n    64","")],
 True,
 "Hibernation is switched off at system level and the hibernation file has been removed - which is why the option vanished from the menu rather than being greyed out. This is usually done deliberately to reclaim disk space, since hiberfil.sys is sized against installed RAM.",
 "Run 'powercfg /h on' from an elevated prompt to restore it, then tick Hibernate under Power Options > Choose what the power buttons do. It will consume roughly 40% of your RAM size in disk space; with 64 GB free that is not a concern here.",
 (True,"someone had turned it off to save space, back now")),

("power","power management","My PC wakes up in the middle of the night by itself",
 ["Find what woke it","Check for scheduled wake timers","Decide whether to permit or block it"],
 [("powercfg /lastwake",0,"Wake History Count - 1\nWake History [0]\n  Wake Source Count - 1\n  Wake Source [0]\n    Type: Wake Timer\n    Owner: [SERVICE] \\Device\\HarddiskVolume3\\Windows\\System32\\svchost.exe (SystemEventsBroker)\n    Owner Supplied Reason: Windows will execute 'NT TASK\\Microsoft\\Windows\\UpdateOrchestrator\\Reboot'",""),
  ("powercfg /waketimers",0,"Timer set by [SERVICE] ... UpdateOrchestrator\\Reboot expires at 3:00:00 AM",""),
  ("Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\UpdateOrchestrator\\' | Select-Object TaskName, State",0,"TaskName State\n-------- -----\nReboot   Ready","")],
 True,
 "Windows Update sets a wake timer so it can install updates and restart at 03:00. This is deliberate behaviour, not a fault - the machine wakes, does its work, and goes back to sleep or restarts depending on what is pending.",
 "If you would rather it did not, disable 'Allow wake timers' in the active power plan's sleep settings and widen your active hours so updates install while you are using the machine. Blocking wake timers means updates wait for you to be at the keyboard.",
 (True,"turned off wake timers, updates can wait until I'm using it")),

("performance","processes","Fan spins up loudly for a few minutes every time I sit down at the PC in the morning",
 ["Identify what runs shortly after logon","Check whether it is scheduled or triggered","Decide whether it is expected"],
 [("Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\Windows Defender\\' | Get-ScheduledTaskInfo | Select-Object TaskName, LastRunTime, LastTaskResult",0,"TaskName                        LastRunTime          LastTaskResult\n--------                        -----------          --------------\nWindows Defender Scheduled Scan 8/14/2026 8:44:02 AM              0",""),
  ("Get-Process | Sort-Object CPU -Descending | Select-Object -First 3 Name, CPU",0,"Name        CPU\n----        ---\nMsMpEng  1842.6\nchrome    204.1",""),
  ("Get-MpComputerStatus | Select-Object QuickScanStartTime, QuickScanAge",0,"QuickScanStartTime : 8/14/2026 8:44:02 AM\nQuickScanAge       : 0","")],
 True,
 "Defender's scheduled scan is configured to run at idle, and the first idle window it finds each day is shortly after you sign in. The scan is doing exactly what it should - the fan noise is the CPU working, not a fault.",
 "Move the scheduled scan to a fixed time when you are not at the machine, such as lunchtime or overnight if it stays on. Do not disable it; a daily quick scan costs a few minutes of fan noise and is worth keeping.",
 (True,"moved it to 1pm, mornings are quiet now")),

("windows","Windows Update","Windows Update says it failed but doesn't tell me anything useful",
 ["Get the actual error code from the update history","Check the servicing components it depends on","Address the specific failure"],
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WindowsUpdateClient'; Id=20} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"Installation Failure: Windows failed to install the following update with error 0x80070005: 2026-08 Cumulative Update.",""),
  ("Get-Service wuauserv, bits, cryptsvc, msiserver | Select-Object Name, Status",0,"Name      Status\n----      ------\nwuauserv Running\nbits     Running\ncryptsvc Running\nmsiserver Stopped",""),
  ("Get-Acl 'C:\\Windows\\SoftwareDistribution' | Select-Object Owner",0,"Owner\n-----\nNT AUTHORITY\\SYSTEM","")],
 True,
 "The real error is 0x80070005, which is access denied - the update could not write where it needed to. The Windows Installer service is stopped, and the update requires it to service installer-based components.",
 "Start msiserver and set it to Manual, then retry the update. If 0x80070005 returns with all services running, third-party antivirus is usually blocking access to the servicing folders - pause it for the install.",
 (True,"installer service was disabled, update went through after")),

("file","disk health","Windows says my drive has a problem and wants to scan it - should I let it?",
 ["Establish what triggered the prompt","Check the volume and the physical disk separately","Decide whether scanning is safe"],
 [("Get-Volume -DriveLetter D | Select-Object HealthStatus, OperationalStatus",0,"HealthStatus OperationalStatus\n------------ -----------------\nWarning      OK",""),
  ("fsutil dirty query D:",0,"Volume - D: is Dirty",""),
  ("Get-PhysicalDisk | Where-Object DeviceId -eq 1 | Get-StorageReliabilityCounter | Select-Object ReadErrorsTotal, Wear, PowerOnHours",0,"ReadErrorsTotal Wear PowerOnHours\n--------------- ---- ------------\n              0    2        14208",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='disk'} -MaxEvents 3 -ErrorAction SilentlyContinue",1,"","(no disk hardware errors logged)")],
 True,
 "The dirty bit is set, which is what triggers the prompt - it happens after an unclean shutdown while files were open. The underlying hardware is fine: zero read errors, 2% wear, no disk events. This is a file-system consistency check, not a failing drive.",
 "Yes, let it scan - with healthy hardware chkdsk is low risk and clears the flag. The answer would be different on a drive reporting read errors, where scanning can stress failing media; that is why the physical disk was checked before agreeing.",
 (True,"ran the scan, took 10 minutes, warning gone")),

("network","Ethernet","The internet works on my phone but not on the desktop, both on the same network",
 ["Compare the two paths rather than assuming the network is down","Check the desktop's own configuration","Find where it differs"],
 [("Get-NetAdapter | Select-Object Name, Status, LinkSpeed",0,"Name     Status LinkSpeed\n----     ------ ---------\nEthernet Up     100 Mbps",""),
  ("Get-NetIPConfiguration -InterfaceAlias 'Ethernet' | Select-Object IPv4Address, IPv4DefaultGateway, DNSServer",0,"IPv4Address        : 192.168.1.40\nIPv4DefaultGateway : 192.168.1.1\nDNSServer          : 192.168.1.1",""),
  ("Test-NetConnection 192.168.1.1 -InformationLevel Quiet",0,"True",""),
  ("Test-NetConnection 8.8.8.8 -InformationLevel Quiet",1,"","False"),
  ("Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultOutboundAction",0,"Name    Enabled DefaultOutboundAction\n----    ------- ---------------------\nPrivate    True                 Block","")],
 True,
 "Addressing is correct and the router responds, so the local network is fine - which matches the phone working. The desktop's firewall has its default outbound action set to Block on the Private profile, so nothing can leave the machine beyond the local subnet.",
 "Set the outbound default back to Allow for the Private profile. Blocking outbound by default is a deliberate hardening choice that requires an allow rule for every application - it is almost certainly not what was intended here.",
 (True,"a 'security' tool had set that, reverted it")),
]

with open(JSON_PATH, encoding="utf-8") as f: data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f: jsonl_lines = [l for l in f if l.strip()]
existing = {d["goal"] for d in data}
prefix = collections.defaultdict(list)
for g in existing: prefix[' '.join(g.lower().split()[:4])].append(g)

base = datetime(2026, 8, 15, 9, 0, 0)
added = skipped = 0; near = []
for i, (dom, sub, goal, plan, cmds, resolved, summary, rec, fb) in enumerate(NEW):
    if goal in existing: skipped += 1; continue
    k = ' '.join(goal.lower().split()[:4])
    if k in prefix: near.append((goal, prefix[k][0]))
    created = base + timedelta(minutes=8*i)
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
print(f"added: {added} | dups skipped: {skipped} | prefix collisions: {len(near)}")
for a,b in near: print("  NEAR:", a[:50], "<>", b[:50])
print("Total:", len(data))
