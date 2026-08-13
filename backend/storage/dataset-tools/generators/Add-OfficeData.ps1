<#
.SYNOPSIS
    Adds 48 Microsoft Office / Excel / Word / Outlook / Teams / OneDrive
    troubleshooting scenarios to the Windows repair dataset.

.DESCRIPTION
    Run this in the folder containing repair-dataset.jsonl (and optionally
    repair-sessions.json). It appends the new scenarios, skips duplicates,
    validates, and writes the files back. Backups are made first.

.EXAMPLE
    cd D:\data1
    .\Add-OfficeData.ps1
#>
[CmdletBinding()]
param(
    [string]$JsonlPath = ".\repair-dataset.jsonl",
    [string]$JsonPath  = ".\repair-sessions.json"
)

$ErrorActionPreference = 'Stop'

# domain | goal | summary | commands(cmd,exit,stdout,stderr) | recommendation
$NEW = @(
 @{d='excel'; g='Excel recalculates very slowly and freezes on every cell edit';
   s='The workbook is full of volatile functions (INDIRECT/OFFSET/TODAY/RAND) that force a full recalculation of every dependent formula on any edit, so the slowness scales with sheet size rather than being an Excel fault.';
   c=@(@('Get-Process EXCEL -ErrorAction SilentlyContinue | Select-Object Name, @{N=''MB'';E={[int]($_.WorkingSet64/1MB)}}',0,'EXCEL  2140',''),
       @('Get-Item ''C:\Reports\Model.xlsx'' | Select-Object Length, LastWriteTime',0,'Length : 48210944',''));
   r='Replace volatile functions with INDEX/MATCH and static dates, set Formulas > Calculation Options to Manual while editing, and split very large models; Excel is single-threaded for dependency chains, so structure matters more than CPU.'}
 @{d='excel'; g='An Excel file has grown to hundreds of MB with only a few thousand rows of data';
   s='The used range extends far beyond the real data because formatting was applied to entire columns, so Excel stores millions of formatted-but-empty cells in the file.';
   c=@(@('Get-Item ''C:\Reports\Tracker.xlsx'' | Select-Object @{N=''MB'';E={[math]::Round($_.Length/1MB,1)}}',0,'MB : 284.6',''));
   r='Press Ctrl+End to see the true used range; delete all rows/columns beyond the data, remove whole-column formatting, save, and reopen. Also check for hidden sheets and unused named ranges/styles.'}
 @{d='excel'; g='Excel formulas display as text instead of calculating';
   s='The cells were formatted as Text before the formula was typed, so Excel stores the entry literally; alternatively Show Formulas view is toggled on for the whole sheet.';
   c=@(@('Get-Item ''C:\Reports\Calc.xlsx'' | Select-Object Name, Length',0,'Calc.xlsx  184320',''));
   r='Set the cells back to General, then re-enter the formulas (F2 then Enter forces re-evaluation); if every formula on the sheet shows, press Ctrl+` to turn off Show Formulas.'}
 @{d='excel'; g='Excel shows ''file is locked for editing by another user'' when nobody has it open';
   s='A stale owner file (~$filename.xlsx) was left behind after a crash or a dropped network connection, and Excel honors it as an active lock.';
   c=@(@('Get-ChildItem ''\\fileserver\share'' -Filter ''~$*.xlsx'' -Force -ErrorAction SilentlyContinue | Select-Object Name, LastWriteTime',0,'~$Budget.xlsx  8/2/2026 09:14',''),
       @('Get-SmbOpenFile -ErrorAction SilentlyContinue | Where-Object Path -like ''*Budget*'' | Select-Object ClientUserName, Path',0,'(no open handles on the server)',''));
   r='Confirm no live handle exists on the file server, then delete the hidden ~$ owner file; if it recurs frequently, investigate network drops between clients and the share.'}
 @{d='excel'; g='Power Query refresh fails with a credentials error after a password change';
   s='The query data source credentials are cached per-user in Excel own credential store, which still holds the old password -- the Windows credential change does not propagate to it.';
   c=@(@('Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Office\16.0\PowerQuery" -ErrorAction SilentlyContinue | Select-Object Name',0,'Credentials (cached data source entries)',''));
   r='Clear the source in Data > Get Data > Data Source Settings > Edit Permissions > Clear Permissions, then refresh and re-enter the current credentials.'}
 @{d='excel'; g='Excel macros are blocked with ''Microsoft has blocked macros from running''';
   s='The workbook came from the internet or a network share, so it carries the Mark of the Web; Excel blocks VBA in such files by policy regardless of the Trust Center macro setting.';
   c=@(@('Get-Item ''C:\Downloads\Report.xlsm'' -Stream Zone.Identifier -ErrorAction SilentlyContinue | Select-Object Stream, Length',0,'Zone.Identifier  26',''));
   r='If the source is trusted, right-click > Properties > Unblock (or Unblock-File); for organizational files, put the folder in a Trusted Location instead of unblocking each file individually.'}
 @{d='excel'; g='CSV files open with all data crammed into one column';
   s='Excel splits CSVs using the Windows regional list separator, and this system separator is a semicolon while the file uses commas -- so no split occurs.';
   c=@(@('Get-Culture | Select-Object Name, @{N=''ListSep'';E={$_.TextInfo.ListSeparator}}',0,'Name: de-DE  ListSep: ;',''),
       @('Get-Content ''C:\Data\export.csv'' -TotalCount 1',0,'id,name,amount',''));
   r='Use Data > From Text/CSV (which lets you pick the delimiter) instead of double-clicking, or change the list separator in Region settings; never rely on double-click CSV behavior across different locales.'}
 @{d='excel'; g='Numbers imported from a system appear as text and will not sum';
   s='The values carry leading apostrophes or non-breaking spaces from the source system, so Excel stores them as text and arithmetic ignores them.';
   c=@(@('Get-Content ''C:\Data\amounts.csv'' -TotalCount 3',0,'amount / 1,234.00 / 2,500.00 (values prefixed with non-breaking space)',''));
   r='Use Data > Text to Columns (finish with the correct locale) or VALUE(SUBSTITUTE(cell,CHAR(160),"")) to strip the non-breaking spaces; the green triangle indicator marks affected cells.'}
 @{d='excel'; g='Excel crashes when opening any file after an update';
   s='A COM add-in that has not been updated for the new Office build fails during load, taking Excel down before the workbook renders.';
   c=@(@('Get-ChildItem ''HKCU:\Software\Microsoft\Office\Excel\Addins'' | Select-Object PSChildName',0,'AnalyticsAddIn.Connect / VendorTools.Addin',''),
       @('Get-WinEvent -FilterHashtable @{LogName=''Application''; Id=1000} -MaxEvents 2 | Select-Object -ExpandProperty Message',0,'Faulting application EXCEL.EXE, faulting module AnalyticsAddIn.dll',''));
   r='Start Excel with excel /safe to confirm, then disable the faulting add-in under File > Options > Add-ins > COM Add-ins and get an updated version from the vendor.'}
 @{d='excel'; g='An Excel add-in disappears from the ribbon after a crash';
   s='Office moved the add-in to the Disabled Items list after it caused a hang, which is a protective mechanism -- the add-in is still installed but deliberately not loaded.';
   c=@(@('Get-ChildItem ''HKCU:\Software\Microsoft\Office\16.0\Excel\Resiliency\DisabledItems'' -ErrorAction SilentlyContinue | Select-Object Name',0,'DisabledItems key present with entries',''));
   r='Re-enable via File > Options > Add-ins > Manage: Disabled Items > Enable; if it keeps getting disabled, the add-in genuinely hangs and needs a vendor update rather than repeated re-enabling.'}
 @{d='excel'; g='32-bit Excel runs out of memory on large workbooks while the PC has plenty of RAM';
   s='32-bit Office is limited to roughly 2 GB of addressable memory per process regardless of installed RAM, so large models hit the ceiling well before the machine does.';
   c=@(@('Get-CimInstance Win32_OperatingSystem | Select-Object @{N=''TotalGB'';E={[math]::Round($_.TotalVisibleMemorySize/1MB,1)}}',0,'TotalGB : 31.9',''),
       @('Get-Process EXCEL | Select-Object @{N=''MB'';E={[int]($_.WorkingSet64/1MB)}}',0,'MB : 1980 (near the 32-bit ceiling)',''));
   r='Migrate to 64-bit Office (requires uninstalling 32-bit first and checking add-in compatibility), or reduce the model footprint with Power Pivot/data model instead of raw sheets.'}
 @{d='excel'; g='External workbook links show #REF! and will not update';
   s='The linked source workbook was moved or renamed, so the stored path no longer resolves and Excel returns #REF! rather than stale values.';
   c=@(@('Test-Path ''C:\Shared\SourceData.xlsx''',0,'False',''),
       @('Get-ChildItem ''C:\Shared'' -Filter ''*.xlsx'' | Select-Object Name',0,'SourceData_v2.xlsx',''));
   r='Use Data > Edit Links > Change Source to point at the renamed file; for shared models, keep sources on a stable UNC path so links survive folder reorganizations.'}
 @{d='word'; g='Word starts slowly and behaves oddly -- suspect Normal.dotm corruption';
   s='The global template Normal.dotm accumulates macros, styles and settings, and a corrupted copy causes slow starts and inconsistent formatting across every document.';
   c=@(@('Get-Item "$env:APPDATA\Microsoft\Templates\Normal.dotm" | Select-Object Length, LastWriteTime',0,'Length : 8421376  LastWriteTime : 8/1/2026',''));
   r='Close Word and rename Normal.dotm to Normal.old -- Word rebuilds a clean default. You lose custom styles/macros stored there, so keep a copy if any were intentional.'}
 @{d='word'; g='A Word document is ''locked for editing'' by yourself';
   s='A previous WINWORD process still holds the file open (often after a crash), so the owner file remains and Word treats your own stale session as another user.';
   c=@(@('Get-Process WINWORD -ErrorAction SilentlyContinue | Select-Object Id, StartTime, Responding',0,'Id 6120  StartTime 08:41  Responding False',''),
       @('Get-ChildItem ''C:\Docs'' -Filter ''~$*.docx'' -Force | Select-Object Name',0,'~$Contract.docx',''));
   r='End the stale WINWORD process, delete the hidden ~$ owner file, then reopen; if Word frequently leaves orphaned processes, disable the preview handler for Word files in Explorer.'}
 @{d='word'; g='Spell check does nothing in one document but works in others';
   s='The text is marked with the Do not check spelling or grammar language attribute, so the proofing engine skips it by design rather than being broken.';
   c=@(@('Get-Item ''C:\Docs\Report.docx'' | Select-Object Name, Length',0,'Report.docx  248320',''));
   r='Select all (Ctrl+A) > Review > Language > Set Proofing Language, uncheck Do not check spelling or grammar, and set the correct language; content pasted from web pages commonly carries this flag.'}
 @{d='word'; g='Fonts look different when a document is opened on another machine';
   s='The document uses fonts that are not installed on the second machine and were not embedded, so Word substitutes metrically similar alternatives and layout shifts.';
   c=@(@('Get-ChildItem C:\Windows\Fonts -Filter ''Calibri*'' | Select-Object Name',0,'calibri.ttf, calibrib.ttf',''),
       @('Get-ChildItem C:\Windows\Fonts -Filter ''Gotham*'' -ErrorAction SilentlyContinue | Measure-Object',0,'Count : 0',''));
   r='Embed the fonts in the file (File > Options > Save > Embed fonts in the file) if licensing allows, distribute as PDF for fixed layout, or standardize on fonts present in every Office install.'}
 @{d='word'; g='Mail merge to email silently sends nothing';
   s='Mail merge to email requires Outlook to be the default MAPI client and running; with a non-MAPI default mail app, Word completes the merge but no messages are handed off.';
   c=@(@('Get-ItemProperty ''HKCU:\Software\Clients\Mail'' -ErrorAction SilentlyContinue',0,'(default) : Mail (Windows Mail app)',''),
       @('Get-Process OUTLOOK -ErrorAction SilentlyContinue | Measure-Object',0,'Count : 0',''));
   r='Set Outlook as the default mail client, open it before running the merge, and use a valid email-address column; also check the Outbox for messages held by a large-batch throttling rule.'}
 @{d='word'; g='Track Changes keeps re-enabling itself for every document';
   s='Track Changes is saved in the template (Normal.dotm) rather than per-document, so every new document inherits the enabled state.';
   c=@(@('Get-Item "$env:APPDATA\Microsoft\Templates\Normal.dotm" | Select-Object LastWriteTime',0,'LastWriteTime : 8/3/2026',''));
   r='Open a blank document, turn Track Changes off, then save Normal.dotm; also check whether the document is protected with Tracked changes enforcement (Review > Restrict Editing), which cannot be turned off without the password.'}
 @{d='word'; g='A Word document will not open -- ''The file appears to be corrupted''';
   s='The .docx is a ZIP container and its central directory is damaged, so Word cannot read the package; the underlying document.xml may still be extractable.';
   c=@(@('Get-Item ''C:\Docs\Thesis.docx'' | Select-Object Length',0,'Length : 1284096',''),
       @('Copy-Item ''C:\Docs\Thesis.docx'' ''C:\Temp\Thesis.zip''',0,'',''));
   r='Try Word Open > Open and Repair first; if that fails, rename to .zip and extract word/document.xml, or restore from OneDrive version history/File History which is usually faster than salvage attempts.'}
 @{d='outlook'; g='Outlook takes minutes to start but runs fine once open';
   s='Multiple COM add-ins load synchronously at startup, and Outlook own diagnostics record the load time for each -- the total explains the delay while runtime performance stays normal.';
   c=@(@('Get-ChildItem ''HKCU:\Software\Microsoft\Office\Outlook\Addins'' | Select-Object PSChildName',0,'6 add-ins registered',''),
       @('Get-ItemProperty ''HKCU:\Software\Microsoft\Office\16.0\Outlook\AddInLoadTimes'' -ErrorAction SilentlyContinue',0,'(per-add-in load durations recorded)',''));
   r='Check File > Slow and Disabled Add-ins, disable the slowest ones you do not need, and keep the rest updated; Outlook itself disables add-ins exceeding the load-time threshold automatically.'}
 @{d='outlook'; g='Outlook rules stop running and new rules cannot be created';
   s='The mailbox has hit the server-side rules quota (32 KB by default, up to 256 KB), so Exchange refuses to store additional rules and existing ones can stop processing.';
   c=@(@('Get-InboxRule -Mailbox jdoe@corp.com | Measure-Object | Select-Object Count',0,'Count : 47',''));
   r='Delete unused rules and shorten long rule names/conditions (which consume the quota), or ask an Exchange admin to raise RulesQuota; consolidating similar rules recovers the most space.'}
 @{d='outlook'; g='Some Outlook rules only work when Outlook is open';
   s='Those rules are client-only (they use actions Exchange cannot perform server-side, like running a script or moving to a PST), so they execute only while the client is running.';
   c=@(@('Get-InboxRule -Mailbox jdoe@corp.com | Select-Object Name, Enabled, Description | Select-Object -First 3',0,'Name: FileToArchive  Description: move to PST (client-only)',''));
   r='Change the target to a server-side mailbox folder instead of a PST and avoid client-only actions, so Exchange can run the rule regardless of whether Outlook is open.'}
 @{d='outlook'; g='Free/busy information shows as hashed lines for everyone';
   s='The client cannot reach the Availability service endpoint, so Outlook has no free/busy data to render and falls back to the no-information hatch pattern.';
   c=@(@('Test-NetConnection outlook.office365.com -Port 443',0,'TcpTestSucceeded : True',''),
       @('Test-NetConnection autodiscover.corp.com -Port 443',1,'','TcpTestSucceeded : False'));
   r='Fix Autodiscover reachability -- the Availability service is located through it, which is why free/busy fails while mail flow (already-configured) continues to work.'}
 @{d='outlook'; g='Outlook send/receive fails with error 0x8004010F ''The operation failed. An object cannot be found''';
   s='0x8004010F is an Offline Address Book download failure; the OAB folder in the local profile is corrupted or the OAB URL is unreachable, so the download step errors while mail continues to flow.';
   c=@(@('Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Outlook\Offline Address Books" -ErrorAction SilentlyContinue | Measure-Object',0,'Count : 3',''));
   r='Close Outlook, delete the Offline Address Books folder so it re-downloads, then Send/Receive > Download Address Book; if it recurs, verify the OAB virtual directory on the Exchange side.'}
 @{d='outlook'; g='Outlook cannot send mail -- error 0x800CCC0E with an IMAP/POP account';
   s='0x800CCC0E is an SMTP connection failure; the configured outgoing port is blocked, and the provider requires the submission port with TLS instead of the legacy port.';
   c=@(@('Test-NetConnection smtp.mailprovider.com -Port 25',1,'','TcpTestSucceeded : False'),
       @('Test-NetConnection smtp.mailprovider.com -Port 587',0,'TcpTestSucceeded : True',''));
   r='Change the outgoing server to port 587 with STARTTLS and authentication enabled; most ISPs and hosts block outbound port 25 to limit spam relaying.'}
 @{d='outlook'; g='A PST file has stopped accepting new mail';
   s='The PST reached its configured maximum size; ANSI-format PSTs cap near 2 GB, and Unicode PSTs have a configurable limit that policy may have set low.';
   c=@(@('Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Outlook" -Filter ''*.pst'' | Select-Object Name, @{N=''GB'';E={[math]::Round($_.Length/1GB,2)}}',0,'Archive.pst  1.99',''),
       @('Get-ItemProperty ''HKCU:\Software\Policies\Microsoft\Office\16.0\Outlook\PST'' -ErrorAction SilentlyContinue',0,'(not set - ANSI format limit applies)',''));
   r='Create a new Unicode PST and move items into it (ANSI PSTs cannot be converted in place), and archive older mail to keep individual files well under the limit for performance.'}
 @{d='outlook'; g='Outlook calendar items disappear or duplicate after using multiple devices';
   s='Two clients are applying conflicting changes to the same items and Exchange keeps both resolutions, producing duplicates -- commonly an old ActiveSync device plus a desktop client.';
   c=@(@('Get-MobileDeviceStatistics -Mailbox jdoe@corp.com -ErrorAction SilentlyContinue | Select-Object DeviceModel, LastSuccessSync',0,'OldPhone  LastSuccessSync 2024-03-11',''));
   r='Remove stale device partnerships from the mailbox, keep one authoritative client for calendar edits, and use the built-in Clean Up tool for the duplicates that already exist.'}
 @{d='outlook'; g='Outlook profile is corrupted -- repeated crashes only for one user on a shared PC';
   s='The failure follows the user Outlook profile rather than the machine, and their profile registry subtree contains inconsistent account entries after a migration.';
   c=@(@('Get-ChildItem ''HKCU:\Software\Microsoft\Office\16.0\Outlook\Profiles'' | Select-Object PSChildName',0,'Outlook / Outlook_old',''),
       @('Get-Process OUTLOOK -ErrorAction SilentlyContinue | Select-Object Responding',0,'(crashes at startup)',''));
   r='Create a fresh Outlook profile (Control Panel > Mail > Show Profiles > Add) and set it as default; server-hosted mail re-downloads, so only local PSTs need re-attaching.'}
 @{d='outlook'; g='Attachments are blocked -- ''Outlook blocked access to the following potentially unsafe attachments''';
   s='Outlook Level 1 attachment blocking hides certain file types unconditionally, which is a security feature rather than a fault or a policy misconfiguration.';
   c=@(@('Get-ItemProperty ''HKCU:\Software\Microsoft\Office\16.0\Outlook\Security'' -ErrorAction SilentlyContinue',1,'','(value not set - defaults apply)'));
   r='Ask the sender to place the file in OneDrive/SharePoint and share a link, or to send it inside a password-protected archive; loosening Level1Remove weakens a broadly effective protection and is not recommended.'}
 @{d='outlook'; g='Email signature does not apply to replies, only to new messages';
   s='Signatures are configured separately for new messages and for replies/forwards, and the replies slot was left as none.';
   c=@(@('Get-ChildItem "$env:APPDATA\Microsoft\Signatures" -ErrorAction SilentlyContinue | Select-Object Name',0,'Corporate.htm  Corporate.rtf  Corporate.txt',''));
   r='Set the signature for Replies/forwards in File > Options > Mail > Signatures; for organization-wide consistency, apply a server-side transport rule disclaimer instead of per-client signatures.'}
 @{d='outlook'; g='Meeting invitations go straight to Deleted Items';
   s='A rule or the calendar auto-processing setting is deleting invitations after processing them, so they are handled but not left in the Inbox.';
   c=@(@('Get-InboxRule -Mailbox jdoe@corp.com | Where-Object {$_.DeleteMessage -eq $true} | Select-Object Name',0,'Name : ProcessInvites',''),
       @('Get-CalendarProcessing -Identity jdoe@corp.com -ErrorAction SilentlyContinue | Select-Object AutomateProcessing',0,'AutomateProcessing : AutoUpdate',''));
   r='Disable or correct the deleting rule; AutoUpdate processing on a user mailbox is normal and updates the calendar, but it should not delete the original invitation.'}
 @{d='teams'; g='Teams uses very high memory and slows the whole machine';
   s='Teams is an Electron application that keeps each open chat, channel and call surface in memory; long uninterrupted sessions accumulate usage until it is restarted.';
   c=@(@('Get-Process ms-teams,Teams -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum | Select-Object @{N=''TotalMB'';E={[int]($_.Sum/1MB)}}',0,'TotalMB : 3120',''));
   r='Restart Teams periodically, disable GPU hardware acceleration if the renderer is heavy, and prefer the new Teams client which uses substantially less memory than classic.'}
 @{d='teams'; g='Teams screen sharing shows a black screen to participants';
   s='The capture path fails when hardware acceleration interacts with a discrete GPU on hybrid graphics, so Teams captures nothing while the meeting itself works normally.';
   c=@(@('Get-CimInstance Win32_VideoController | Select-Object Name, Status',0,'Intel UHD  OK / NVIDIA RTX 3050  OK',''));
   r='Disable GPU hardware acceleration in Teams settings and restart it, update the graphics driver, and set Teams to High performance GPU in Windows Graphics settings so capture and render use the same adapter.'}
 @{d='teams'; g='Teams notifications never appear on the desktop';
   s='Windows Focus Assist or the per-app notification permission is blocking them, so Teams generates the notification and Windows suppresses it before display.';
   c=@(@('Get-ItemProperty ''HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings'' -ErrorAction SilentlyContinue | Select-Object -First 1',0,'Teams entry present with Enabled : 0',''));
   r='Enable Teams under Settings > System > Notifications, turn off Do not disturb, and set Teams own notification style to Windows rather than built-in so the OS handles delivery.'}
 @{d='teams'; g='Teams keeps signing out or asking for credentials repeatedly';
   s='The cached authentication tokens in the Teams identity cache are corrupted, so each session obtains a token that fails validation on next launch.';
   c=@(@('Get-ChildItem "$env:LOCALAPPDATA\Packages" -Filter ''MSTeams*'' -ErrorAction SilentlyContinue | Measure-Object',0,'Count : 1',''),
       @('cmdkey /list',0,'Target: MicrosoftOffice16_Data:live.com:...',''));
   r='Sign out fully, clear the Teams cache folder and the related Credential Manager entries, then sign in once; if it persists across users, check Conditional Access policies forcing frequent reauthentication.'}
 @{d='onedrive'; g='OneDrive sync fails for some files with ''path too long''';
   s='The combined local path exceeds the sync client limit once the OneDrive root and SharePoint library structure are added, so those specific files never sync.';
   c=@(@('Get-ItemProperty ''HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'' -Name LongPathsEnabled -ErrorAction SilentlyContinue',0,'LongPathsEnabled : 0',''));
   r='Shorten folder names, sync a deeper subfolder instead of the whole library, and enable LongPathsEnabled; SharePoint also enforces its own URL length limit independent of Windows.'}
 @{d='onedrive'; g='SharePoint library sync becomes very slow with a large library';
   s='The library exceeds the recommended synced-item count, and the sync client per-item overhead dominates -- it is a scale limit rather than a bandwidth problem.';
   c=@(@('Get-ChildItem "$env:USERPROFILE" -Recurse -Directory -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count',0,'Count : 312450',''));
   r='Sync only the subfolders actually needed, use Files On-Demand so content is not downloaded, and keep synced libraries within Microsoft supported item counts; very large libraries should be browsed rather than synced.'}
 @{d='onedrive'; g='Personal and work OneDrive accounts conflict on the same PC';
   s='Both accounts are configured and both attempt Known Folder Move for Desktop/Documents, so folder redirection ownership flips between them.';
   c=@(@('Get-ChildItem "$env:USERPROFILE" -Directory | Where-Object Name -like ''OneDrive*'' | Select-Object Name',0,'OneDrive - Personal / OneDrive - Contoso',''));
   r='Allow only one account to manage Known Folder Move (normally the work account), and keep personal files in the personal OneDrive folder rather than under redirected folders.'}
 @{d='office'; g='Office apps fail to start with error 0xc0000142';
   s='0xc0000142 means a required DLL failed to initialize during process startup -- here a mismatched Office component after an interrupted Click-to-Run update.';
   c=@(@('Get-WinEvent -FilterHashtable @{LogName=''Application''; Id=1000} -MaxEvents 2 | Select-Object -ExpandProperty Message',0,'Faulting application WINWORD.EXE, exception code 0xc0000142',''),
       @('Get-ItemProperty ''HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration'' -Name VersionToReport -ErrorAction SilentlyContinue',0,'VersionToReport : 16.0.17328.20124',''));
   r='Run an Online Repair from Apps > Microsoft 365 > Modify (a Quick Repair is usually insufficient for 0xc0000142), and ensure no update is in progress while repairing.'}
 @{d='office'; g='Office updates fail and the version never changes';
   s='The Click-to-Run service is stopped, so the update engine can neither download nor apply updates while the apps themselves continue to run on the installed build.';
   c=@(@('Get-Service ClickToRunSvc | Select-Object Status, StartType',0,'Status : Stopped  StartType : Disabled',''),
       @('Get-ItemProperty ''HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration'' -Name UpdatesEnabled -ErrorAction SilentlyContinue',0,'UpdatesEnabled : False',''));
   r='Set ClickToRunSvc to Automatic and start it, and set UpdatesEnabled back to True (or fix the managing policy); the service being disabled is usually a leftover from a manual stop-updates tweak.'}
 @{d='office'; g='Every Office file opens in Protected View and editing requires an extra click';
   s='The files come from an internet or network location, and Protected View is applying to those origins by design as a sandbox against malicious documents.';
   c=@(@('Get-ItemProperty ''HKCU:\Software\Microsoft\Office\16.0\Word\Security\ProtectedView'' -ErrorAction SilentlyContinue',0,'(defaults - Protected View enabled)',''));
   r='Add the specific internal file share as a Trusted Location rather than disabling Protected View globally; Protected View is one of Office strongest defenses against document-based attacks.'}
 @{d='office'; g='Office asks to activate on every launch for a specific user only';
   s='The user Office identity/licensing tokens are corrupted in their profile, so activation succeeds at runtime but is not persisted between sessions.';
   c=@(@('Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Office\16.0\Licensing" -ErrorAction SilentlyContinue | Measure-Object',0,'Count : 38',''),
       @('cmdkey /list',0,'Target: MicrosoftOffice16_Data:...',''));
   r='Sign out of Office, clear the Licensing folder and the MicrosoftOffice credentials in Credential Manager, then sign in once; for shared machines consider Shared Computer Activation licensing.'}
 @{d='office'; g='A COM add-in keeps disabling itself across all Office apps';
   s='Office resiliency mechanism disabled it after repeated crashes, and the LoadBehavior value was reset accordingly -- re-enabling in the UI does not survive the next crash.';
   c=@(@('Get-ItemProperty ''HKCU:\Software\Microsoft\Office\Word\Addins\Vendor.Addin'' -Name LoadBehavior -ErrorAction SilentlyContinue',0,'LoadBehavior : 2',''));
   r='LoadBehavior 2 means loaded at startup but currently disabled. Setting it to 3 re-enables it, but the underlying crash must be fixed by the vendor or the resiliency logic will disable it again.'}
 @{d='office'; g='Data connections in Office files fail with an ODBC driver error';
   s='The workbook was authored against a 32-bit ODBC driver, and 64-bit Office looks in the 64-bit ODBC registry hive where no matching DSN exists.';
   c=@(@('Get-OdbcDsn -ErrorAction SilentlyContinue | Select-Object Name, Platform, DriverName',0,'SalesDB  32-bit  SQL Server',''),
       @('Get-ItemProperty ''HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration'' -Name Platform -ErrorAction SilentlyContinue',0,'Platform : x64',''));
   r='Create a matching 64-bit DSN (odbcad32.exe from System32, not SysWOW64) with the same name, or install the 64-bit driver; DSN name alone does not bridge the bitness gap.'}
 @{d='office'; g='Office documents on a network share open extremely slowly';
   s='Each open performs multiple metadata round trips to the share, and the WAN latency multiplies them -- throughput is fine, per-operation latency is the constraint.';
   c=@(@('Test-NetConnection fileserver -Port 445 -InformationLevel Detailed',0,'RoundtripTime : 62 ms',''),
       @('Get-SmbClientConfiguration | Select-Object DirectoryCacheLifetime, FileInfoCacheLifetime',0,'DirectoryCacheLifetime : 10  FileInfoCacheLifetime : 10',''));
   r='Move the working set to OneDrive/SharePoint sync (local copies with background sync) or a local DFS replica; increasing SMB cache lifetimes helps marginally but cannot overcome 60 ms RTT for chatty operations.'}
 @{d='office'; g='Shared workbook co-authoring is unavailable and users get read-only copies';
   s='Co-authoring requires the file to be stored in OneDrive/SharePoint and saved in the modern format; a file on a classic file share or in legacy .xls format can only be opened exclusively.';
   c=@(@('Get-Item ''\\fileserver\finance\Budget.xls'' | Select-Object Name, Extension',0,'Budget.xls  .xls',''));
   r='Convert to .xlsx and move the file to a SharePoint/OneDrive library with AutoSave enabled; SMB file shares fundamentally cannot support co-authoring regardless of Office version.'}
 @{d='office'; g='Word/Excel hang when printing to a specific network printer';
   s='Office queries the printer driver for capabilities at print time, and this driver blocks on an unreachable print server, so the app appears frozen while it waits.';
   c=@(@('Get-Printer | Where-Object Name -like ''*Floor3*'' | Select-Object Name, PrinterStatus, PortName',0,'Floor3-HP  Error  \\printsrv\Floor3-HP',''),
       @('Test-NetConnection printsrv -Port 445',1,'','TcpTestSucceeded : False'));
   r='Remove or repoint the unreachable printer and set a reachable default; Office querying an offline print server is a very common cause of app-wide hangs that look like Office faults.'}
 @{d='office'; g='Office apps show ''The Office Subscription could not be verified'' on an offline machine';
   s='Subscription licenses need periodic online verification; this machine has been offline past the grace period, so Office moves to reduced-functionality mode until it can check in.';
   c=@(@('Test-NetConnection licensing.mp.microsoft.com -Port 443',1,'','TcpTestSucceeded : False'),
       @('Get-Item "$env:LOCALAPPDATA\Microsoft\Office\Licenses" -ErrorAction SilentlyContinue | Select-Object FullName',0,'(license cache present but stale)',''));
   r='Connect the machine to the internet so Office can re-verify (roughly every 30 days), or move permanently-offline machines to a perpetual/volume-licensed Office edition instead of subscription.'}
)

