import json, collections
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

NEW = [
# ===== BOOT / BUGCHECK ERROR CODES =====
("errorcode","Boot fails with error code 0xc000000f 'The boot configuration data for your PC is missing or contains errors'",
 "0xc000000f means the boot manager located the BCD store but couldn't read a required entry -- the BCD is present yet its device element points at a volume identifier that no longer resolves after a disk clone.",
 [("bcdedit /enum {bootmgr}",1,"","The boot configuration data store could not be opened. The requested system device cannot be found."),
  ("bcdboot C:\\Windows /s S: /f UEFI",0,"Boot files successfully created.","")],
 "Rebuild the boot files with bcdboot against the correct EFI partition; after cloning, the old BCD often references the source disk's identifiers, which is why a rebuild rather than a repair is the reliable fix."),
("errorcode","Boot stops with 0xc0000225 'An unexpected error has occurred' before Windows loads",
 "0xc0000225 means the boot manager found no valid boot selection -- here the active/system partition flag was lost, so firmware handed off to a partition with no loader.",
 [("bcdedit /enum all",1,"","The boot configuration data store could not be opened."),
  ("# diskpart: list vol / select vol 1 / detail partition",0,"System partition present but not flagged Active (MBR disk)",""),
  ("bootrec /rebuildbcd",0,"Total identified Windows installations: 1  Successfully scanned.","")],
 "Set the system partition Active again (MBR) or verify the EFI partition GUID type (GPT), then run bootrec /rebuildbcd followed by bcdboot; 0xc0000225 is almost always about which partition firmware is told to boot."),
("errorcode","Boot error 0xc0000098 'The Windows Boot Configuration Data file does not contain a valid OS entry'",
 "0xc0000098 means the BCD store exists and is readable but contains no valid osloader entry -- typically after a failed dual-boot removal deleted the Windows entry while leaving the store intact.",
 [("bcdedit /enum osloader",0,"(no entries returned)",""),
  ("bcdboot C:\\Windows",0,"Boot files successfully created.","")],
 "Recreate the OS entry with bcdboot; if multiple OSes should be listed, add each with 'bcdedit /copy' afterwards rather than editing the store by hand."),
("errorcode","Blue screen NTFS_FILE_SYSTEM stop code 0x00000024",
 "0x24 is raised inside the NTFS driver when it encounters unreadable file-system structures; the paired disk events show read failures on the same volume, so the file system damage is downstream of failing media.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='disk'; Id=7} -MaxEvents 3",0,"The device, \\Device\\Harddisk0\\DR0, has a bad block. (3 events)",""),
  ("Get-Volume -DriveLetter C | Select-Object HealthStatus",0,"HealthStatus : Warning","")],
 "Back up immediately, then run 'chkdsk C: /f /r' from Recovery; if bad blocks keep appearing after the repair, replace the drive -- 0x24 caused by media failure will return otherwise."),
("errorcode","Blue screen DRIVER_IRQL_NOT_LESS_OR_EQUAL stop code 0x000000D1",
 "0xD1 means a kernel driver accessed pageable memory at too high an IRQL; the bugcheck parameter names the offending driver, which here is the third-party network filter installed with a VPN client.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WER-SystemErrorReporting'} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"0x000000d1 (... , vpnfilter.sys)",""),
  ("Get-CimInstance Win32_SystemDriver | Where-Object Name -match 'vpnfilter' | Select-Object Name, State, PathName",0,"vpnfilter  Running  C:\\Windows\\System32\\drivers\\vpnfilter.sys","")],
 "Update or uninstall the product owning the named driver; 0xD1 always identifies a driver in its parameters, so treat that name as the primary suspect rather than generic 'run sfc' steps."),
