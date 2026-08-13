import json, difflib
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

# (domain, goal, summary, [(cmd, exitCode, stdout, stderr)], recommendation)
NEW = [
# ================= BROWSER =================
("browser","Chrome shows ERR_CERT_AUTHORITY_INVALID on every HTTPS site but Edge works fine",
 "Chrome uses its own certificate verifier with a built-in root store on current versions, while Edge falls back to the Windows store. The corporate TLS-inspection root CA is installed in the Windows store only, so Chrome rejects every re-signed certificate.",
 [("Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object Subject -like '*CorpProxy*' | Select-Object Subject, NotAfter",0,"Subject: CN=CorpProxy Root CA  NotAfter: 2029-01-01",""),
  ("reg query 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome' /v ChromeRootStoreEnabled",1,"","ERROR: The system was unable to find the specified registry key or value.")],
 "Deploy the Chrome policy ChromeRootStoreEnabled=0 (HKLM\\SOFTWARE\\Policies\\Google\\Chrome) so Chrome trusts the Windows root store, or push the corporate CA into Chrome's own store via the ADMX 'CACertificates' policy -- never train users to click through cert warnings."),
("browser","Edge and Chrome both fail to load any page while other apps have internet -- ERR_PROXY_CONNECTION_FAILED",
 "Both browsers honor the WinINET/WinHTTP system proxy, which points at a dead local port left behind by an uninstalled security product. Non-browser apps using their own sockets bypass the proxy, which is why only browsing broke.",
 [("netsh winhttp show proxy",0,"Proxy Server(s) : 127.0.0.1:9090\nBypass List : (none)",""),
  ("Get-NetTCPConnection -LocalPort 9090 -ErrorAction SilentlyContinue",1,"","(no listener on 9090)"),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyEnable, ProxyServer",0,"ProxyEnable : 1\nProxyServer : 127.0.0.1:9090","")],
 "Clear both layers: 'netsh winhttp reset proxy' plus setting ProxyEnable=0 under HKCU Internet Settings, then restart the browsers; a leftover PAC/AutoConfigURL value should also be removed if present."),
("browser","Browsers redirect searches to an unknown engine and a policy banner says the browser is 'managed'",
 "Enterprise policy keys were written into HKLM\\SOFTWARE\\Policies\\Google\\Chrome by adware, which pins the search provider and homepage and blocks the user from changing them -- the 'managed by your organization' banner is the giveaway on a personal PC.",
 [("Get-ChildItem 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome' | Select-Object Name",0,"Name\n----\nDefaultSearchProviderSearchURL\nHomepageLocation\nExtensionInstallForcelist",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome' -Name ExtensionInstallForcelist -ErrorAction SilentlyContinue",0,"ExtensionInstallForcelist : {1 -> hjkl...;https://unknown-cdn/update.xml}","")],
 "Export the keys for reference, remove the adware policy keys under HKLM\\SOFTWARE\\Policies\\Google\\Chrome and \\Microsoft\\Edge, then run a full Defender offline scan -- force-installed extensions usually mean a dropper is still present."),
("browser","Chrome/Edge downloads always fail at the last second with 'Failed - Network error' on large files",
 "The download completes into a temp .crdownload file, but the real-time antivirus scanner's on-close inspection times out on large files and returns a failure to the browser, which reports it as a network error.",
 [("Get-MpPreference | Select-Object ScanOnRealtimeEnable, DisableScanningNetworkFiles",0,"ScanOnRealtimeEnable : True\nDisableScanningNetworkFiles : False",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1150} -MaxEvents 2 -ErrorAction SilentlyContinue",0,"Scan timed out on file <user>\\Downloads\\installer.iso.crdownload","")],
 "Add the Downloads folder as a temporary Defender exclusion for large transfers (remove it afterward), or use a download manager that writes directly; if a third-party AV is installed, raise its large-file scan timeout instead."),
("browser","Every browser reports ERR_NAME_NOT_RESOLVED for internal sites only, while public sites resolve",
 "The browsers' Secure DNS (DNS-over-HTTPS) setting sends all lookups to a public resolver, which has no knowledge of the internal AD zone -- Windows itself resolves internal names correctly, so only browser traffic fails.",
 [("Resolve-DnsName intranet.corp.local",0,"Name: intranet.corp.local  IPAddress: 10.0.5.20",""),
  ("Get-DnsClientDohServerAddress | Select-Object ServerAddress, DohTemplate",0,"ServerAddress: 1.1.1.1  DohTemplate: https://cloudflare-dns.com/dns-query","")],
 "Disable Secure DNS in the browsers (or set the Chrome/Edge DnsOverHttpsMode policy to 'off'/'automatic' on domain-joined machines) so split-horizon internal zones resolve through the corporate resolver."),
("browser","Edge WebView2-based apps (Teams, Outlook new) render blank white windows",
 "The apps host content in the Evergreen WebView2 runtime; its version is older than the apps require after an update, so the renderer process starts and immediately exits, leaving a blank host window.",
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -Name pv -ErrorAction SilentlyContinue",0,"pv : 109.0.1518.78",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"Faulting application: msedgewebview2.exe","")],
 "Install the current Evergreen WebView2 Runtime from Microsoft's official page (or repair it via Apps > Microsoft Edge WebView2 Runtime > Modify), then relaunch the affected apps."),
("browser","Firefox can't use the corporate proxy's Kerberos SSO -- constant authentication prompts",
 "Firefox maintains its own network stack and doesn't perform integrated Windows authentication unless the target host is explicitly listed in its negotiate-auth trusted URIs -- Chrome/Edge use the OS stack and work by default.",
 [("klist | Select-String 'Server:'",0,"Server: HTTP/proxy.corp.local @ CORP.LOCAL (valid ticket present)","")],
 "Set network.negotiate-auth.trusted-uris to the proxy/intranet domains in a Firefox enterprise policy (policies.json or the ADMX 'Authentication' policy); the Kerberos ticket already exists, Firefox just needs permission to use it."),
("browser","Browser profile is locked -- 'Chrome is already running but is not responding' with no visible window",
 "A background renderer/utility process still holds the profile's SingletonLock, so new launches refuse to open rather than corrupt the profile -- a protective behavior, not corruption yet.",
 [("Get-Process chrome -ErrorAction SilentlyContinue | Select-Object Id, MainWindowTitle",0,"Id    MainWindowTitle\n--    ---------------\n8120  (blank -- background process only)",""),
  ("Test-Path \"$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\SingletonLock\"",0,"True","")],
 "End all chrome.exe processes ('Get-Process chrome | Stop-Process -Force'), delete the stale SingletonLock/SingletonSocket files if they persist, then relaunch; recurring locks point at an extension keeping a background page alive."),
# ================= AUTOMATIC APPS & WINDOWS UPDATE VIA POWERSHELL =================
("update-automation","Need to install all pending Windows updates non-interactively from PowerShell on a fleet of servers",
 "The built-in Windows Update UI isn't scriptable, so the PSWindowsUpdate module was used to enumerate, filter, and install approved updates while suppressing automatic reboots so a maintenance window controls restarts.",
 [("Get-Module -ListAvailable PSWindowsUpdate",1,"","(module not installed)"),
  ("Install-Module PSWindowsUpdate -Scope AllUsers -Force -AcceptLicense",0,"",""),
  ("Get-WindowsUpdate -MicrosoftUpdate | Select-Object KB, Title, Size",0,"KB5034123  2026-07 Cumulative Update  ~680MB",""),
  ("Install-WindowsUpdate -MicrosoftUpdate -AcceptAll -IgnoreReboot -Verbose",0,"Installed: KB5034123 (reboot required, suppressed)","")],
 "Use -IgnoreReboot in automation and drive restarts from your maintenance orchestration; log results with 'Get-WUHistory' so each server's applied KBs are auditable afterward."),
("update-automation","Windows Update automation fails silently on some machines -- COM API returns 0x80240438",
 "0x80240438 (WU_E_PT_ENDPOINT_UNREACHABLE) means the update agent can't reach its configured service endpoint. These machines are pointed at a decommissioned WSUS server via policy, so any API-driven install fails before it starts.",
 [("$s=New-Object -ComObject Microsoft.Update.Session; $s.CreateUpdateSearcher().Search('IsInstalled=0')",1,"","Exception ... 0x80240438"),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate' -Name WUServer, UseWUServer",0,"WUServer : http://old-wsus.corp.local:8530\nUseWUServer : 1","")],
 "Repoint or remove the WSUS policy (delete WUServer/WUStatusServer and set UseWUServer=0 to use Microsoft Update), restart wuauserv, then re-run the automation; verify with 'Get-WindowsUpdateLog'."),
("update-automation","Need to script automatic app updates for everything installed via winget across user machines",
 "winget's upgrade --all is scriptable but skips packages with unknown versions and interactive installers; adding the right flags and running in the correct user context made the unattended run complete cleanly.",
 [("winget upgrade --include-unknown",0,"12 upgrades available (3 require interactive installers)",""),
  ("winget upgrade --all --include-unknown --silent --accept-package-agreements --accept-source-agreements --disable-interactivity",0,"Successfully installed 9 of 12; 3 skipped (interactive required)","")],
 "Schedule it as a logged-on-user task (winget needs a user context for MSIX/user-scope packages), pin known-problem packages with --exclude, and handle the interactive stragglers separately via their vendor updaters."),
("update-automation","Scheduled PowerShell update script works when run manually but does nothing under Task Scheduler",
 "The task ran as SYSTEM in a 32-bit host with no user profile, so the module installed under the admin's per-user path wasn't on PSModulePath and the import silently failed before any update logic ran.",
 [("Get-ScheduledTask -TaskName 'PatchNightly' | Select-Object -ExpandProperty Actions | Select-Object Execute, Arguments",0,"Execute: C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe",""),
  ("Get-ChildItem 'C:\\Users\\admin\\Documents\\WindowsPowerShell\\Modules\\PSWindowsUpdate' | Select-Object Name",0,"(module lives only in the admin's per-user path)","")],
 "Point the action at the 64-bit host (C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe), install modules with -Scope AllUsers, and add explicit Import-Module plus transcript logging so silent failures become visible."),
("update-automation","Need to block a specific driver update from reinstalling itself after every removal",
 "Windows Update kept re-offering the faulty driver because nothing marked it as unwanted; hiding the specific update and disabling driver offerings for that device stopped the reinstall loop.",
 [("pnputil /delete-driver oem42.inf /uninstall /force",0,"Driver package deleted successfully.",""),
  ("Get-WindowsUpdate -MicrosoftUpdate | Where-Object Title -match 'Realtek'",0,"KB5008888 Realtek - Media - 6.0.9401.1 (offered again)",""),
  ("Hide-WindowsUpdate -KBArticleID KB5008888 -Confirm:$false",0,"","")],
 "Combine Hide-WindowsUpdate with the 'Prevent installation of devices that match these device IDs' policy for the specific hardware ID -- hiding alone can be reversed by a later update revision."),
("update-automation","Automatic app updates saturate the network every morning at the same time",
 "Multiple auto-updaters (Store, winget task, and two vendor updaters) all trigger near logon, and Delivery Optimization was set to download from the internet only rather than peer-caching on the LAN.",
 [("Get-DeliveryOptimizationStatus | Select-Object -First 1 DownloadMode, DownloadModeSrc",0,"DownloadMode : 0 (HTTP only)",""),
  ("Get-ScheduledTask | Where-Object {$_.TaskName -match 'Update' -and $_.State -eq 'Ready'} | Select-Object TaskName, TaskPath",0,"5 update tasks all triggered AtLogon","")],
 "Set Delivery Optimization to LAN peering, stagger the tasks with random delays (Set-ScheduledTask trigger RandomDelay), and set an absolute bandwidth cap via the DO policies so morning logons stop competing."),
# ================= GROUP POLICY RESTRICTIONS =================
("gpo-restriction","Task Manager is disabled -- 'Task Manager has been disabled by your administrator'",
 "The DisableTaskMgr policy value is set under the System policies key. On a domain machine this comes from GPO; here it was written locally by a 'tweak' script, so removing the value restores access.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name DisableTaskMgr",0,"DisableTaskMgr : 1",""),
  ("gpresult /r /scope:user | Select-String 'Applied Group Policy Objects' -Context 0,5",0,"N/A (machine is not domain-joined)","")],
 "Remove the value ('Remove-ItemProperty ... -Name DisableTaskMgr') and reboot; if the machine is domain-joined the setting will return -- it must be changed in the GPO by whoever owns the policy."),
("gpo-restriction","Registry Editor won't open -- 'Registry editing has been disabled by your administrator'",
 "DisableRegistryTools is set in the user's System policies key. Because regedit itself is blocked, the value must be cleared by another mechanism -- PowerShell's registry provider still works since it doesn't use regedit.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name DisableRegistryTools",0,"DisableRegistryTools : 1",""),
  ("Remove-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name DisableRegistryTools",0,"","")],
 "Clear it via PowerShell (as done here) or 'reg delete' -- both bypass the regedit-specific block; on managed machines request the change through the GPO instead of local edits, which will be re-applied."),
("gpo-restriction","Control Panel and Settings are both blocked -- 'This operation has been cancelled due to restrictions'",
 "NoControlPanel is set in the Explorer policies key, which blocks both the legacy Control Panel and the modern Settings app since they share the same policy gate.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer' -Name NoControlPanel",0,"NoControlPanel : 1",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer' -Name NoControlPanel -ErrorAction SilentlyContinue",1,"","(not set at machine level)")],
 "Remove the per-user NoControlPanel value and sign out/in. If it reappears, check both HKCU and HKLM plus 'gpresult /h' to find which GPO sets it -- policy wins over any local change."),
("gpo-restriction","USB storage devices are blocked -- drives appear in Device Manager but not in Explorer",
 "The USBSTOR service start type is set to 4 (disabled) by policy, so the storage driver never loads for removable media while other USB classes (mouse, keyboard) continue working.",
 [("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\USBSTOR' -Name Start",0,"Start : 4",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\RemovableStorageDevices\\{53f56307-b6bf-11d0-94f2-00a0c91efb8b}' -Name Deny_All -ErrorAction SilentlyContinue",0,"Deny_All : 1","")],
 "This is a deliberate data-loss-prevention control on managed machines -- request an exception from IT rather than re-enabling locally; on a personal PC set USBSTOR Start=3 and remove the RemovableStorageDevices Deny_All policy."),
("gpo-restriction","Command Prompt and PowerShell are blocked by policy for standard users",
 "DisableCMD=2 blocks cmd.exe including scripts, and a separate AppLocker rule blocks powershell.exe -- two independent controls, which is why removing one didn't restore access.",
 [("Get-ItemProperty 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\System' -Name DisableCMD",0,"DisableCMD : 2",""),
  ("Get-AppLockerPolicy -Effective -Xml | Select-String 'powershell.exe'",0,"Deny rule matching %SYSTEM32%\\WindowsPowerShell\\v1.0\\powershell.exe","")],
 "On managed endpoints these are intentional -- request a scoped exception (e.g., an AppLocker publisher allow rule plus DisableCMD=0 for a specific OU/group) rather than local workarounds, which AppLocker will keep blocking anyway."),
("gpo-restriction","A GPO applies on most machines but is silently skipped on a few -- security filtering vs WMI filter",
 "gpresult showed the GPO filtered out for two different reasons on two machines: one failed the WMI filter (wrong OS build), the other lacked Read+Apply in security filtering -- distinguishing them is essential because the fixes differ.",
 [("gpresult /r /scope:computer",0,"The following GPOs were not applied because they were filtered out: 'Baseline' (Filtering: Denied (Security)); 'AppConfig' (Filtering: Denied (WMI Filter))",""),
  ("Get-GPPermission -Name 'Baseline' -All | Where-Object {$_.Trustee.Name -match 'Domain Computers'}",1,"","(no permission entry found for Domain Computers)")],
 "Fix each separately: grant Read + Apply Group Policy for the target computer group on the Baseline GPO, and correct the WMI filter's WQL query for AppConfig; 'gpresult /h report.html' documents both reasons clearly."),
("gpo-restriction","Group Policy Preferences item applies once then stops re-applying after users change it back",
 "The GP Preference item was created with 'Apply once and do not reapply' enabled, so users' local changes persist -- the policy isn't broken, it's configured as a one-time action.",
 [("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-GroupPolicy/Operational'; Id=5312} -MaxEvents 3",0,"Preference item applied (Apply once) -- subsequent refreshes skip the item","")],
 "Clear the 'Apply once and do not reapply' checkbox in the preference item's Common tab (and delete the tracking value under HKCU ...\\Group Policy\\Client\\RunOnce so it re-evaluates), or use a true Policy setting if enforcement is the goal."),
# ================= REGISTRY EDITOR =================
("registry","Cannot edit a registry key even as Administrator -- 'Cannot edit: Error writing the value's new contents'",
 "The key's ACL grants ownership to SYSTEM/TrustedInstaller with Administrators having read-only, so writes fail regardless of elevation -- the classic protected-key pattern.",
 [("Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\WinDefend' -Name Start -Value 4",1,"","Set-ItemProperty : Requested registry access is not allowed."),
  ("(Get-Acl 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\WinDefend').Owner",0,"NT SERVICE\\TrustedInstaller","")],
 "Some keys are protected deliberately (Defender's service config is tamper-protected -- disable Tamper Protection through Windows Security instead). Where taking ownership is legitimate, do it explicitly and restore original ACLs afterward."),
("registry","A registry value reverts within seconds of being changed -- something is watching and rewriting it",
 "A running service rewrites the value on a timer; monitoring showed the write originating from the vendor agent's process, so editing the registry directly can never win against it.",
 [("Set-ItemProperty 'HKLM:\\SOFTWARE\\Vendor\\Agent' -Name Telemetry -Value 0",0,"",""),
  ("Start-Sleep 20; Get-ItemProperty 'HKLM:\\SOFTWARE\\Vendor\\Agent' -Name Telemetry",0,"Telemetry : 1 (reverted)",""),
  ("Get-Service | Where-Object {$_.Status -eq 'Running' -and $_.Name -match 'Vendor'} | Select-Object Name",0,"Name\n----\nVendorAgentSvc","")],
 "Change the setting through the owning product's own configuration (or stop/disable its service if the setting is unsupported); registry edits fighting a live enforcement agent will always be reverted."),
("registry","Need to safely edit another user's registry hive while they're logged off",
 "The user's HKCU only exists when they're logged on, so their NTUSER.DAT was loaded manually to a temporary hive path, modified, and unloaded cleanly -- editing the file directly would corrupt it.",
 [("reg load HKLM\\TempHive 'C:\\Users\\jdoe\\NTUSER.DAT'",0,"The operation completed successfully.",""),
  ("Set-ItemProperty 'HKLM:\\TempHive\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name DisableTaskMgr -Value 0",0,"",""),
  ("[gc]::Collect(); reg unload HKLM\\TempHive",0,"The operation completed successfully.","")],
 "Always unload the hive when done (a leaked PowerShell handle blocks unload -- hence the GC call), and never edit NTUSER.DAT with a text/binary editor; confirm the user is truly logged off first with 'quser'."),
("registry","Registry corruption suspected -- need to verify hive integrity before making changes",
 "Rather than guessing, the hive files' sizes and the log/backup state were checked and a System Restore point created, establishing a rollback path before any modification.",
 [("Get-ChildItem 'C:\\Windows\\System32\\config' | Where-Object Name -in 'SYSTEM','SOFTWARE','SAM' | Select-Object Name, Length",0,"SYSTEM 25165824\nSOFTWARE 134217728\nSAM 65536",""),
  ("Checkpoint-Computer -Description 'Before registry change' -RestorePointType MODIFY_SETTINGS",0,"",""),
  ("reg export 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies' C:\\Backup\\policies.reg /y",0,"The operation completed successfully.","")],
 "Make this the standard pre-change ritual: restore point + targeted .reg export of the exact subtree you're touching, so any bad edit is a two-minute rollback instead of a rebuild."),
("registry","Orphaned uninstall entries clutter Apps & Features for software that's already gone",
 "The Uninstall keys still hold entries whose UninstallString points at missing executables, so Windows lists apps it can't remove -- leftovers from installers that were deleted rather than uninstalled.",
 [("Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { $p=(Get-ItemProperty $_.PSPath); if($p.UninstallString -and -not (Test-Path ($p.UninstallString -replace '\"','' -split ' ')[0] -ErrorAction SilentlyContinue)){$p.DisplayName} }",0,"OldTool 2019\nVendorHelper",""),
  ("Remove-Item 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{OLD-GUID}' -Recurse",0,"","")],
 "Verify each UninstallString target is genuinely missing before deleting the key (export first), and check both the 64-bit and WOW6432Node Uninstall paths -- entries commonly hide in the 32-bit view."),
# ================= REMOTE ACCESS / RDP =================
("remote","RDP fails with 'The remote computer requires Network Level Authentication, which your computer doesn't support'",
 "The server enforces NLA, and this client's CredSSP/TLS configuration is too restricted to complete pre-authentication -- an older client stack or a hardening policy that disabled the required security package.",
 [("Test-NetConnection rdp-host.corp.local -Port 3389",0,"TcpTestSucceeded : True",""),
  ("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa' -Name Security Packages -ErrorAction SilentlyContinue",0,"(tspkg missing from Security Packages)","")],
 "Restore the required security packages (tspkg/credssp) on the client and update it fully; disabling NLA on the server would 'fix' the symptom while exposing the logon screen to unauthenticated connections -- avoid that."),
("remote","RDP connects then immediately disconnects with 'The connection was ended because of a network error'",
 "The session terminates during the licensing handshake: the RD Session Host's grace period expired and no license server is reachable, so every connection is dropped right after authentication.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-TerminalServices-RemoteConnectionManager'} -MaxEvents 3",0,"The RD Licensing grace period has expired and the service has not registered with a license server",""),
  ("Test-NetConnection rdlic01.corp.local -Port 135",1,"","TcpTestSucceeded : False")],
 "Restore connectivity to the RD Licensing server and confirm CALs are installed/assigned; for a single-admin scenario, two concurrent admin sessions are allowed without a license server (mstsc /admin) as a stopgap."),
("remote","Remote Desktop works by IP but fails by hostname with 'An authentication error has occurred'",
 "Kerberos requires a matching SPN for the hostname used; the host's SPN is registered under a stale duplicate computer object, so name-based connections fail authentication while IP-based ones fall back to NTLM and succeed.",
 [("setspn -L RDP-HOST01",0,"TERMSRV/RDP-HOST01\nTERMSRV/rdp-host01.corp.local",""),
  ("setspn -X",0,"Duplicate SPN found: TERMSRV/RDP-HOST01 on CORP\\RDP-HOST01 and CORP\\RDP-HOST01-OLD","")],
 "Delete the stale duplicate computer object (or remove its SPNs), then retry by hostname; duplicate TERMSRV SPNs are the standard cause of 'works by IP, fails by name' RDP authentication errors."),
("remote","RDP session opens to a black screen and then times out -- no desktop appears",
 "Authentication succeeds but the shell never initializes because the user's profile fails to load on the host; the session sits at a black screen until the client timeout.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-User Profiles Service'} -MaxEvents 3",0,"Windows cannot load the user's profile but has logged you on with a temporary profile (1511)",""),
  ("Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList' | Select-Object Name",0,"...S-1-5-21-...-1105\n...S-1-5-21-...-1105.bak","")],
 "Fix the profile on the host (resolve the .bak ProfileList duplicate, or reset the roaming/FSLogix profile), and as a diagnostic, connect with mstsc /admin which uses session 0 and can bypass some shell-load failures."),