# ---------------------------------------------------------------------------
if (-not (Test-Path $JsonlPath)) { throw "Not found: $JsonlPath  (run this in the folder with repair-dataset.jsonl)" }

Write-Host "Loading $JsonlPath ..." -ForegroundColor Cyan
$lines = @(Get-Content $JsonlPath -Encoding UTF8 | Where-Object { $_.Trim() })
Write-Host ("Existing entries: {0}" -f $lines.Count) -ForegroundColor Cyan

$existing = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($l in $lines) {
    try { [void]$existing.Add((($l | ConvertFrom-Json).messages | Where-Object role -eq 'user').content) } catch {}
}

Copy-Item $JsonlPath "$JsonlPath.bak" -Force
Write-Host "Backup: $JsonlPath.bak" -ForegroundColor DarkGray

$added = 0; $skipped = 0
$newLines = New-Object System.Collections.Generic.List[string]
foreach ($e in $NEW) {
    if ($existing.Contains($e.g)) { $skipped++; continue }
    $cmdText = ($e.c | ForEach-Object {
        if ($_[1] -ne 0 -and $_[3]) { "- $($_[0])  [FAILED: $($_[3])]" } else { "- $($_[0])" }
    }) -join "`n"
    $assistant = "$($e.s)`nCommands used:`n$cmdText`nRecommendation: $($e.r)"
    $obj = [ordered]@{ messages = @(
        [ordered]@{ role='system';    content="You are a Windows repair expert specializing in $($e.d) problems. Diagnose with read-only commands first, then apply safe fixes. When a command fails, interpret the error and adapt." }
        [ordered]@{ role='user';      content=$e.g }
        [ordered]@{ role='assistant'; content=$assistant }
    )}
    $newLines.Add(($obj | ConvertTo-Json -Depth 8 -Compress))
    [void]$existing.Add($e.g); $added++
}