("errorcode","Blue screen MEMORY_MANAGEMENT stop code 0x0000001A after adding RAM",
 "0x1A indicates the memory manager found an inconsistency; it started immediately after new RAM was installed and the modules run at mismatched configured speeds, pointing to unstable memory rather than software.",
 [("Get-CimInstance Win32_PhysicalMemory | Select-Object BankLabel, Capacity, ConfiguredClockSpeed",0,"BANK0 16GB 3200\nBANK2 16GB 2666",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 2",0,"bugcheck 0x0000001a (repeat)","")],
 "Run MemTest86 to confirm, then either match the kit (same speed/timings) or set all modules to the slowest common stable speed in BIOS; mixed kits are the most common cause of 0x1A after an upgrade."),
("errorcode","Blue screen BAD_POOL_HEADER stop code 0x00000019",
 "0x19 means kernel pool metadata was corrupted -- typically by a driver writing outside its allocation. Driver Verifier flagged the specific third-party filter driver responsible.",
 [("verifier /standard /driver suspect.sys",0,"Driver Verifier enabled; reboot required",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 1 | Select-Object -ExpandProperty Message",0,"0x000000c4 verifier-detected violation in suspect.sys","")],
 "Uninstall/update the identified driver, then turn Verifier off ('verifier /reset'); leaving Verifier enabled permanently is a performance hit and will bugcheck on any minor violation."),
("errorcode","Blue screen SYSTEM_SERVICE_EXCEPTION stop code 0x0000003B during video playback",
 "0x3B occurs when a system call transitions to kernel mode and faults; the parameters name the graphics kernel module, and the crashes coincide with hardware-accelerated decoding in the browser.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"0x0000003b (..., dxgmms2.sys)",""),
  ("Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion",0,"Intel UHD 630  27.20.100.8681","")],
 "Update the GPU driver (clean install), and as a temporary workaround disable hardware acceleration in the app that triggers it; dxgmms2.sys in the parameters points to the graphics stack, not a Windows core fault."),
("errorcode","Blue screen CRITICAL_STRUCTURE_CORRUPTION stop code 0x00000109",
 "0x109 means PatchGuard detected modified kernel structures -- usually caused by an outdated anti-cheat/security driver hooking the kernel, or by unstable overclocked memory corrupting kernel pages.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 1 | Select-Object -ExpandProperty Message",0,"0x00000109 (kernel structure modification detected)",""),
  ("Get-CimInstance Win32_SystemDriver | Where-Object {$_.State -eq 'Running' -and $_.PathName -match 'anticheat|vgk|faceit'} | Select-Object Name",0,"vgk","")],
 "Update the kernel-level anti-cheat/security software to its current version, and reset any CPU/RAM overclock to stock; 0x109 is either kernel patching or memory corruption -- rule out the overclock first since it's free to test."),
("errorcode","Blue screen ATTEMPTED_EXECUTE_OF_NOEXECUTE_MEMORY stop code 0x000000FC",
 "0xFC means code tried to execute from memory marked non-executable (DEP protection). The faulting module is a legacy driver that allocates executable memory incorrectly on modern Windows.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 1 | Select-Object -ExpandProperty Message",0,"0x000000fc (..., oldprint.sys)",""),
  ("Get-CimInstance Win32_PnPSignedDriver | Where-Object DeviceName -match 'Printer' | Select-Object DriverVersion, DriverDate",0,"DriverVersion 6.1.7600.16385  DriverDate 2010-06-21","")],
 "Replace the legacy driver with a current version (or a Type 4/class driver); DEP violations from old drivers can't be safely worked around by disabling DEP, which would remove a core exploit mitigation."),
# ===== WINDOWS UPDATE / SERVICING HRESULTs =====
("errorcode","Windows Update fails with 0x80070643 'Fatal error during installation'",
 "0x80070643 is a generic MSI fatal error surfaced by the update; the CBS log shows the failure came from the .NET Framework component failing its own repair step during the cumulative update.",
 [("Get-WindowsUpdateLog -ErrorAction SilentlyContinue; Select-String -Path \"$env:TEMP\\WindowsUpdate.log\" -Pattern '0x80070643' | Select-Object -Last 2",0,"Install failed for .NET Framework update component",""),
  ("Get-WindowsOptionalFeature -Online -FeatureName NetFx3 | Select-Object State",0,"State : Enabled","")],
 "Run the .NET Framework Repair Tool, then retry the update; if it recurs, install the standalone update package from the Microsoft Update Catalog which reports the underlying MSI error more clearly."),
("errorcode","Update fails with 0x800F0831 'CBS_E_STORE_CORRUPTION' referencing a missing package manifest",
 "0x800F0831 means the servicing stack needs a package that isn't in the local store -- an intermediate cumulative update was cleaned up, so the new update can't build its dependency chain.",
 [("DISM /Online /Cleanup-Image /ScanHealth",0,"The component store is repairable.",""),
  ("Select-String -Path 'C:\\Windows\\Logs\\CBS\\CBS.log' -Pattern 'Package_for_RollupFix' | Select-Object -Last 1",0,"Failed to resolve package: Package_for_RollupFix~31bf3856ad364e35~amd64~~19041.1949","")],
 "Download the exact missing package named in CBS.log from the Update Catalog and install it, or run 'DISM /RestoreHealth /Source:' against matching install media; the log names the precise package needed."),
("errorcode","Windows Update returns 0x80070422 and the Windows Update service can't be started",
 "0x80070422 is 'the service cannot be started because it is disabled' -- the Windows Update service start type was set to Disabled, so every update operation fails immediately.",
 [("Get-Service wuauserv | Select-Object Status, StartType",0,"Status: Stopped  StartType: Disabled",""),
  ("Set-Service wuauserv -StartupType Manual; Start-Service wuauserv",0,"","")],
 "Set wuauserv back to Manual (its default trigger-start mode) and start it; if it re-disables itself, check for a GPO or a 'privacy tweak' tool enforcing the disabled state."),
