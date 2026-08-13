import json, collections
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

NEW = [
# ================= EXCEL =================
("excel","Excel recalculates very slowly and freezes on every cell edit",
 "The workbook is full of volatile functions (INDIRECT/OFFSET/TODAY/RAND) that force a full recalculation of every dependent formula on any edit, so the slowness scales with sheet size rather than being an Excel fault.",
 [("Get-Process EXCEL -ErrorAction SilentlyContinue | Select-Object Name, @{N='MB';E={[int]($_.WorkingSet64/1MB)}}",0,"EXCEL  2140",""),
  ("Get-Item 'C:\\Reports\\Model.xlsx' | Select-Object Length, LastWriteTime",0,"Length : 48210944","")],
 "Replace volatile functions with INDEX/MATCH and static dates, set Formulas > Calculation Options to Manual while editing, and split very large models; Excel is single-threaded for dependency chains, so structure matters more than CPU."),
("excel","An Excel file has grown to hundreds of MB with only a few thousand rows of data",
 "The used range extends far beyond the real data because formatting was applied to entire columns, so Excel stores millions of formatted-but-empty cells in the file.",
 [("Get-Item 'C:\\Reports\\Tracker.xlsx' | Select-Object @{N='MB';E={[math]::Round($_.Length/1MB,1)}}",0,"MB : 284.6","")],
 "Press Ctrl+End to see the true used range; delete all rows/columns beyond the data, remove whole-column formatting, save, and reopen. Also check for hidden sheets and unused named ranges/styles."),
("excel","Excel formulas display as text instead of calculating",
 "The cells were formatted as Text before the formula was typed, so Excel stores the entry literally; alternatively 'Show Formulas' view is toggled on for the whole sheet.",
 [("Get-Item 'C:\\Reports\\Calc.xlsx' | Select-Object Name, Length",0,"Calc.xlsx  184320","")],
 "Set the cells back to General, then re-enter the formulas (F2 then Enter forces re-evaluation); if every formula on the sheet shows, press Ctrl+` to turn off Show Formulas."),
("excel","Excel shows 'file is locked for editing by another user' when nobody has it open",
 "A stale owner file (~$filename.xlsx) was left behind after a crash or a dropped network connection, and Excel honors it as an active lock.",
 [("Get-ChildItem '\\\\fileserver\\share' -Filter '~$*.xlsx' -Force -ErrorAction SilentlyContinue | Select-Object Name, LastWriteTime",0,"~$Budget.xlsx  8/2/2026 09:14",""),
  ("Get-SmbOpenFile -ErrorAction SilentlyContinue | Where-Object Path -like '*Budget*' | Select-Object ClientUserName, Path",0,"(no open handles on the server)","")],
 "Confirm no live handle exists on the file server, then delete the hidden ~$ owner file; if it recurs frequently, investigate network drops between clients and the share."),
("excel","Power Query refresh fails with a credentials error after a password change",
 "The query's data source credentials are cached per-user in Excel's own credential store, which still holds the old password -- the Windows credential change doesn't propagate to it.",
 [("Get-ChildItem \"$env:LOCALAPPDATA\\Microsoft\\Office\\16.0\\PowerQuery\" -ErrorAction SilentlyContinue | Select-Object Name",0,"Credentials (cached data source entries)","")],
 "Clear the source in Data > Get Data > Data Source Settings > Edit Permissions > Clear Permissions, then refresh and re-enter the current credentials."),
("excel","Excel macros are blocked with 'Microsoft has blocked macros from running'",
 "The workbook came from the internet or a network share, so it carries the Mark of the Web; Excel blocks VBA in such files by policy regardless of the Trust Center macro setting.",
 [("Get-Item 'C:\\Downloads\\Report.xlsm' -Stream Zone.Identifier -ErrorAction SilentlyContinue | Select-Object Stream, Length",0,"Zone.Identifier  26","")],
 "If the source is trusted, right-click > Properties > Unblock (or 'Unblock-File'); for organizational files, put the folder in a Trusted Location instead of unblocking each file individually."),
("excel","CSV files open with all data crammed into one column",
 "Excel splits CSVs using the Windows regional list separator, and this system's separator is a semicolon while the file uses commas -- so no split occurs.",
 [("Get-Culture | Select-Object Name, @{N='ListSep';E={$_.TextInfo.ListSeparator}}",0,"Name: de-DE  ListSep: ;",""),
  ("Get-Content 'C:\\Data\\export.csv' -TotalCount 1",0,"id,name,amount","")],
 "Use Data > From Text/CSV (which lets you pick the delimiter) instead of double-clicking, or change the list separator in Region settings; never rely on double-click CSV behavior across different locales."),
("excel","Numbers imported from a system appear as text and won't sum",
 "The values carry leading apostrophes or non-breaking spaces from the source system, so Excel stores them as text and arithmetic ignores them.",
 [("Get-Content 'C:\\Data\\amounts.csv' -TotalCount 3",0,"amount\n\u00a01,234.00\n\u00a02,500.00","")],
 "Use Data > Text to Columns (finish with the correct locale) or VALUE(SUBSTITUTE(cell,CHAR(160),\"\")) to strip the non-breaking spaces; the green triangle indicator marks affected cells."),
("excel","Excel crashes when opening any file after an update",
 "A COM add-in that hasn't been updated for the new Office build fails during load, taking Excel down before the workbook renders.",
 [("Get-ChildItem 'HKCU:\\Software\\Microsoft\\Office\\Excel\\Addins' | Select-Object PSChildName",0,"AnalyticsAddIn.Connect\nVendorTools.Addin",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"Faulting application EXCEL.EXE, faulting module AnalyticsAddIn.dll","")],
 "Start Excel with 'excel /safe' to confirm, then disable the faulting add-in under File > Options > Add-ins > COM Add-ins and get an updated version from the vendor."),
("excel","An Excel add-in disappears from the ribbon after a crash",
 "Office moved the add-in to the Disabled Items list after it caused a hang, which is a protective mechanism -- the add-in is still installed but deliberately not loaded.",
 [("Get-ChildItem 'HKCU:\\Software\\Microsoft\\Office\\16.0\\Excel\\Resiliency\\DisabledItems' -ErrorAction SilentlyContinue | Select-Object Name",0,"DisabledItems key present with entries","")],
 "Re-enable via File > Options > Add-ins > Manage: Disabled Items > Enable; if it keeps getting disabled, the add-in genuinely hangs and needs a vendor update rather than repeated re-enabling."),
("excel","32-bit Excel runs out of memory on large workbooks while the PC has plenty of RAM",
 "32-bit Office is limited to roughly 2 GB of addressable memory per process regardless of installed RAM, so large models hit the ceiling well before the machine does.",
 [("Get-CimInstance Win32_OperatingSystem | Select-Object @{N='TotalGB';E={[math]::Round($_.TotalVisibleMemorySize/1MB,1)}}",0,"TotalGB : 31.9",""),
  ("Get-Process EXCEL | Select-Object @{N='MB';E={[int]($_.WorkingSet64/1MB)}}",0,"MB : 1980 (near the 32-bit ceiling)","")],
 "Migrate to 64-bit Office (requires uninstalling 32-bit first and checking add-in compatibility), or reduce the model's footprint with Power Pivot/data model instead of raw sheets."),
("excel","External workbook links show #REF! and won't update",
 "The linked source workbook was moved or renamed, so the stored path no longer resolves and Excel returns #REF! rather than stale values.",
 [("Test-Path 'C:\\Shared\\SourceData.xlsx'",0,"False",""),
  ("Get-ChildItem 'C:\\Shared' -Filter '*.xlsx' | Select-Object Name",0,"SourceData_v2.xlsx","")],
 "Use Data > Edit Links > Change Source to point at the renamed file; for shared models, keep sources on a stable UNC path so links survive folder reorganizations."),
# ================= WORD =================
("word","Word starts slowly and behaves oddly -- suspect Normal.dotm corruption",
 "The global template Normal.dotm accumulates macros, styles and settings, and a corrupted copy causes slow starts and inconsistent formatting across every document.",
 [("Get-Item \"$env:APPDATA\\Microsoft\\Templates\\Normal.dotm\" | Select-Object Length, LastWriteTime",0,"Length : 8421376  LastWriteTime : 8/1/2026","")],
 "Close Word and rename Normal.dotm to Normal.old -- Word rebuilds a clean default. You lose custom styles/macros stored there, so keep a copy if any were intentional."),
("word","A Word document is 'locked for editing' by yourself",
 "A previous WINWORD process still holds the file open (often after a crash), so the owner file remains and Word treats your own stale session as another user.",
 [("Get-Process WINWORD -ErrorAction SilentlyContinue | Select-Object Id, StartTime, Responding",0,"Id 6120  StartTime 08:41  Responding False",""),
  ("Get-ChildItem 'C:\\Docs' -Filter '~$*.docx' -Force | Select-Object Name",0,"~$Contract.docx","")],
 "End the stale WINWORD process, delete the hidden ~$ owner file, then reopen; if Word frequently leaves orphaned processes, disable the preview handler for Word files in Explorer."),
("word","Spell check does nothing in one document but works in others",
 "The text is marked with the 'Do not check spelling or grammar' language attribute, so the proofing engine skips it by design rather than being broken.",
 [("Get-Item 'C:\\Docs\\Report.docx' | Select-Object Name, Length",0,"Report.docx  248320","")],
 "Select all (Ctrl+A) > Review > Language > Set Proofing Language, uncheck 'Do not check spelling or grammar', and set the correct language; content pasted from web pages commonly carries this flag."),
("word","Fonts look different when a document is opened on another machine",
 "The document uses fonts that aren't installed on the second machine and weren't embedded, so Word substitutes metrically similar alternatives and layout shifts.",
 [("Get-ChildItem C:\\Windows\\Fonts -Filter 'Calibri*' | Select-Object Name",0,"calibri.ttf, calibrib.ttf",""),
  ("Get-ChildItem C:\\Windows\\Fonts -Filter 'Gotham*' -ErrorAction SilentlyContinue | Measure-Object",0,"Count : 0","")],
 "Embed the fonts in the file (File > Options > Save > Embed fonts in the file) if licensing allows, distribute as PDF for fixed layout, or standardize on fonts present in every Office install."),
("word","Mail merge to email silently sends nothing",
 "Mail merge to email requires Outlook to be the default MAPI client and running; with a non-MAPI default mail app, Word completes the merge but no messages are handed off.",
 [("Get-ItemProperty 'HKCU:\\Software\\Clients\\Mail' -Name '(default)' -ErrorAction SilentlyContinue",0,"(default) : Mail (Windows Mail app)",""),
  ("Get-Process OUTLOOK -ErrorAction SilentlyContinue | Measure-Object",0,"Count : 0","")],
 "Set Outlook as the default mail client, open it before running the merge, and use a valid email-address column; also check the Outbox for messages held by a large-batch throttling rule."),
("word","Track Changes keeps re-enabling itself for every document",
 "Track Changes is saved in the template (Normal.dotm) rather than per-document, so every new document inherits the enabled state.",
 [("Get-Item \"$env:APPDATA\\Microsoft\\Templates\\Normal.dotm\" | Select-Object LastWriteTime",0,"LastWriteTime : 8/3/2026","")],
 "Open a blank document, turn Track Changes off, then save Normal.dotm; also check whether the document is protected with 'Tracked changes' enforcement (Review > Restrict Editing), which cannot be turned off without the password."),
("word","A Word document won't open -- 'The file appears to be corrupted'",
 "The .docx is a ZIP container and its central directory is damaged, so Word can't read the package; the underlying document.xml may still be extractable.",
 [("Get-Item 'C:\\Docs\\Thesis.docx' | Select-Object Length",0,"Length : 1284096",""),
  ("Copy-Item 'C:\\Docs\\Thesis.docx' 'C:\\Temp\\Thesis.zip'",0,"","")],
 "Try Word's Open > Open and Repair first; if that fails, rename to .zip and extract word/document.xml, or restore from OneDrive version history/File History which is usually faster than salvage attempts."),
# ================= OUTLOOK =================
("outlook","Outlook takes minutes to start but runs fine once open",
 "Multiple COM add-ins load synchronously at startup, and Outlook's own diagnostics record the load time for each -- the total explains the delay while runtime performance stays normal.",
 [("Get-ChildItem 'HKCU:\\Software\\Microsoft\\Office\\Outlook\\Addins' | Select-Object PSChildName",0,"6 add-ins registered",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Office\\16.0\\Outlook\\AddInLoadTimes' -ErrorAction SilentlyContinue",0,"(per-add-in load durations recorded)","")],
 "Check File > Slow and Disabled Add-ins, disable the slowest ones you don't need, and keep the rest updated; Outlook itself disables add-ins exceeding the load-time threshold automatically."),
("outlook","Outlook rules stop running and new rules can't be created",
 "The mailbox has hit the server-side rules quota (32 KB by default, up to 256 KB), so Exchange refuses to store additional rules and existing ones can stop processing.",
 [("Get-InboxRule -Mailbox jdoe@corp.com | Measure-Object | Select-Object Count",0,"Count : 47","")],
 "Delete unused rules and shorten long rule names/conditions (which consume the quota), or ask an Exchange admin to raise RulesQuota; consolidating similar rules recovers the most space."),
("outlook","Some Outlook rules only work when Outlook is open",
 "Those rules are client-only (they use actions Exchange can't perform server-side, like running a script or moving to a PST), so they execute only while the client is running.",
 [("Get-InboxRule -Mailbox jdoe@corp.com | Select-Object Name, Enabled, Description | Select-Object -First 3",0,"Name: FileToArchive  Description: move to PST (client-only)","")],
 "Change the target to a server-side mailbox folder instead of a PST and avoid client-only actions, so Exchange can run the rule regardless of whether Outlook is open."),
("outlook","Free/busy information shows as hashed lines for everyone",
 "The client can't reach the Availability service endpoint, so Outlook has no free/busy data to render and falls back to the 'no information' hatch pattern.",
 [("Test-NetConnection outlook.office365.com -Port 443",0,"TcpTestSucceeded : True",""),
  ("Test-NetConnection autodiscover.corp.com -Port 443",1,"","TcpTestSucceeded : False")],
 "Fix Autodiscover reachability -- the Availability service is located through it, which is why free/busy fails while mail flow (already-configured) continues to work."),
("outlook","Outlook send/receive fails with error 0x8004010F 'The operation failed. An object cannot be found'",
 "0x8004010F is an Offline Address Book download failure; the OAB folder in the local profile is corrupted or the OAB URL is unreachable, so the download step errors while mail continues to flow.",
 [("Get-ChildItem \"$env:LOCALAPPDATA\\Microsoft\\Outlook\\Offline Address Books\" -ErrorAction SilentlyContinue | Measure-Object",0,"Count : 3","")],
 "Close Outlook, delete the Offline Address Books folder so it re-downloads, then Send/Receive > Download Address Book; if it recurs, verify the OAB virtual directory on the Exchange side."),
("outlook","Outlook can't send mail -- error 0x800CCC0E with an IMAP/POP account",
 "0x800CCC0E is an SMTP connection failure; the configured outgoing port is blocked, and the ISP requires the submission port with TLS instead of the legacy port.",
 [("Test-NetConnection smtp.mailprovider.com -Port 25",1,"","TcpTestSucceeded : False"),
  ("Test-NetConnection smtp.mailprovider.com -Port 587",0,"TcpTestSucceeded : True","")],
 "Change the outgoing server to port 587 with STARTTLS and authentication enabled; most ISPs and hosts block outbound port 25 to limit spam relaying."),
("outlook","A PST file has stopped accepting new mail",
 "The PST reached its configured maximum size; ANSI-format PSTs cap near 2 GB, and Unicode PSTs have a configurable limit that policy may have set low.",
 [("Get-ChildItem \"$env:LOCALAPPDATA\\Microsoft\\Outlook\" -Filter '*.pst' | Select-Object Name, @{N='GB';E={[math]::Round($_.Length/1GB,2)}}",0,"Archive.pst  1.99",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Policies\\Microsoft\\Office\\16.0\\Outlook\\PST' -Name MaxLargeFileSize -ErrorAction SilentlyContinue",0,"(not set - ANSI format limit applies)","")],
 "Create a new Unicode PST and move items into it (ANSI PSTs cannot be converted in place), and archive older mail to keep individual files well under the limit for performance."),
("outlook","Outlook calendar items disappear or duplicate after using multiple devices",
 "Two clients are applying conflicting changes to the same items and Exchange keeps both resolutions, producing duplicates -- commonly an old ActiveSync device plus a desktop client.",
 [("Get-MobileDeviceStatistics -Mailbox jdoe@corp.com -ErrorAction SilentlyContinue | Select-Object DeviceModel, LastSuccessSync",0,"OldPhone  LastSuccessSync 2024-03-11","")],
 "Remove stale device partnerships from the mailbox, keep one authoritative client for calendar edits, and use the built-in Clean Up tool for the duplicates that already exist."),
("outlook","Outlook profile is corrupted -- repeated crashes only for one user on a shared PC",
 "The failure follows the user's Outlook profile rather than the machine, and their profile registry subtree contains inconsistent account entries after a migration.",
 [("Get-ChildItem 'HKCU:\\Software\\Microsoft\\Office\\16.0\\Outlook\\Profiles' | Select-Object PSChildName",0,"Outlook\nOutlook_old",""),
  ("Get-Process OUTLOOK -ErrorAction SilentlyContinue | Select-Object Responding",0,"(crashes at startup)","")],
 "Create a fresh Outlook profile (Control Panel > Mail > Show Profiles > Add) and set it as default; server-hosted mail re-downloads, so only local PSTs need re-attaching."),
("outlook","Attachments are blocked -- 'Outlook blocked access to the following potentially unsafe attachments'",
 "Outlook's Level 1 attachment blocking hides certain file types unconditionally, which is a security feature rather than a fault or a policy misconfiguration.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Office\\16.0\\Outlook\\Security' -Name Level1Remove -ErrorAction SilentlyContinue",1,"","(value not set - defaults apply)")],
 "Ask the sender to place the file in OneDrive/SharePoint and share a link, or to send it inside a password-protected archive; loosening Level1Remove weakens a broadly effective protection and is not recommended."),
("outlook","Email signature doesn't apply to replies, only to new messages",
 "Signatures are configured separately for new messages and for replies/forwards, and the replies slot was left as 'none'.",
 [("Get-ChildItem \"$env:APPDATA\\Microsoft\\Signatures\" -ErrorAction SilentlyContinue | Select-Object Name",0,"Corporate.htm  Corporate.rtf  Corporate.txt","")],
 "Set the signature for 'Replies/forwards' in File > Options > Mail > Signatures; for organization-wide consistency, apply a server-side transport rule disclaimer instead of per-client signatures."),
("outlook","Meeting invitations go straight to Deleted Items",
 "A rule or the calendar auto-processing setting is deleting invitations after processing them, so they are handled but not left in the Inbox.",
 [("Get-InboxRule -Mailbox jdoe@corp.com | Where-Object {$_.DeleteMessage -eq $true} | Select-Object Name",0,"Name : ProcessInvites",""),
  ("Get-CalendarProcessing -Identity jdoe@corp.com -ErrorAction SilentlyContinue | Select-Object AutomateProcessing",0,"AutomateProcessing : AutoUpdate","")],
 "Disable or correct the deleting rule; AutoUpdate processing on a user mailbox is normal and updates the calendar, but it should not delete the original invitation."),
# ================= TEAMS =================
("teams","Teams uses very high memory and slows the whole machine",
 "Teams is an Electron application that keeps each open chat, channel and call surface in memory; long uninterrupted sessions accumulate usage until it's restarted.",
 [("Get-Process ms-teams,Teams -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum | Select-Object @{N='TotalMB';E={[int]($_.Sum/1MB)}}",0,"TotalMB : 3120","")],
 "Restart Teams periodically, enable the setting to disable GPU hardware acceleration if the renderer is heavy, and prefer the new Teams client which uses substantially less memory than classic."),
("teams","Teams screen sharing shows a black screen to participants",
 "The capture path fails when hardware acceleration interacts with a discrete GPU on hybrid graphics, so Teams captures nothing while the meeting itself works normally.",
 [("Get-CimInstance Win32_VideoController | Select-Object Name, Status",0,"Intel UHD  OK\nNVIDIA RTX 3050  OK","")],
 "Disable GPU hardware acceleration in Teams settings and restart it, update the graphics driver, and set Teams to 'High performance' GPU in Windows Graphics settings so capture and render use the same adapter."),
("teams","Teams notifications never appear on the desktop",
 "Windows Focus Assist or the per-app notification permission is blocking them, so Teams generates the notification and Windows suppresses it before display.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\MSTeams_8wekyb3d8bbwe!MSTeams' -Name Enabled -ErrorAction SilentlyContinue",0,"Enabled : 0","")],
 "Enable Teams under Settings > System > Notifications, turn off Do not disturb, and set Teams' own notification style to 'Windows' rather than built-in so the OS handles delivery."),
("teams","Teams keeps signing out or asking for credentials repeatedly",
 "The cached authentication tokens in the Teams identity cache are corrupted, so each session obtains a token that fails validation on next launch.",
 [("Get-ChildItem \"$env:LOCALAPPDATA\\Packages\\MSTeams_8wekyb3d8bbwe\\LocalCache\" -ErrorAction SilentlyContinue | Measure-Object",0,"Count : 12",""),
  ("cmdkey /list | Select-String 'MicrosoftOffice'",0,"Target: MicrosoftOffice16_Data:live.com:...","")],
 "Sign out fully, clear the Teams cache folder and the related Credential Manager entries, then sign in once; if it persists across users, check Conditional Access policies forcing frequent reauthentication."),
# ================= ONEDRIVE / SHAREPOINT =================
("onedrive","OneDrive sync fails for some files with 'path too long'",
 "The combined local path exceeds the sync client's limit once the OneDrive root and SharePoint library structure are added, so those specific files never sync.",
 [("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue",0,"LongPathsEnabled : 0","')")],
 "Shorten folder names, sync a deeper subfolder instead of the whole library, and enable LongPathsEnabled; SharePoint also enforces its own URL length limit independent of Windows."),
("onedrive","SharePoint library sync becomes very slow with a large library",
 "The library exceeds the recommended synced-item count, and the sync client's per-item overhead dominates -- it is a scale limit rather than a bandwidth problem.",
 [("Get-ChildItem \"$env:USERPROFILE\\Company\\Shared Documents\" -Recurse -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count : 312450","")],
 "Sync only the subfolders actually needed, use Files On-Demand so content isn't downloaded, and keep synced libraries within Microsoft's supported item counts; very large libraries should be browsed rather than synced."),
("onedrive","Personal and work OneDrive accounts conflict on the same PC",
 "Both accounts are configured and both attempt Known Folder Move for Desktop/Documents, so folder redirection ownership flips between them.",
 [("Get-ChildItem \"$env:USERPROFILE\" -Directory | Where-Object Name -like 'OneDrive*' | Select-Object Name",0,"OneDrive - Personal\nOneDrive - Contoso","')")],
 "Allow only one account to manage Known Folder Move (normally the work account), and keep personal files in the personal OneDrive folder rather than under redirected folders."),
# ================= OFFICE GENERAL =================
("office","Office apps fail to start with error 0xc0000142",
 "0xc0000142 means a required DLL failed to initialize during process startup -- here a mismatched Office component after an interrupted Click-to-Run update.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"Faulting application WINWORD.EXE, exception code 0xc0000142",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration' -Name VersionToReport -ErrorAction SilentlyContinue",0,"VersionToReport : 16.0.17328.20124","")],
 "Run an Online Repair from Apps > Microsoft 365 > Modify (a Quick Repair is usually insufficient for 0xc0000142), and ensure no update is in progress while repairing."),