("remote","WinRM-based remote management fails with 'The WinRM client cannot process the request' -- Kerberos vs workgroup",
 "The target is a workgroup machine, so Kerberos is impossible and WinRM refuses NTLM to an untrusted host by default -- explicit TrustedHosts plus credentials are required for non-domain remoting.",
 [("Test-WSMan -ComputerName 192.168.1.77",1,"","The WinRM client cannot process the request. Default authentication may be used with an IP address ... add the destination to TrustedHosts"),
  ("Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value '192.168.1.77' -Concatenate -Force",0,"",""),
  ("Test-WSMan -ComputerName 192.168.1.77 -Credential (Get-Credential) -Authentication Negotiate",0,"wsmid : ... (success)","")],
 "Prefer HTTPS WinRM with a certificate for workgroup targets rather than broad TrustedHosts entries; keep TrustedHosts scoped to specific addresses and clear it when the work is done."),
("remote","Remote Desktop Gateway connections fail with 0x800404B while direct RDP inside the LAN works",
 "The RD Gateway rejects the connection because its SSL certificate's subject doesn't match the external name clients use, so the TLS tunnel that carries RDP is never established -- internal direct RDP bypasses the gateway entirely.",
 [("Test-NetConnection rdgw.company.com -Port 443",0,"TcpTestSucceeded : True",""),
  ("(Invoke-WebRequest https://rdgw.company.com -SkipCertificateCheck).BaseResponse.RequestMessage.RequestUri",0,"Certificate CN=rdgw-internal.corp.local (name mismatch with rdgw.company.com)","")],
 "Reissue the gateway certificate with the external FQDN (or a SAN covering it) and bind it in RD Gateway Manager; clients validate the external name, so an internal-only CN can never satisfy them."),