("errorcode","Update install fails with 0x80070017 'Data error (cyclic redundancy check)'",
 "0x80070017 is a CRC failure reading the update payload -- the downloaded package is corrupt or the disk returned bad data, not a servicing logic problem.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='disk'} -MaxEvents 3 -ErrorAction SilentlyContinue",0,"(no disk errors logged)",""),
  ("Stop-Service wuauserv,bits; Rename-Item C:\\Windows\\SoftwareDistribution SD.old; Start-Service wuauserv,bits",0,"","")],
 "Clear SoftwareDistribution so the payload re-downloads cleanly; if CRC errors persist across fresh downloads, test the disk and RAM -- the corruption is then local hardware rather than the download."),
("errorcode","Feature update blocked with 0xC1900208 'Incompatible software is installed'",
 "0xC1900208 is a hard compatibility block: setup's appraiser found software it knows breaks the upgrade, and the compat report names the specific product.",
 [("Get-Content 'C:\\$WINDOWS.~BT\\Sources\\Panther\\CompatData*.xml' -ErrorAction SilentlyContinue | Select-String 'BlockingType'",0,"Program: LegacyBackup Suite 7  BlockingType: Hard","")],
 "Uninstall the named product, run the upgrade, then reinstall a current version; unlike driver rollbacks, hard blocks won't clear on retry until the flagged software is removed."),