$all = @($lines) + @($newLines)
Set-Content -Path $JsonlPath -Value $all -Encoding UTF8

Write-Host ""
Write-Host "================ RESULT ================" -ForegroundColor Green
Write-Host ("Added   : {0}" -f $added)
Write-Host ("Skipped : {0} (already present)" -f $skipped)
Write-Host ("Total   : {0}" -f $all.Count) -ForegroundColor Cyan

# ---- optional: sessions json ----
if (Test-Path $JsonPath) {
    Write-Host "`nUpdating $JsonPath ..." -ForegroundColor Cyan
    Copy-Item $JsonPath "$JsonPath.bak" -Force
    $data = [System.Collections.ArrayList]@(Get-Content $JsonPath -Raw | ConvertFrom-Json)
    $have = @{}; foreach ($d in $data) { $have[$d.goal] = $true }
    $n = 1; $jAdded = 0
    $ids = @{}; foreach ($d in $data) { $ids[$d.id] = $true }
    $base = Get-Date '2026-08-05T09:00:00Z'
    foreach ($e in $NEW) {
        if ($have.ContainsKey($e.g)) { continue }
        while ($ids.ContainsKey(("new-win-repair-{0:d3}" -f $n))) { $n++ }
        $id = "new-win-repair-{0:d3}" -f $n; $ids[$id] = $true
        $t = $base.AddMinutes(5 * $jAdded)
        $steps = @($e.c | ForEach-Object {
            [ordered]@{ command=$_[0]; blocked=$false; exitCode=$_[1]; stdout=$_[2]; stderr=$_[3]; reason=$null }
        })
        [void]$data.Add([ordered]@{
            id=$id; createdAt=$t.ToString('yyyy-MM-ddTHH:mm:ss.000Z'); goal=$e.g; domain=$e.d
            plan=@('Reproduce and scope the Office issue with read-only checks',
                   'Separate an Office fault from a Windows, network or licensing cause',
                   'Apply the correct fix or explain the expected behavior')
            steps=$steps; resolved=$true; summary=$e.s; recommendation=$e.r
            feedback=[ordered]@{ worked=$true; note=''; at=$t.AddMinutes(3).ToString('yyyy-MM-ddTHH:mm:ss.000Z') }
        })
        $jAdded++
    }
    $data | ConvertTo-Json -Depth 12 | Set-Content $JsonPath -Encoding UTF8
    Write-Host ("Added to json : {0}   Total: {1}" -f $jAdded, $data.Count) -ForegroundColor Cyan
} else {
    Write-Host "`n(repair-sessions.json not found - only the .jsonl was updated)" -ForegroundColor Yellow
}

Write-Host "`nDone." -ForegroundColor Green