# ================= SERVER NOT OPENING / SERVICE ENDPOINTS =================
("server","A web app's server won't start -- port already in use but no obvious process owns it",
 "The port is held by a reserved exclusion range (not a running process), so binding fails even though nothing is listening -- Hyper-V/WSL dynamic port reservations are the usual cause after a reboot.",
 [("Get-NetTCPConnection -LocalPort 5000 -ErrorAction SilentlyContinue",1,"","(no listener found)"),
  ("netsh int ipv4 show excludedportrange protocol=tcp",0,"Start Port    End Port\n----------    --------\n      4990        5089  *","")],
 "Move the app to a port outside the excluded ranges, or reserve your port explicitly ('netsh int ipv4 add excludedportrange protocol=tcp startport=5000 numberofports=1') before Hyper-V grabs it at boot."),
("server","A local development server starts but is unreachable from other devices on the LAN",
 "The app is bound to the loopback interface only (127.0.0.1), so it accepts local connections and refuses everything else -- the firewall was never the issue.",
 [("Get-NetTCPConnection -LocalPort 8000 | Select-Object LocalAddress, State",0,"LocalAddress State\n------------ -----\n127.0.0.1    Listen",""),
  ("Test-NetConnection 192.168.1.42 -Port 8000",1,"","TcpTestSucceeded : False")],
 "Bind the server to 0.0.0.0 (or the LAN IP) in its own configuration, then add the inbound firewall rule; binding must change first, since a firewall rule can't expose a loopback-only listener."),