("errorcode","Windows Update error 0x8024001E 'Operation was aborted' repeatedly at the same percentage",
 "0x8024001E means the update operation was cancelled mid-flight -- here the machine's aggressive sleep timeout suspends it during the long install phase, aborting the transaction each time.",
 [("powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE",0,"Current AC Power Setting Index: 0x00000384 (15 minutes)",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; Id=42} -MaxEvents 2",0,"System is entering sleep (during update window)","")],
 "Set sleep to Never on AC while updating (or run updates during active hours), then retry; recurring 0x8024001E at a consistent point is nearly always the machine sleeping or a service restarting mid-install."),
("errorcode","Store and Update fail with 0x80248007 'Missing license terms'",
 "0x80248007 indicates the update client couldn't read the license terms it needs from its local datastore -- the datastore is corrupt, so the license acceptance step has nothing to reference.",
 [("Test-Path 'C:\\Windows\\SoftwareDistribution\\DataStore\\DataStore.edb'",0,"True",""),
  ("Get-Service wuauserv, msiserver | Select-Object Name, Status",0,"wuauserv Running\nmsiserver Stopped","")],
 "Start the Windows Installer service (msiserver), then rebuild the datastore by renaming SoftwareDistribution with wuauserv stopped; both are required before license terms can be re-fetched."),
# ===== TRUST / CRYPTO ERROR CODES =====
("errorcode","Installer fails with 0x800B0100 'No signature was present in the subject'",
 "0x800B0100 means signature verification found no signature at all -- the update/driver package was truncated during download, so the trailing Authenticode signature is missing.",
 [("Get-AuthenticodeSignature .\\driverpackage.exe | Select-Object Status",0,"Status : NotSigned",""),
  ("(Get-Item .\\driverpackage.exe).Length",0,"Length : 41205760 (vendor lists 68.4 MB)","")],
 "Re-download the package and verify its size/hash against the vendor's published value before running; a truncated download is far more common than a genuinely unsigned vendor package."),
("errorcode","Update or app install fails with 0x800B0109 'A certificate chain processed but terminated in an untrusted root'",
 "0x800B0109 means the signing chain ends in a root the machine doesn't trust -- this system's trusted root store is badly outdated because automatic root updates are blocked.",
 [("certutil -verify -urlfetch .\\package.cab | Select-String 'chain'",0,"A certificate chain could not be built to a trusted root authority",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\SystemCertificates\\AuthRoot' -Name DisableRootAutoUpdate -ErrorAction SilentlyContinue",0,"DisableRootAutoUpdate : 1","")],
 "Allow automatic root certificate updates (clear DisableRootAutoUpdate) or import the current root CTL manually with 'certutil -generateSSTFromWU'; blocking root updates is why signatures that verify elsewhere fail here."),
("errorcode","TLS connections fail with 0x80092004 'Cannot find object or property' during certificate validation",
 "0x80092004 means a needed certificate object couldn't be located -- the chain requires an intermediate CA that isn't installed and the AIA URL for fetching it is unreachable.",
 [("certutil -verify server.cer | Select-String 'AIA|issuer'",0,"AIA fetch failed: http://pki.corp.local/intermediate.crt",""),
  ("Test-NetConnection pki.corp.local -Port 80",1,"","TcpTestSucceeded : False")],
 "Install the intermediate CA into the machine's Intermediate Certification Authorities store, and restore reachability to the AIA endpoint so other clients can build chains automatically."),
("errorcode","Windows Hello PIN fails with 0x80090016 'Keyset does not exist'",
 "0x80090016 means the cryptographic key container backing the PIN is missing or unreadable -- the Ngc container was orphaned, so authentication has no key to validate against.",
 [("Get-ChildItem 'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Local\\Microsoft\\Ngc' -Force -ErrorAction SilentlyContinue | Measure-Object",0,"Count : 0",""),
  ("Get-Tpm | Select-Object TpmReady, TpmOwned",0,"TpmReady : True  TpmOwned : True","")],
 "Reset the PIN via 'I forgot my PIN' (rebuilds the Ngc container), or if that fails, take ownership of the Ngc folder, clear its contents, and re-enroll; the TPM itself is healthy here so a full TPM clear isn't needed."),
# ===== NETWORK / SMB ERROR CODES =====
("errorcode","File copy over the network fails with 0x8007003B 'An unexpected network error occurred'",
 "0x8007003B on large transfers points to the SMB session dropping mid-copy; here the NIC's large-send offload interacts badly with the switch, corrupting long transfers while short ones succeed.",
 [("Get-NetAdapterAdvancedProperty -Name 'Ethernet' -DisplayName '*Large Send Offload*' | Select-Object DisplayValue",0,"DisplayValue : Enabled",""),
  ("Get-SmbClientNetworkInterface | Select-Object InterfaceIndex, RssSupport, RdmaCapable",0,"RssSupport : True","")],
 "Disable Large Send Offload v2 on the adapter and retest the copy; if it succeeds, update the NIC driver/firmware which usually fixes the offload defect properly rather than leaving offload off permanently."),
("errorcode","Network share access fails with 0x80070040 'The specified network name is no longer available'",
 "0x80070040 means the SMB session was torn down -- the server's autodisconnect timer closed the idle session and the client didn't renegotiate, so subsequent operations fail on a dead handle.",
 [("Get-SmbSession -ErrorAction SilentlyContinue | Select-Object ClientComputerName, NumOpens",0,"(session absent after idle period)",""),
  ("Get-SmbServerConfiguration | Select-Object AutoDisconnectTimeout",0,"AutoDisconnectTimeout : 15","")],
 "Raise the server's AutoDisconnectTimeout (or set it to 0 to disable) if idle disconnects disrupt long-running jobs, and ensure clients use SMB3 which reconnects transparently far better than SMB1/2."),
("errorcode","Copy to a file server fails with 0x8007046A 'Not enough server storage is available to process this command'",
 "0x8007046A is the classic IRPStackSize shortfall on the file server: the server's SMB stack has too few IRP stack locations for the filter drivers loaded (antivirus + backup agent), so requests are rejected.",
 [("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\LanmanServer\\Parameters' -Name IRPStackSize -ErrorAction SilentlyContinue",1,"","(value not present -- default in use"),
  ("fltmc filters",0,"5 filter drivers attached to the volume","")],
 "Set IRPStackSize to 20-32 on the server and restart the Server service; each additional file-system filter driver consumes stack locations, which is why it appears after adding security/backup agents."),
("errorcode","Application reports Winsock error 10061 'Connection refused' to a service that appears to be running",
 "10061 means the target actively refused the connection -- the service is running but bound only to localhost, so remote connection attempts hit a closed port rather than a filtered one.",
 [("Get-NetTCPConnection -LocalPort 6379 | Select-Object LocalAddress, State",0,"LocalAddress : 127.0.0.1  State : Listen",""),
  ("Test-NetConnection 10.0.1.20 -Port 6379",1,"","TcpTestSucceeded : False")],
 "Change the service's bind address to 0.0.0.0 (or the specific LAN IP) and add the firewall rule; 10061 (refused) rules out a firewall drop, which would time out instead -- the distinction narrows this quickly."),
("errorcode","Application reports Winsock error 10060 'Connection timed out' intermittently under load",
 "10060 is a timeout with no response at all, and the sharp rise in TIME_WAIT sockets shows ephemeral port exhaustion on the client, so new connections can't be established during bursts.",
 [("(Get-NetTCPConnection -State TimeWait).Count",0,"15840",""),
  ("netsh int ipv4 show dynamicport tcp",0,"Start Port : 49152  Number of Ports : 16384","")],
 "Fix the client to reuse connections (HTTP keep-alive / connection pooling); widening the dynamic port range and lowering TIME_WAIT only buys headroom, it doesn't fix a per-request connection pattern."),
("errorcode","Browser reports ERR_CONNECTION_RESET only for HTTPS sites on one machine",
 "The connection is reset during the TLS handshake because a local security product's inspection module presents an unsupported protocol version to modern servers, which then reset the connection.",
 [("Test-NetConnection www.microsoft.com -Port 443",0,"TcpTestSucceeded : True",""),
  ("(Invoke-WebRequest https://www.microsoft.com -UseBasicParsing).StatusCode",1,"","The underlying connection was closed: An unexpected error occurred on a send.")],
 "Update or temporarily disable the security product's HTTPS/SSL scanning module to confirm, then keep it updated -- TCP connects fine, so the reset is happening at the TLS layer, not the network layer."),
# ===== VSS / BACKUP ERROR CODES =====
("errorcode","Backup fails with VSS error 0x80042306 'The provider has failed to create a shadow copy'",
 "0x80042306 means the shadow copy provider itself failed -- here because the volume's shadow storage area is on a disk that's now offline, so the provider has nowhere to write the copy.",
 [("vssadmin list shadowstorage",0,"For volume: C:  Shadow Copy Storage volume: E: (offline)",""),
  ("Get-Disk | Where-Object OperationalStatus -ne 'Online' | Select-Object Number, OperationalStatus",0,"Number 2  Offline","")],
 "Re-point shadow storage to an online volume ('vssadmin add shadowstorage /for=C: /on=C: /maxsize=10%') or bring the target disk online; VSS silently fails when its configured storage target disappears."),
("errorcode","Backup reports VSS error 0x800423F3 'The writer experienced a transient error'",
 "0x800423F3 is a transient writer failure, and 'vssadmin list writers' identifies which one -- here the SQL writer failed because the SQL service was mid-restart during the backup window.",
 [("vssadmin list writers | Select-String -Context 0,3 'SqlServerWriter'",0,"Writer name: SqlServerWriter  State: Failed  Last error: Retryable error",""),
  ("Get-Service MSSQLSERVER | Select-Object Status",0,"Status : Running","")],
 "Re-run the backup now that the service is stable; if the writer stays failed, restart the owning service (SQL VSS Writer here) -- rebooting to 'fix VSS' is rarely necessary once the failing writer is identified."),
("errorcode","System image backup fails with 0x80780119 'not enough disk space to create the volume shadow copy'",
 "0x80780119 specifically means the EFI/System Reserved partition lacks free space for its shadow copy, even though the main volume has plenty -- a very common blocker on older 100 MB reserved partitions.",
 [("Get-Partition | Where-Object IsSystem | Select-Object Size",0,"Size : 104857600",""),
  ("Get-Volume | Where-Object FileSystemLabel -eq 'System Reserved' | Select-Object SizeRemaining",0,"SizeRemaining : 11 MB","")],
 "Free space on the System Reserved/EFI partition (remove stale language/boot font files) or extend it with a partition tool; the backup needs roughly 50 MB free there regardless of the data volume's size."),
# ===== SQL / IIS / APP ERROR CODES =====
("errorcode","SQL Server login fails with error 18456 State 38",
 "18456 is a generic login failure, but State 38 specifically means the login authenticated successfully yet the requested database is inaccessible -- here it's offline after a failed restore.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='MSSQLSERVER'} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"Login failed for user 'app_user'. Reason: Failed to open the explicitly specified database 'AppDB'. [CLIENT: 10.0.1.15] Error: 18456, Severity: 14, State: 38.",""),
  ("Invoke-Sqlcmd -Query \"SELECT name, state_desc FROM sys.databases WHERE name='AppDB'\"",0,"name   state_desc\nAppDB  RECOVERY_PENDING","")],
 "Bring the database online (resolve the recovery-pending state, usually by fixing the underlying file access then 'ALTER DATABASE AppDB SET ONLINE'); the State number is the key -- always capture it from the SQL error log, not the client message."),
("errorcode","SQL connection fails with error 233 'No process is on the other end of the pipe'",
 "Error 233 means the connection was accepted then closed -- Shared Memory/Named Pipes is being used while the server only permits TCP, so the pipe closes immediately after connect.",
 [("Invoke-Sqlcmd -ServerInstance 'localhost' -Query 'SELECT 1'",1,"","A connection was successfully established with the server, but then an error occurred (provider: Named Pipes Provider, error: 0 - No process is on the other end of the pipe.)"),
  ("Get-Service 'SQLBrowser' | Select-Object Status",0,"Status : Stopped","")],
 "Force TCP in the connection string (tcp:hostname,1433) or enable Named Pipes in SQL Configuration Manager; also start SQL Browser if named instances must be resolved by name."),
("errorcode","SQL Server won't start with error 17113 'Error locating server/instance specified'",
 "17113 at startup means the instance can't open its master database files -- the startup parameter still points at the old data path after the files were moved.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='MSSQLSERVER'} -MaxEvents 1 | Select-Object -ExpandProperty Message",0,"Error 17113: initerrlog: Could not open error log file 'D:\\OldPath\\ERRORLOG'",""),
  ("Test-Path 'D:\\OldPath\\master.mdf'",0,"False","")],
 "Correct the -d/-l/-e startup parameters in SQL Server Configuration Manager to the current file locations, then start the service; moving SQL data files always requires updating these parameters."),