("office","Office updates fail and the version never changes",
 "The Click-to-Run service is stopped, so the update engine can neither download nor apply updates while the apps themselves continue to run on the installed build.",
 [("Get-Service ClickToRunSvc | Select-Object Status, StartType",0,"Status : Stopped  StartType : Disabled",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration' -Name UpdatesEnabled -ErrorAction SilentlyContinue",0,"UpdatesEnabled : False","")],
 "Set ClickToRunSvc to Automatic and start it, and set UpdatesEnabled back to True (or fix the managing policy); the service being disabled is usually a leftover from a manual 'stop updates' tweak."),
("office","Every Office file opens in Protected View and editing requires an extra click",
 "The files come from an internet or network location, and Protected View is applying to those origins by design as a sandbox against malicious documents.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Office\\16.0\\Word\\Security\\ProtectedView' -ErrorAction SilentlyContinue | Select-Object DisableInternetFilesInPV, DisableUnsafeLocationsInPV",0,"(defaults - Protected View enabled)","")],
 "Add the specific internal file share as a Trusted Location rather than disabling Protected View globally; Protected View is one of Office's strongest defenses against document-based attacks."),
("office","Office asks to activate on every launch for a specific user only",
 "The user's Office identity/licensing tokens are corrupted in their profile, so activation succeeds at runtime but isn't persisted between sessions.",
 [("Get-ChildItem \"$env:LOCALAPPDATA\\Microsoft\\Office\\16.0\\Licensing\" -ErrorAction SilentlyContinue | Measure-Object",0,"Count : 38",""),
  ("cmdkey /list | Select-String 'MicrosoftOffice'",0,"Target: MicrosoftOffice16_Data:...","")],
 "Sign out of Office, clear the Licensing folder and the MicrosoftOffice credentials in Credential Manager, then sign in once; for shared machines consider Shared Computer Activation licensing."),