("server","A Windows service starts and stops immediately with error 1053 'The service did not respond in a timely fashion'",
 "Error 1053 means the service process didn't signal the Service Control Manager in time -- here because the service's .NET runtime dependency is missing, so it crashes during startup before reporting ready.",
 [("Start-Service AppBackendSvc",1,"","Start-Service : Failed to start service 'AppBackendSvc'. Error 1053"),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1026} -MaxEvents 1",0,"Unhandled exception: System.IO.FileNotFoundException: Could not load file or assembly 'Microsoft.Extensions.Hosting'",""),
  ("dotnet --list-runtimes",0,"(no matching runtime version installed)","")],
 "Install the exact .NET runtime the service targets, then start it; if the service is genuinely slow to initialize, raise ServicesPipeTimeout -- but only after ruling out startup exceptions like this one."),
("server","SQL Server won't accept remote connections -- 'A network-related or instance-specific error occurred'",
 "Three independent gates were closed: TCP/IP was disabled in SQL's own protocols, the SQL Browser service was stopped (needed for named instances), and no firewall rule existed -- fixing only one wouldn't have helped.",
 [("Test-NetConnection sql01 -Port 1433",1,"","TcpTestSucceeded : False"),
  ("Get-Service 'MSSQL*','SQLBrowser' | Select-Object Name, Status",0,"MSSQLSERVER Running\nSQLBrowser  Stopped",""),
  ("Get-NetFirewallRule -DisplayName '*SQL*' -ErrorAction SilentlyContinue",1,"","(no SQL firewall rules present)")],
 "Enable TCP/IP in SQL Server Configuration Manager and restart the instance, start SQL Browser (for named instances), and add inbound rules for 1433/TCP plus 1434/UDP; verify each layer separately with Test-NetConnection."),