("errorcode","IIS returns HTTP 500.19 'Cannot read configuration file' with error code 0x8007000d",
 "500.19 with 0x8007000d means web.config is malformed or references a module that isn't installed -- here a rewrite rule exists but the URL Rewrite module was never installed on this server.",
 [("Get-WebGlobalModule | Where-Object Name -match 'Rewrite'",1,"","(module not present)"),
  ("Select-String -Path 'C:\\inetpub\\app\\web.config' -Pattern '<rewrite>'",0,"<rewrite> section present","")],
 "Install the URL Rewrite module (or remove the section from web.config); 500.19 nearly always names the offending config line in the response detail when viewed locally on the server."),
("errorcode","IIS returns HTTP 502.5 'Process Failure' for an ASP.NET Core site",
 "502.5 means the ASP.NET Core Module couldn't start the app process -- the installed .NET hosting bundle version doesn't include the runtime the app targets.",
 [("dotnet --list-runtimes",0,"Microsoft.AspNetCore.App 6.0.25",""),
  ("Select-String -Path 'C:\\inetpub\\app\\app.runtimeconfig.json' -Pattern 'version'",0,"\"version\": \"8.0.0\"","")],
 "Install the matching .NET Hosting Bundle (which includes the runtime plus the ASP.NET Core Module) and restart IIS; installing only the SDK/runtime without the hosting bundle leaves IIS unable to host the app."),
