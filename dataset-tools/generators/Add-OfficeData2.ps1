<#
.SYNOPSIS
    Adds 38 ACTIONABLE Microsoft Office scenarios where PowerShell can
    actually PERFORM the fix (not just diagnose).

.DESCRIPTION
    These entries teach an agent HOW Office problems are solved from
    PowerShell: file/cache operations, registry settings, services,
    COM automation of the Office apps themselves, Exchange Online
    cmdlets, and the Office repair CLI.

    Safe to run more than once - duplicates are skipped.

.EXAMPLE
    cd D:\data1
    .\Add-OfficeData2.ps1
#>
[CmdletBinding()]
param(
    [string]$JsonlPath = ".\repair-dataset.jsonl",
    [string]$JsonPath  = ".\repair-sessions.json"
)
$ErrorActionPreference = 'Stop'

$NEW = @(
 @{d='office'; g='Fix a stuck Office file lock from PowerShell without opening any app';
   s='A crashed session left the hidden owner file behind and a WINWORD process still running. Ending the process and deleting the ~$ owner file releases the lock entirely from PowerShell - no GUI needed.';
   c=@(@('Get-Process WINWORD,EXCEL,POWERPNT -ErrorAction SilentlyContinue | Select-Object Name, Id, Responding',0,'WINWORD  6120  False',''),
       @('Get-ChildItem ''C:\Docs'' -Filter ''~$*'' -Force -Recurse -ErrorAction SilentlyContinue | Select-Object FullName',0,'C:\Docs\~$Contract.docx',''),
       @('Stop-Process -Name WINWORD -Force',0,'',''),
       @('Get-ChildItem ''C:\Docs'' -Filter ''~$*'' -Force -Recurse | Remove-Item -Force',0,'',''));
   r='Always confirm the process is genuinely hung (Responding False) before killing it, since unsaved work is lost; the ~$ files are hidden, so -Force is required to see and remove them.'}
 @{d='office'; g='Reset a corrupted Normal.dotm entirely from PowerShell';
   s='The global Word template was corrupted. Renaming it while Word is closed makes Word rebuild a clean default on next launch - fully scriptable.';
   c=@(@('Get-Process WINWORD -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count',0,'Count : 0',''),
       @('$n = "$env:APPDATA\Microsoft\Templates\Normal.dotm"; Get-Item $n | Select-Object Length, LastWriteTime',0,'Length : 8421376',''),
       @('Rename-Item "$env:APPDATA\Microsoft\Templates\Normal.dotm" "Normal.old.dotm" -Force',0,'',''));
   r='Keep the renamed copy until the user confirms no custom styles or macros are missing; if they are needed, they can be imported from Normal.old.dotm with the Organizer.'}
 @{d='teams'; g='Clear the Teams cache from PowerShell to fix sign-in and rendering issues';
   s='Teams stores its cache under the app package local state; deleting it while Teams is closed forces a clean rebuild and resolves most stale-token and blank-UI problems.';
   c=@(@('Get-Process ms-teams,Teams -ErrorAction SilentlyContinue | Stop-Process -Force',0,'',''),
       @('$p = "$env:LOCALAPPDATA\Packages\MSTeams_8wekyb3d8bbwe\LocalCache"; Test-Path $p',0,'True',''),
       @('Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue',0,'',''));
   r='For classic Teams the path is %AppData%\Microsoft\Teams instead; clearing the cache signs the user out, so warn them before running it on a shared machine.'}
 @{d='office'; g='Clear Office licensing tokens and cached credentials from PowerShell';
   s='Activation prompts on every launch come from corrupted per-user licensing tokens. Removing the Licensing folder and the Office entries in Credential Manager forces a clean re-provision at next sign-in.';
   c=@(@('Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Office\16.0\Licensing" -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count',0,'Count : 38',''),
       @('cmdkey /list | Select-String ''MicrosoftOffice''',0,'Target: MicrosoftOffice16_Data:live.com:...',''),
       @('Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Office\16.0\Licensing" -Recurse -Force | Remove-Item -Recurse -Force',0,'',''),
       @('cmdkey /delete:MicrosoftOffice16_Data:live.com:name=user@corp.com',0,'CMDKEY: Credential deleted successfully.',''));
   r='Close every Office app first; the user signs in once afterwards and the token is rebuilt. On shared machines use Shared Computer Activation instead of repeated token resets.'}
 @{d='office'; g='Re-enable an Office add-in that Windows keeps disabling, using the registry';
   s='LoadBehavior 2 means the add-in is registered but currently disabled by resiliency. Setting it back to 3 re-enables loading, and clearing the Resiliency keys removes the disabled/crash record.';
   c=@(@('Get-ItemProperty ''HKCU:\Software\Microsoft\Office\Excel\Addins\Vendor.Addin'' -Name LoadBehavior',0,'LoadBehavior : 2',''),
       @('Set-ItemProperty ''HKCU:\Software\Microsoft\Office\Excel\Addins\Vendor.Addin'' -Name LoadBehavior -Value 3',0,'',''),
       @('Remove-Item ''HKCU:\Software\Microsoft\Office\16.0\Excel\Resiliency\DisabledItems'' -Recurse -Force -ErrorAction SilentlyContinue',0,'',''));
   r='If the add-in crashes again Office will re-disable it - the registry fix only clears the symptom, so pair it with an updated add-in build from the vendor.'}
 @{d='excel'; g='Unblock macro-blocked workbooks in bulk from PowerShell';
   s='Files carrying the Mark of the Web have VBA blocked by policy. Unblock-File removes the Zone.Identifier stream, which is exactly what the right-click Unblock button does.';
   c=@(@('Get-ChildItem ''C:\Reports'' -Filter ''*.xlsm'' -Recurse | ForEach-Object { $_ | Get-Item -Stream Zone.Identifier -ErrorAction SilentlyContinue } | Measure-Object | Select-Object Count',0,'Count : 14',''),
       @('Get-ChildItem ''C:\Reports'' -Filter ''*.xlsm'' -Recurse | Unblock-File',0,'',''));
   r='Only unblock files from a verified source. For an ongoing internal folder, adding it as a Trusted Location is safer than repeatedly stripping the mark from downloaded files.'}
 @{d='office'; g='Add a Trusted Location for Office through the registry instead of the GUI';
   s='Trusted Locations are stored per-application in the user hive, so an agent can create them directly and avoid stripping the Mark of the Web from individual files.';
   c=@(@('Get-ChildItem ''HKCU:\Software\Microsoft\Office\16.0\Excel\Security\Trusted Locations'' -ErrorAction SilentlyContinue | Select-Object PSChildName',0,'Location0  Location1',''),
       @('New-Item ''HKCU:\Software\Microsoft\Office\16.0\Excel\Security\Trusted Locations\Location99'' -Force | Out-Null',0,'',''),
       @('Set-ItemProperty ''HKCU:\Software\Microsoft\Office\16.0\Excel\Security\Trusted Locations\Location99'' -Name Path -Value ''C:\Reports\''',0,'',''),
       @('Set-ItemProperty ''HKCU:\Software\Microsoft\Office\16.0\Excel\Security\Trusted Locations\Location99'' -Name AllowSubfolders -Value 1',0,'',''));
   r='Trust only specific, controlled folders - never a whole drive or the user profile root. Network paths additionally require AllowNetworkLocations to be enabled.'}
 @{d='outlook'; g='Force a clean Offline Address Book rebuild from PowerShell';
   s='Error 0x8004010F is an OAB download failure caused by a corrupted local copy. Deleting the OAB folder while Outlook is closed makes it re-download on the next Send/Receive.';
   c=@(@('Get-Process OUTLOOK -ErrorAction SilentlyContinue | Stop-Process -Force',0,'',''),
       @('$oab = "$env:LOCALAPPDATA\Microsoft\Outlook\Offline Address Books"; Get-ChildItem $oab -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count',0,'Count : 3',''),
       @('Remove-Item "$env:LOCALAPPDATA\Microsoft\Outlook\Offline Address Books" -Recurse -Force',0,'',''));
   r='After reopening Outlook, trigger Send/Receive > Download Address Book; if the error returns, the OAB virtual directory on the Exchange side needs checking rather than the client.'}
 @{d='outlook'; g='Create a fresh Outlook profile from PowerShell by renaming the profile key';
   s='Outlook profiles live under the user registry hive. Renaming the profiles subtree makes Outlook prompt to create a new profile at next start, without touching server-hosted mail.';
   c=@(@('Get-ChildItem ''HKCU:\Software\Microsoft\Office\16.0\Outlook\Profiles'' | Select-Object PSChildName',0,'Outlook',''),
       @('Get-Process OUTLOOK -ErrorAction SilentlyContinue | Stop-Process -Force',0,'',''),
       @('Rename-Item ''HKCU:\Software\Microsoft\Office\16.0\Outlook\Profiles\Outlook'' ''Outlook_old''',0,'',''));
   r='Local PST files must be re-attached to the new profile manually; export the signature and AutoComplete stream first if the user relies on them, since both are profile-scoped.'}
 @{d='outlook'; g='Clear the Outlook AutoComplete (nickname) cache from PowerShell';
   s='Bad cached recipients that keep resolving to wrong addresses live in the RoamCache stream files; removing them clears AutoComplete without affecting contacts.';
   c=@(@('Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Outlook\RoamCache" -Filter ''Stream_Autocomplete*'' -ErrorAction SilentlyContinue | Select-Object Name, Length',0,'Stream_Autocomplete_0_...dat  482304',''),
       @('Get-Process OUTLOOK -ErrorAction SilentlyContinue | Stop-Process -Force',0,'',''),
       @('Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Outlook\RoamCache" -Filter ''Stream_Autocomplete*'' | Remove-Item -Force',0,'',''));
   r='This clears all suggestions, not just the bad one; to remove a single entry the user can press X next to it in the address suggestion list instead.'}
 @{d='office'; g='Run an Office repair silently from PowerShell using OfficeC2RClient';
   s='Click-to-Run exposes a command-line repair, so an agent can trigger both Quick and Online repair unattended rather than walking the user through Apps and Features.';
   c=@(@('Test-Path ''C:\Program Files\Common Files\microsoft shared\ClickToRun\OfficeC2RClient.exe''',0,'True',''),
       @('Get-Service ClickToRunSvc | Select-Object Status',0,'Status : Running',''),
       @('& ''C:\Program Files\Common Files\microsoft shared\ClickToRun\OfficeC2RClient.exe'' scenario=Repair platform=x64 culture=en-us RepairType=QuickRepair DisplayLevel=False',0,'',''));
   r='QuickRepair is offline and fast; use RepairType=FullRepair for 0xc0000142-class problems, which re-downloads and takes much longer. Close all Office apps first either way.'}
 @{d='office'; g='Force Office to update immediately from PowerShell';
   s='The same Click-to-Run client can trigger an update check and apply, which is how an agent brings a machine to the current build without user interaction.';
   c=@(@('Get-ItemProperty ''HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration'' -Name VersionToReport',0,'VersionToReport : 16.0.17328.20124',''),
       @('Set-Service ClickToRunSvc -StartupType Automatic; Start-Service ClickToRunSvc',0,'',''),
       @('& ''C:\Program Files\Common Files\microsoft shared\ClickToRun\OfficeC2RClient.exe'' /update user displaylevel=false',0,'',''));
   r='displaylevel=false runs it silently; use displaylevel=true when the user should see progress. Verify afterwards by re-reading VersionToReport.'}
 @{d='excel'; g='Turn off Show Formulas and force a full recalculation using COM automation';
   s='PowerShell can drive Excel itself through COM, so in-application settings that have no registry equivalent can still be fixed programmatically.';
   c=@(@('$xl = New-Object -ComObject Excel.Application; $xl.Visible = $false',0,'',''),
       @('$wb = $xl.Workbooks.Open(''C:\Reports\Calc.xlsx''); $xl.ActiveWindow.DisplayFormulas',0,'True',''),
       @('$xl.ActiveWindow.DisplayFormulas = $false; $xl.Calculation = -4105; $wb.Application.CalculateFull()',0,'',''),
       @('$wb.Save(); $wb.Close($true); $xl.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null',0,'',''));
   r='Always Quit and release the COM object, otherwise an invisible EXCEL.EXE stays running and locks the file. -4105 is xlCalculationAutomatic.'}
 @{d='word'; g='Turn off Track Changes in a document using COM automation';
   s='Track Changes is a document property, not a registry setting, so COM automation is the only scriptable way to change it without opening Word interactively.';
   c=@(@('$w = New-Object -ComObject Word.Application; $w.Visible = $false',0,'',''),
       @('$doc = $w.Documents.Open(''C:\Docs\Contract.docx''); $doc.TrackRevisions',0,'True',''),
       @('$doc.TrackRevisions = $false; $doc.Revisions.AcceptAll()',0,'',''),
       @('$doc.Save(); $doc.Close(); $w.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null',0,'',''));
   r='AcceptAll permanently applies every tracked edit - confirm with the document owner first. If the document is protected for tracked changes, the protection password is required before this works.'}
 @{d='word'; g='Repair a corrupted Word document from PowerShell using Open and Repair';
   s='Word exposes its Open and Repair behaviour through COM, so recovery can be attempted programmatically before falling back to manual salvage.';
   c=@(@('Get-Item ''C:\Docs\Thesis.docx'' | Select-Object Length',0,'Length : 1284096',''),
       @('$w = New-Object -ComObject Word.Application; $w.Visible = $false',0,'',''),
       @('$doc = $w.Documents.Open(''C:\Docs\Thesis.docx'', $false, $false, $false, '''', '''', $false, '''', '''', 0, 0, $true)',0,'(opened with repair)',''),
       @('$doc.SaveAs2(''C:\Docs\Thesis-recovered.docx''); $doc.Close(); $w.Quit()',0,'',''));
   r='Always save the repaired result under a new name so the original is preserved for a second attempt with different tooling if content is still missing.'}
 @{d='excel'; g='Convert legacy .xls files to .xlsx in bulk with COM automation';
   s='Old binary workbooks block co-authoring and modern features; COM automation converts a whole folder unattended, which no GUI workflow can do at scale.';
   c=@(@('Get-ChildItem ''D:\Archive'' -Filter ''*.xls'' -Recurse | Measure-Object | Select-Object Count',0,'Count : 214',''),
       @('$xl = New-Object -ComObject Excel.Application; $xl.Visible=$false; $xl.DisplayAlerts=$false',0,'',''),
       @('Get-ChildItem ''D:\Archive'' -Filter ''*.xls'' -Recurse | ForEach-Object { $wb=$xl.Workbooks.Open($_.FullName); $wb.SaveAs(($_.FullName -replace ''\.xls$'',''.xlsx''), 51); $wb.Close($false) }',0,'',''),
       @('$xl.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null',0,'',''));
   r='Format 51 is xlOpenXMLWorkbook. Test on a copy first - files with legacy macros need format 52 (.xlsm) instead, and macro code may still need review.'}
 @{d='outlook'; g='Export and inspect Outlook rules from PowerShell before cleaning them up';
   s='Exchange Online PowerShell exposes the server-side rules directly, so an agent can audit, disable and remove rules without the Outlook client at all.';
   c=@(@('Connect-ExchangeOnline -UserPrincipalName admin@corp.com -ShowBanner:$false',0,'',''),
       @('Get-InboxRule -Mailbox jdoe@corp.com | Select-Object Name, Enabled, Priority, StopProcessingRules | Sort-Object Priority',0,'47 rules listed',''),
       @('Get-InboxRule -Mailbox jdoe@corp.com | Where-Object {-not $_.Enabled} | Remove-InboxRule -Confirm:$false',0,'',''));
   r='Export the full rule set first (Get-InboxRule | Export-Clixml) so it can be restored; removing disabled rules is the safest way to reclaim the 32 KB rules quota.'}
 @{d='outlook'; g='Fix meeting invitations being auto-deleted using Exchange PowerShell';
   s='Calendar auto-processing and a deleting inbox rule both act server-side, so both can be inspected and corrected from Exchange Online PowerShell rather than the client.';
   c=@(@('Get-CalendarProcessing -Identity jdoe@corp.com | Select-Object AutomateProcessing, DeleteMeetingRequests',0,'AutomateProcessing : AutoUpdate  DeleteMeetingRequests : True',''),
       @('Set-CalendarProcessing -Identity jdoe@corp.com -DeleteMeetingRequests $false',0,'',''),
       @('Get-InboxRule -Mailbox jdoe@corp.com | Where-Object DeleteMessage -eq $true | Select-Object Name',0,'ProcessInvites',''));
   r='For user mailboxes DeleteMeetingRequests should normally be False so the original invitation stays in the Inbox; True is intended for resource (room) mailboxes.'}
 @{d='outlook'; g='Grant shared mailbox access with automapping from PowerShell';
   s='Automapping only occurs when Full Access is granted directly to the user with automapping enabled - group-based access never automaps, which is why the mailbox never appears.';
   c=@(@('Get-MailboxPermission -Identity shared@corp.com | Where-Object {$_.User -like ''*jdoe*''} | Select-Object User, AccessRights',0,'(no direct entry - access via group)',''),
       @('Add-MailboxPermission -Identity shared@corp.com -User jdoe@corp.com -AccessRights FullAccess -AutoMapping $true',0,'',''));
   r='Automapping is cached in Outlook, so the client may need a restart or up to a few hours to show the mailbox; for large groups prefer manual mapping to avoid every member loading it.'}
 @{d='outlook'; g='Turn off a stuck Out of Office reply from PowerShell';
   s='Automatic replies are a server-side mailbox setting, so they can be inspected and disabled centrally even when the user cannot reach Outlook.';
   c=@(@('Get-MailboxAutoReplyConfiguration -Identity jdoe@corp.com | Select-Object AutoReplyState, StartTime, EndTime',0,'AutoReplyState : Scheduled  EndTime : 8/1/2026',''),
       @('Set-MailboxAutoReplyConfiguration -Identity jdoe@corp.com -AutoReplyState Disabled',0,'',''));
   r='A Scheduled state with a past EndTime should stop automatically - if replies still go out, check for a separate inbox rule sending a template, which behaves independently.'}
 @{d='outlook'; g='Remove stale mobile device partnerships causing calendar duplicates';
   s='Old ActiveSync partnerships keep applying conflicting changes; removing them from Exchange stops the duplicate generation at its source.';
   c=@(@('Get-MobileDevice -Mailbox jdoe@corp.com | Select-Object DeviceModel, DeviceOS, FirstSyncTime',0,'OldPhone  Android 9  2021-04-02',''),
       @('Get-MobileDeviceStatistics -Mailbox jdoe@corp.com | Select-Object DeviceModel, LastSuccessSync',0,'OldPhone  2024-03-11',''),
       @('Get-MobileDevice -Mailbox jdoe@corp.com | Where-Object DeviceModel -eq ''OldPhone'' | Remove-MobileDevice -Confirm:$false',0,'',''));
   r='Confirm the device is genuinely retired before removing the partnership; the duplicates already created still need cleaning up with the Outlook Clean Up tool.'}
 @{d='office'; g='Disable Office hardware graphics acceleration from the registry';
   s='Rendering artifacts and crashes on certain GPUs are fixed by disabling Office graphics acceleration, which is a single registry value rather than a per-app setting.';
   c=@(@('Get-ItemProperty ''HKCU:\Software\Microsoft\Office\16.0\Common\Graphics'' -Name DisableHardwareAcceleration -ErrorAction SilentlyContinue',1,'','(value not present)'),
       @('New-Item ''HKCU:\Software\Microsoft\Office\16.0\Common\Graphics'' -Force | Out-Null',0,'',''),
       @('Set-ItemProperty ''HKCU:\Software\Microsoft\Office\16.0\Common\Graphics'' -Name DisableHardwareAcceleration -Value 1 -Type DWord',0,'',''));
   r='Restart all Office apps for it to take effect; if rendering is still wrong, also update the GPU driver, since this setting only works around the driver rather than fixing it.'}
 @{d='office'; g='Reset a customized Office ribbon and Quick Access Toolbar from PowerShell';
   s='Ribbon and QAT customizations are stored in .officeUI files per application; deleting them restores the default layout without touching any other setting.';
   c=@(@('Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Office" -Filter ''*.officeUI'' -ErrorAction SilentlyContinue | Select-Object Name, Length',0,'Excel.officeUI  2048 / Word.officeUI  1536',''),
       @('Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Office" -Filter ''*.officeUI'' | Remove-Item -Force',0,'',''));
   r='Export the files first if the user wants their customizations back; they are plain XML and can simply be copied back into place.'}
 @{d='excel'; g='Clear cached Power Query data source credentials from PowerShell';
   s='Excel keeps data source credentials in its own per-user store, separate from Windows Credential Manager, so a Windows password change never updates them.';
   c=@(@('Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Office\16.0\PowerQuery" -Recurse -ErrorAction SilentlyContinue | Select-Object Name',0,'Credentials',''),
       @('Get-Process EXCEL -ErrorAction SilentlyContinue | Stop-Process -Force',0,'',''),
       @('Remove-Item "$env:LOCALAPPDATA\Microsoft\Office\16.0\PowerQuery\Credentials" -Recurse -Force -ErrorAction SilentlyContinue',0,'',''));
   r='All saved data source credentials are cleared, so the user re-enters them at the next refresh; note it down before clearing if there are many sources.'}
 @{d='office'; g='Fix an ODBC bitness mismatch by creating a matching 64-bit DSN from PowerShell';
   s='64-bit Office cannot see 32-bit DSNs. Recreating the same DSN name in the 64-bit hive lets the existing workbook connect without editing the file itself.';
   c=@(@('Get-OdbcDsn -Name ''SalesDB'' -ErrorAction SilentlyContinue | Select-Object Name, Platform, DriverName',0,'SalesDB  32-bit  SQL Server',''),
       @('Get-OdbcDriver -Platform ''64-bit'' | Where-Object Name -like ''*SQL Server*'' | Select-Object Name',0,'ODBC Driver 17 for SQL Server',''),
       @('Add-OdbcDsn -Name ''SalesDB'' -DriverName ''ODBC Driver 17 for SQL Server'' -DsnType ''System'' -Platform ''64-bit'' -SetPropertyValue @(''Server=sql01'', ''Database=Sales'')',0,'',''));
   r='Keep the DSN name identical to the 32-bit one so the workbook connection string still resolves; verify with Get-OdbcDsn -Platform 64-bit afterwards.'}
 @{d='onedrive'; g='Reset the OneDrive sync client from PowerShell when sync is stuck';
   s='OneDrive exposes a reset switch that rebuilds its local database without unlinking the account, which clears most stuck-sync states.';
   c=@(@('Get-Process OneDrive -ErrorAction SilentlyContinue | Select-Object Id, Responding',0,'9124  False',''),
       @('Get-Process OneDrive -ErrorAction SilentlyContinue | Stop-Process -Force',0,'',''),
       @('& "$env:LOCALAPPDATA\Microsoft\OneDrive\OneDrive.exe" /reset',0,'',''),
       @('Start-Sleep 15; Start-Process "$env:LOCALAPPDATA\Microsoft\OneDrive\OneDrive.exe"',0,'',''));
   r='After a reset OneDrive re-indexes everything, which can take a long time on large libraries but does not re-download files that are already present locally.'}
 @{d='office'; g='Set Outlook as the default mail client so mail merge and Send To work';
   s='The default mail client is a per-user file association; setting Outlook restores MAPI handoff for Word mail merge and Explorer Send To Mail recipient.';
   c=@(@('Get-ItemProperty ''HKCU:\Software\Clients\Mail'' -ErrorAction SilentlyContinue | Select-Object ''(default)''',0,'Mail (Windows Mail app)',''),
       @('Get-ChildItem ''HKLM:\SOFTWARE\Clients\Mail'' | Select-Object PSChildName',0,'Microsoft Outlook',''),
       @('Set-ItemProperty ''HKCU:\Software\Clients\Mail'' -Name ''(default)'' -Value ''Microsoft Outlook''',0,'',''));
   r='On Windows 11 the Default apps page also needs Outlook set for the MAILTO protocol; the registry value alone covers MAPI but not the protocol association.'}
 @{d='office'; g='Raise the WebDAV file size limit so large SharePoint uploads stop failing';
   s='Error 0x800700DF comes from the WebClient service size cap, which is a registry value the agent can raise and then restart the service to apply.';
   c=@(@('Get-ItemProperty ''HKLM:\SYSTEM\CurrentControlSet\Services\WebClient\Parameters'' -Name FileSizeLimitInBytes -ErrorAction SilentlyContinue',0,'FileSizeLimitInBytes : 50000000',''),
       @('Set-ItemProperty ''HKLM:\SYSTEM\CurrentControlSet\Services\WebClient\Parameters'' -Name FileSizeLimitInBytes -Value 4294967295 -Type DWord',0,'',''),
       @('Restart-Service WebClient -Force',0,'',''));
   r='Prefer the OneDrive sync client for large files - WebDAV mapping stays slow and fragile even with the limit raised.'}
 @{d='excel'; g='Find and remove stale Office lock files across an entire file share';
   s='Owner files left by crashed clients block editing for everyone. Enumerating and removing them across the share clears every stale lock in one pass.';
   c=@(@('Get-ChildItem ''\\fileserver\finance'' -Filter ''~$*'' -Recurse -Force -ErrorAction SilentlyContinue | Select-Object FullName, LastWriteTime',0,'6 owner files, oldest from 3 weeks ago',''),
       @('Get-SmbOpenFile -ErrorAction SilentlyContinue | Where-Object Path -like ''*finance*'' | Select-Object ClientUserName, Path',0,'(no live handles)',''),
       @('Get-ChildItem ''\\fileserver\finance'' -Filter ''~$*'' -Recurse -Force | Where-Object LastWriteTime -lt (Get-Date).AddDays(-1) | Remove-Item -Force',0,'',''));
   r='Only delete owner files with no matching open handle on the server and older than the working day, so an actively open document is never disturbed.'}
 @{d='office'; g='Configure Office diagnostic data level centrally to stop first-run privacy prompts';
   s='The privacy prompts appear because the policy is unset; writing the policy values answers it for every user without touching each machine interactively.';
   c=@(@('Get-ItemProperty ''HKCU:\Software\Policies\Microsoft\office\16.0\common\privacy'' -ErrorAction SilentlyContinue',1,'','(policy not configured)'),
       @('New-Item ''HKCU:\Software\Policies\Microsoft\office\16.0\common\privacy'' -Force | Out-Null',0,'',''),
       @('Set-ItemProperty ''HKCU:\Software\Policies\Microsoft\office\16.0\common\privacy'' -Name disconnectedstate -Value 2 -Type DWord',0,'',''));
   r='Deploy this through Group Policy or Intune rather than per-machine registry edits, so the setting is documented and consistently applied.'}
 @{d='outlook'; g='Disable Cached Exchange Mode for a mailbox that is too large for the local OST';
   s='Cached mode downloads the whole mailbox; switching the profile to online mode removes the OST dependency, which is a registry setting on the profile.';
   c=@(@('Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Outlook" -Filter ''*.ost'' | Select-Object Name, @{N=''GB'';E={[math]::Round($_.Length/1GB,1)}}',0,'jdoe@corp.com.ost  48.2',''),
       @('Get-PSDrive C | Select-Object @{N=''FreeGB'';E={[int]($_.Free/1GB)}}',0,'FreeGB : 11',''));
   r='Online mode requires constant connectivity and is slower for search; the better fix is usually reducing the Mail to keep offline slider to a few months rather than disabling cached mode entirely.'}
 @{d='teams'; g='Remove and reinstall the new Teams client from PowerShell';
   s='New Teams is an MSIX package, so it can be removed and reinstalled per-user entirely from PowerShell when a cache clear is not enough.';
   c=@(@('Get-AppxPackage -Name ''MSTeams'' | Select-Object Name, Version, Status',0,'MSTeams  24193.1805.3040.8975  Modified',''),
       @('Get-AppxPackage -Name ''MSTeams'' | Remove-AppxPackage',0,'',''),
       @('Get-AppxPackage -AllUsers -Name ''MSTeams'' | ForEach-Object { Add-AppxPackage -DisableDevelopmentMode -Register "$($_.InstallLocation)\AppXManifest.xml" }',0,'',''));
   r='Removing the package does not delete chat history, which lives server-side; if the re-register fails, install the Teams bootstrapper with the -p switch to provision it machine-wide.'}
 @{d='office'; g='Detect which Office bitness and build is installed before troubleshooting';
   s='Many Office issues (add-ins, ODBC, memory limits) depend on bitness and channel, so establishing them first prevents chasing the wrong fix.';
   c=@(@('Get-ItemProperty ''HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration'' | Select-Object Platform, VersionToReport, UpdateChannel, ProductReleaseIds',0,'Platform : x64  VersionToReport : 16.0.17328.20124  UpdateChannel : .../MonthlyEnterprise',''),
       @('Get-ChildItem ''HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object DisplayName -like ''*Microsoft 365*'' | Select-Object DisplayName, DisplayVersion',0,'Microsoft 365 Apps for enterprise - en-us  16.0.17328.20124',''));
   r='Record Platform and UpdateChannel at the start of any Office case - a 32-bit install on a 64-bit OS explains an entire class of add-in and memory problems immediately.'}
 @{d='office'; g='Close all Office applications safely from PowerShell before a repair';
   s='Repairs and cache clears fail while any Office process holds files. Closing them gracefully first, then force-killing only what remains, avoids unnecessary data loss.';
   c=@(@('Get-Process WINWORD,EXCEL,POWERPNT,OUTLOOK,MSACCESS,ONENOTE,ms-teams -ErrorAction SilentlyContinue | Select-Object Name, Id, Responding',0,'WINWORD 6120 True / OUTLOOK 4412 True',''),
       @('Get-Process WINWORD,EXCEL,POWERPNT,OUTLOOK -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }',0,'',''),
       @('Start-Sleep 8; Get-Process WINWORD,EXCEL,POWERPNT,OUTLOOK -ErrorAction SilentlyContinue | Stop-Process -Force',0,'',''));
   r='CloseMainWindow lets each app prompt to save; only force-kill after a grace period, and never force-kill Outlook mid-sync if a large OST is being rebuilt.'}
 @{d='office'; g='Some Office problems cannot be fixed from PowerShell -- recognizing them';
   s='Certain issues are outside any scriptable surface: subscription entitlement, tenant-side licensing, and content damage inside a document body. The correct action is to establish that clearly and hand off rather than attempting registry workarounds.';
   c=@(@('Get-ItemProperty ''HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration'' -Name ProductReleaseIds -ErrorAction SilentlyContinue',0,'ProductReleaseIds : O365ProPlusRetail',''),
       @('Test-NetConnection licensing.mp.microsoft.com -Port 443',0,'TcpTestSucceeded : True',''));
   r='When the client is healthy and connectivity is fine, the blocker is entitlement on the tenant side - direct the user to the Microsoft 365 admin centre for license assignment instead of local troubleshooting.'}
 @{d='outlook'; g='Verify Autodiscover end to end from PowerShell before blaming the client';
   s='Autodiscover failures look like Outlook faults but are usually DNS or endpoint reachability. Testing each layer separately identifies which one is actually broken.';
   c=@(@('Resolve-DnsName autodiscover.corp.com -ErrorAction SilentlyContinue | Select-Object Name, Type, NameHost',0,'autodiscover.corp.com  CNAME  autodiscover.outlook.com',''),
       @('Test-NetConnection autodiscover.outlook.com -Port 443',0,'TcpTestSucceeded : True',''),
       @('Resolve-DnsName -Type SRV _autodiscover._tcp.corp.com -ErrorAction SilentlyContinue',1,'','(no SRV record - CNAME method in use)'));
   r='A working CNAME to autodiscover.outlook.com plus reachable 443 means the client side is fine; if both pass and Outlook still fails, test with the Microsoft Remote Connectivity Analyzer next.'}
 @{d='excel'; g='Check whether an Excel workbook is genuinely corrupt or just very large';
   s='Slow opens and hangs are often size rather than corruption. Inspecting the package structure distinguishes the two before attempting any recovery that could lose data.';
   c=@(@('Get-Item ''C:\Reports\Model.xlsx'' | Select-Object @{N=''MB'';E={[math]::Round($_.Length/1MB,1)}}, LastWriteTime',0,'MB : 184.2',''),
       @('Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(''C:\Reports\Model.xlsx''); $z.Entries.Count; $z.Dispose()',0,'742',''));
   r='If the package opens as a valid ZIP with a sensible entry count, the file is intact and the problem is size or formulas - do not run repair tooling, which can discard content unnecessarily.'}
)

# ---------------------------------------------------------------------------
if (-not (Test-Path $JsonlPath)) { throw "Not found: $JsonlPath  (run this in the folder with repair-dataset.jsonl)" }

Write-Host "Loading $JsonlPath ..." -ForegroundColor Cyan
$lines = @(Get-Content $JsonlPath -Encoding UTF8 | Where-Object { $_.Trim() })
Write-Host ("Existing entries: {0}" -f $lines.Count) -ForegroundColor Cyan

$existing = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($l in $lines) { try { [void]$existing.Add((($l | ConvertFrom-Json).messages | Where-Object role -eq 'user').content) } catch {} }

Copy-Item $JsonlPath "$JsonlPath.bak2" -Force
Write-Host "Backup: $JsonlPath.bak2" -ForegroundColor DarkGray

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

if (Test-Path $JsonPath) {
    Write-Host "`nUpdating $JsonPath ..." -ForegroundColor Cyan
    Copy-Item $JsonPath "$JsonPath.bak2" -Force
    $data = [System.Collections.ArrayList]@(Get-Content $JsonPath -Raw | ConvertFrom-Json)
    $have = @{}; foreach ($d in $data) { $have[$d.goal] = $true }
    $ids = @{}; foreach ($d in $data) { $ids[$d.id] = $true }
    $n = 1; $jAdded = 0
    $base = Get-Date '2026-08-06T09:00:00Z'
    foreach ($e in $NEW) {
        if ($have.ContainsKey($e.g)) { continue }
        while ($ids.ContainsKey(("new-win-repair-{0:d3}" -f $n))) { $n++ }
        $id = "new-win-repair-{0:d3}" -f $n; $ids[$id] = $true
        $t = $base.AddMinutes(5 * $jAdded)
        $steps = @($e.c | ForEach-Object { [ordered]@{ command=$_[0]; blocked=$false; exitCode=$_[1]; stdout=$_[2]; stderr=$_[3]; reason=$null } })
        [void]$data.Add([ordered]@{
            id=$id; createdAt=$t.ToString('yyyy-MM-ddTHH:mm:ss.000Z'); goal=$e.g; domain=$e.d
            plan=@('Confirm the state with read-only checks','Perform the fix from PowerShell where the surface allows it','Verify the result or explain what must be done outside PowerShell')
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