("server","IIS site returns 503 immediately after starting -- application pool identity can't log on",
 "The app pool is configured with a custom domain identity whose password was rotated, so WAS can't start the worker process and the pool stops itself -- producing 503 for every request.",
 [("Get-WebAppPoolState -Name 'AppPool01' | Select-Object Value",0,"Value\n-----\nStopped",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WAS'} -MaxEvents 2",0,"Application pool AppPool01 has been disabled: identity CORP\\svc-web failed to log on (1326)","")],
 "Update the app pool identity's stored password (or move to a Group Managed Service Account so rotation is automatic), then start the pool; error 1326 in a WAS event always points at the identity's credentials."),
("server","A remote server's shares and RDP are both unreachable, but it responds to ping",
 "ICMP is answered by the network stack while all higher-level services are unreachable -- the host is up but hung: no SMB, no RDP, no WinRM, matching a system that lost its service subsystem rather than a network problem.",
 [("Test-Connection srv05 -Count 2 -Quiet",0,"True",""),
  ("Test-NetConnection srv05 -Port 445",1,"","TcpTestSucceeded : False"),
  ("Test-NetConnection srv05 -Port 3389",1,"","TcpTestSucceeded : False"),
  ("Test-NetConnection srv05 -Port 5985",1,"","TcpTestSucceeded : False")],
 "Ping proving 'alive' is misleading -- use out-of-band access (iDRAC/iLO/hypervisor console) to inspect the console for a hung state or resource exhaustion, since every in-band management path is already down."),
("server","An internal API server intermittently refuses connections under load -- TCP port exhaustion suspected",
 "The dynamic port range was nearly exhausted by thousands of sockets stuck in TIME_WAIT from a client that opens a new connection per request, so new outbound/inbound pairs intermittently fail.",
 [("netsh int ipv4 show dynamicport tcp",0,"Start Port : 49152\nNumber of Ports : 16384",""),
  ("(Get-NetTCPConnection -State TimeWait).Count",0,"14203","")],
 "Fix the client to reuse connections (keep-alive/connection pooling) as the real solution; short-term, widen the dynamic port range and confirm no NAT device is limiting concurrent flows."),
]

with open(JSON_PATH, encoding="utf-8") as f:
    data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f:
    jsonl_lines = [l for l in f if l.strip()]

existing_ids = set(d["id"] for d in data)
existing_goals = [d["goal"] for d in data]
existing_goal_set = set(existing_goals)
n = 1
def next_id():
    global n
    while True:
        cand = f"new-win-repair-{n:03d}"
        n += 1
        if cand not in existing_ids:
            existing_ids.add(cand); return cand

# duplicate + near-duplicate guard
skipped, near_flagged = [], []
base_time = datetime(2026, 8, 2, 9, 0, 0)
i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goal_set:
        skipped.append(goal); continue
    best = max(((difflib.SequenceMatcher(None, goal.lower(), g.lower()).ratio(), g) for g in existing_goals), default=(0,""))
    if best[0] > 0.85:
        near_flagged.append((round(best[0],2), goal, best[1])); continue
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
    existing_goal_set.add(goal); existing_goals.append(goal)
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

print("Added:", i)
print("Exact duplicates skipped:", len(skipped), skipped)
print("Near-duplicates skipped:", len(near_flagged), near_flagged)
print("Total JSON entries:", len(data))
print("Total JSONL lines:", len(jsonl_lines))

# full validation incl. near-dup sweep
ids = [d["id"] for d in data]; assert len(ids) == len(set(ids)), "dup ids"
goals = [d["goal"] for d in data]; assert len(goals) == len(set(goals)), "dup goals"
with open(JSONL_PATH, encoding="utf-8") as f:
    ulines = [json.loads(l) for l in f if l.strip()]
users = [o["messages"][1]["content"] for o in ulines]
assert len(users) == len(set(users)) and set(users) == set(goals)
near = 0
gl = [g.lower() for g in goals]
for a in range(len(gl)):
    for b in range(a+1, len(gl)):
        if abs(len(gl[a])-len(gl[b])) < 25 and difflib.SequenceMatcher(None, gl[a], gl[b]).ratio() > 0.85:
            near += 1
print("near-duplicate pairs across whole dataset:", near)
print("All validation passed")