("errorcode","IIS returns HTTP 403.14 'Directory listing denied' instead of the site's home page",
 "403.14 means no default document matched and directory browsing is off -- the app's entry file isn't in the configured default document list, so IIS has nothing to serve at the root.",
 [("Get-WebConfiguration -Filter 'system.webServer/defaultDocument/files/add' -PSPath 'IIS:\\Sites\\Default Web Site' | Select-Object value",0,"value\n-----\nDefault.htm\nindex.html",""),
  ("Get-ChildItem 'C:\\inetpub\\app' -Filter '*.html' | Select-Object Name",0,"home.html","")],
 "Add the actual entry file to the default documents list (or rename it to index.html); enabling directory browsing would 'fix' the error while exposing the file listing, so avoid that as a solution."),
("errorcode","IIS returns HTTP 404.17 'Requested content appears to be script and will not be served by the static file handler'",
 "404.17 means the request matched the static file handler instead of a script handler -- the ASP.NET/handler mapping isn't registered because the feature wasn't installed after IIS.",
 [("Get-WindowsOptionalFeature -Online -FeatureName IIS-ASPNET45 | Select-Object State",0,"State : Disabled","")],
 "Enable the ASP.NET feature (or run 'dism /online /enable-feature /featurename:IIS-ASPNET45'), then re-register handlers with aspnet_regiis if needed; installing .NET before IIS is the usual cause of missing handler mappings."),
# ===== MISC WINDOWS ERROR CODES =====
("errorcode","Software install fails with 0x80070652 'Another installation is already in progress'",
 "0x80070652 means the Windows Installer mutex is held -- a previous MSI operation (a background update) hasn't released it, so no other installer can proceed until it finishes or is cleared.",
 [("Get-Process msiexec -ErrorAction SilentlyContinue | Select-Object Id, StartTime",0,"Id 5120  StartTime 09:41 (running 2 hours)",""),
  ("Get-Service msiserver | Select-Object Status",0,"Status : Running","")],
 "Wait for the pending installation to complete, or if it's genuinely hung, end the msiexec process and restart the Windows Installer service; check for a pending reboot flag afterwards, which often accompanies this state."),
("errorcode","Folder deletion fails with 0x80070091 'The directory is not empty' even after removing all visible files",
 "0x80070091 with an apparently empty folder means hidden/system files or a reparse point remain -- here an alternate data stream and a junction inside the folder keep it non-empty.",
 [("Get-ChildItem 'C:\\Temp\\stuck' -Force | Select-Object Name, Attributes",0,"Name: link  Attributes: Directory, ReparsePoint",""),
  ("Remove-Item 'C:\\Temp\\stuck\\link' -Force; Remove-Item 'C:\\Temp\\stuck' -Recurse -Force",0,"","")],
 "List with -Force to reveal hidden/system entries and reparse points, remove those explicitly, then delete the parent; deleting a junction removes only the link, not its target."),