("office","A COM add-in keeps disabling itself across all Office apps",
 "Office's resiliency mechanism disabled it after repeated crashes, and the LoadBehavior value was reset accordingly -- re-enabling in the UI doesn't survive the next crash.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Office\\Word\\Addins\\Vendor.Addin' -Name LoadBehavior -ErrorAction SilentlyContinue",0,"LoadBehavior : 2","")],
 "LoadBehavior 2 means 'loaded at startup but currently disabled'. Setting it to 3 re-enables it, but the underlying crash must be fixed by the vendor or the resiliency logic will disable it again."),
("office","Data connections in Office files fail with an ODBC driver error",
 "The workbook was authored against a 32-bit ODBC driver, and 64-bit Office looks in the 64-bit ODBC registry hive where no matching DSN exists.",
 [("Get-OdbcDsn -ErrorAction SilentlyContinue | Select-Object Name, Platform, DriverName",0,"SalesDB  32-bit  SQL Server",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration' -Name Platform -ErrorAction SilentlyContinue",0,"Platform : x64","")],
 "Create a matching 64-bit DSN (odbcad32.exe from System32, not SysWOW64) with the same name, or install the 64-bit driver; DSN name alone doesn't bridge the bitness gap."),
("office","Office documents on a network share open extremely slowly",
 "Each open performs multiple metadata round trips to the share, and the WAN latency multiplies them -- throughput is fine, per-operation latency is the constraint.",
 [("Test-NetConnection fileserver -Port 445 -InformationLevel Detailed",0,"RoundtripTime : 62 ms",""),
  ("Get-SmbClientConfiguration | Select-Object DirectoryCacheLifetime, FileInfoCacheLifetime",0,"DirectoryCacheLifetime : 10  FileInfoCacheLifetime : 10","")],
 "Move the working set to OneDrive/SharePoint sync (local copies with background sync) or a local DFS replica; increasing SMB cache lifetimes helps marginally but cannot overcome 60 ms RTT for chatty operations."),
("office","Shared workbook co-authoring is unavailable and users get read-only copies",
 "Co-authoring requires the file to be stored in OneDrive/SharePoint and saved in the modern format; a file on a classic file share or in legacy .xls format can only be opened exclusively.",
 [("Get-Item '\\\\fileserver\\finance\\Budget.xls' | Select-Object Name, Extension",0,"Budget.xls  .xls","")],
 "Convert to .xlsx and move the file to a SharePoint/OneDrive library with AutoSave enabled; SMB file shares fundamentally cannot support co-authoring regardless of Office version."),
("office","Office telemetry/diagnostic prompts keep appearing for users",
 "The diagnostic data level isn't configured by policy, so Office prompts each user to choose -- a first-run experience rather than an error.",
 [("Get-ItemProperty 'HKCU:\\Software\\Policies\\Microsoft\\office\\16.0\\common\\privacy' -Name disconnectedstate -ErrorAction SilentlyContinue",1,"","(policy not configured)")],
 "Configure the Office privacy settings via Group Policy/Intune (diagnostic data level and connected experiences) so the prompt is answered centrally and consistently for all users."),
("office","Word/Excel hang when printing to a specific network printer",
 "Office queries the printer driver for capabilities at print time, and this driver blocks on an unreachable print server, so the app appears frozen while it waits.",
 [("Get-Printer | Where-Object Name -like '*Floor3*' | Select-Object Name, PrinterStatus, PortName",0,"Floor3-HP  Error  \\\\printsrv\\Floor3-HP",""),
  ("Test-NetConnection printsrv -Port 445",1,"","TcpTestSucceeded : False")],
 "Remove or repoint the unreachable printer and set a reachable default; Office querying an offline print server is a very common cause of app-wide hangs that look like Office faults."),
("office","Office apps show 'The Office Subscription could not be verified' on a metered/offline machine",
 "Subscription licenses need periodic online verification; this machine has been offline past the grace period, so Office moves to reduced-functionality mode until it can check in.",
 [("Test-NetConnection licensing.mp.microsoft.com -Port 443",1,"","TcpTestSucceeded : False"),
  ("Get-CimInstance SoftwareLicensingProduct -Filter \"Name LIKE 'Office%'\" -ErrorAction SilentlyContinue | Select-Object Name, LicenseStatus",0,"(Office C2R licensing is not exposed here)","")],
 "Connect the machine to the internet so Office can re-verify (roughly every 30 days), or move permanently-offline machines to a perpetual/volume-licensed Office edition instead of subscription."),
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
base_time = datetime(2026, 8, 5, 9, 0, 0); i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goals: skipped.append(goal); continue
    key = ' '.join(goal.lower().split()[:4])
    if key in prefix_index: near.append((goal, prefix_index[key][0]))
    created = base_time + timedelta(minutes=5*i); i += 1
    steps = [{"command": c, "blocked": False, "exitCode": ec, "stdout": o, "stderr": e, "reason": None} for c, ec, o, e in commands]
    data.append({
        "id": next_id(), "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal, "domain": domain,
        "plan": ["Reproduce and scope the Office issue with read-only checks",
                 "Separate an Office fault from a Windows, network or licensing cause",
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

print(f"Added: {i} | exact dups: {len(skipped)} | near collisions: {len(near)}")
for a,b in near: print("   NEAR:", a[:58], "<>", b[:58])
print("Total JSON:", len(data), "| Total JSONL:", len(jsonl_lines))
ids=[d["id"] for d in data]; assert len(ids)==len(set(ids))
goals=[d["goal"] for d in data]; assert len(goals)==len(set(goals))
users=[json.loads(l)["messages"][1]["content"] for l in jsonl_lines]
assert len(users)==len(set(users)) and set(users)==set(goals)
print("Validation passed")
import collections as C
print("\nOffice-family domains now:")
for k,v in C.Counter(d['domain'] for d in data).most_common():
    if k in ('office','excel','word','outlook','teams','onedrive','email','exchange'): print(f"  {k}: {v}")