("errorcode","Drive access fails with 0x80071AC3 'The volume is dirty'",
 "0x80071AC3 means the volume's dirty bit is set, so Windows refuses certain operations until a consistency check runs -- the bit was set after an unclean shutdown and never cleared.",
 [("fsutil dirty query D:",0,"Volume - D: is Dirty",""),
  ("chkdsk D: /f",0,"Windows has scanned the file system and made corrections to the file system.","")],
 "Run 'chkdsk D: /f' to repair and clear the dirty bit (a reboot is required for the system volume); never clear the dirty bit manually with fsutil without running the check first -- that hides real corruption."),
("errorcode","External drive throws 0x8007045D 'The request could not be performed because of an I/O device error'",
 "0x8007045D is a low-level I/O failure from the device; the disk logs confirm read errors on the same device, so this is failing media or a failing bridge/cable rather than a file-system issue.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='disk'; Id=7} -MaxEvents 3",0,"bad block events on \\Device\\Harddisk2\\DR2",""),
  ("Get-PhysicalDisk | Where-Object BusType -eq 'USB' | Select-Object FriendlyName, HealthStatus",0,"HealthStatus : Warning","")],
 "Stop writing to the drive, image what's readable to healthy storage first, then test with the vendor's diagnostic; try a different cable/enclosure to rule out the USB bridge before condemning the disk itself."),
("errorcode","Logon-related operations fail with 0x80070520 'A specified logon session does not exist'",
 "0x80070520 means the credential's logon session was already destroyed -- a scheduled task with stored credentials ran after the session it captured had ended, so its token is invalid.",
 [("Get-ScheduledTask -TaskName 'MappedDriveSync' | Select-Object -ExpandProperty Principal | Select-Object LogonType",0,"LogonType : InteractiveToken",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational'; Id=101} -MaxEvents 1",0,"Task failed to start; user not logged on","")],
 "Change the task to 'Run whether user is logged on or not' with stored credentials (Password logon type), and replace mapped-drive dependencies with UNC paths -- interactive-token tasks silently fail when nobody is signed in."),
("errorcode","App crashes with .NET exception code 0x80131500 and no useful message",
 "0x80131500 is a generic .NET runtime exception HRESULT; the .NET Runtime event captures the actual exception type, which here is a configuration parse failure rather than a code defect.",
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='.NET Runtime'} -MaxEvents 1 | Select-Object -ExpandProperty Message",0,"Unhandled Exception: System.Configuration.ConfigurationErrorsException: Configuration system failed to initialize","")],
 "Fix the malformed app.config/web.config identified in the exception detail; 0x80131500 alone is meaningless -- always pair it with the .NET Runtime event (1026) which carries the real exception."),
("errorcode","Xbox/Store game fails to launch with error 0x87AF000D",
 "0x87AF000D is a Gaming Services licensing failure -- the game's license can't be validated because the Gaming Services package is in a broken state after a partial update.",
 [("Get-AppxPackage Microsoft.GamingServices | Select-Object Version, Status",0,"Version 19.87.13001.0  Status : Modified",""),
  ("Get-Service GamingServices, GamingServicesNet | Select-Object Name, Status",0,"GamingServices Stopped\nGamingServicesNet Stopped","")],
 "Reinstall Gaming Services from the Store and ensure both Gaming Services services are running (set to Automatic); sign out and back into the Xbox app afterwards so licenses re-provision."),
("errorcode","Microsoft Store shows error 0x80D02017 when downloading apps",
 "0x80D02017 is a download failure from the Store's delivery layer -- the client can reach the Store catalog but not the content delivery endpoints, so metadata loads while downloads fail.",
 [("Test-NetConnection dl.delivery.mp.microsoft.com -Port 443",1,"","TcpTestSucceeded : False"),
  ("Test-NetConnection storeedgefd.dsx.mp.microsoft.com -Port 443",0,"TcpTestSucceeded : True","")],
 "Allow the delivery endpoints (*.delivery.mp.microsoft.com) through the proxy/firewall; the split behavior -- browsing works, downloading fails -- is the signature of blocked CDN endpoints rather than a broken Store."),
("errorcode","RDP fails with error 0x80090304 'The local security authority cannot be contacted'",
 "0x80090304 during RDP means the SSP couldn't complete authentication -- the target's Kerberos ticket request fails because its time is skewed beyond tolerance, so LSA can't validate the session.",
 [("w32tm /stripchart /computer:rdphost.corp.local /samples:1 /dataonly",0,"local clock is 00:11:37 behind rdphost.corp.local",""),
  ("Test-NetConnection rdphost.corp.local -Port 3389",0,"TcpTestSucceeded : True","")],
 "Resync time on the client (or the host, whichever drifted) with 'w32tm /resync /rediscover'; connectivity is fine here, so the failure is purely the Kerberos time-skew tolerance being exceeded."),
("errorcode","Kerberos fails with KDC_ERR_S_PRINCIPAL_UNKNOWN when accessing a service by alias",
 "The service is reached via a DNS CNAME alias, but no SPN exists for that alias -- the KDC can't find a principal matching the requested service name, so ticket issuance fails.",
 [("nslookup app.corp.local",0,"app.corp.local canonical name = websrv01.corp.local",""),
  ("setspn -L websrv01",0,"HTTP/websrv01.corp.local  (no HTTP/app.corp.local)","")],
 "Register the alias SPN on the service account ('setspn -S HTTP/app.corp.local CORP\\svc-web'); every name clients use must have a matching SPN, aliases included."),
("errorcode","Printing fails with error 0x00000709 'Double check the printer name'",
 "0x709 means the default printer couldn't be set/resolved -- the registry's default printer value points at a printer that was removed, so operations relying on the default fail.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows' -Name Device",0,"Device : \\\\oldserver\\HP-Removed,winspool,Ne01:",""),
  ("Get-Printer | Select-Object Name",0,"Name\n----\nMicrosoft Print to PDF\nHP-Floor2","")],
 "Set a valid default printer (Settings > Printers, or 'Set-Printer'), which rewrites the Device value; also turn off 'Let Windows manage my default printer' if it keeps reverting to a stale entry."),
("errorcode","Domain join fails with error 0x54B 'The specified domain either does not exist or could not be contacted'",
 "0x54B means domain locator failed -- DNS is answering, but the client's configured DNS server doesn't host the AD zone, so the required SRV records can't be found.",
 [("nslookup -type=srv _ldap._tcp.dc._msdcs.corp.local",1,"","*** No SRV records found"),
  ("Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object ServerAddresses",0,"ServerAddresses : {8.8.8.8}","")],
 "Point the client's DNS at the domain controllers (not a public resolver) and retry the join; public DNS can never resolve the internal _msdcs SRV records that domain location depends on."),
("errorcode","Application install fails with 0x80070570 'The file or directory is corrupted and unreadable' from a network share",
 "The install source lives on a share, and the corruption is happening in transit -- the same package installs fine when copied locally first, pointing at the network path rather than the media.",
 [("Copy-Item '\\\\deploy\\pkg\\setup.msi' C:\\Temp\\ -ErrorAction SilentlyContinue",1,"","Copy-Item : The file or directory is corrupted and unreadable"),
  ("Get-FileHash '\\\\deploy\\pkg\\setup.msi' -ErrorAction SilentlyContinue",1,"","(hash computation fails partway)")],
 "Check the file server's disk health and the SMB path (offloading/NIC driver) -- a source file that can't even be hashed across the network is failing at the server or transport, so fix that before blaming the installer."),
]

with open(JSON_PATH, encoding="utf-8") as f:
    data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f:
    jsonl_lines = [l for l in f if l.strip()]

existing_ids = set(d["id"] for d in data)
existing_goals = set(d["goal"] for d in data)
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
base_time = datetime(2026, 8, 3, 9, 0, 0)
i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goals:
        skipped.append(goal); continue
    key = ' '.join(goal.lower().split()[:4])
    if key in prefix_index:
        near.append((goal, prefix_index[key][0]))
    created = base_time + timedelta(minutes=5 * i); i += 1
    steps = [{"command": c, "blocked": False, "exitCode": ec, "stdout": o, "stderr": e, "reason": None} for c, ec, o, e in commands]
    data.append({
        "id": next_id(), "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal, "domain": domain,
        "plan": ["Decode what the specific error code actually means in this context",
                 "Confirm the root cause with targeted read-only checks",
                 "Apply the correct fix rather than a generic repair"],
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

print("Added:", i, "| exact dups skipped:", len(skipped), "| near-dup collisions:", len(near))
for a,b in near: print("   NEAR:", a[:70], "<>", b[:70])
print("Total JSON entries:", len(data), "| Total JSONL lines:", len(jsonl_lines))

ids = [d["id"] for d in data]; assert len(ids) == len(set(ids))
goals = [d["goal"] for d in data]; assert len(goals) == len(set(goals))
users = [json.loads(l)["messages"][1]["content"] for l in jsonl_lines]
assert len(users) == len(set(users)) and set(users) == set(goals)
print("Validation passed: unique ids/goals/prompts, files mirrored")
