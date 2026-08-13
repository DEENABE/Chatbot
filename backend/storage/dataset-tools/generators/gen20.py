import json, collections
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

NEW = [
# 1
("security","Windows Hello face recognition stopped working after a driver update",
 "The IR camera was replaced by Windows Update with a generic UVC driver that exposes only the colour stream; Hello needs the infrared stream for liveness, so enrolment can no longer be matched even though the camera works in other apps.",
 [("Get-Service WbioSrvc | Select-Object Status, StartType",0,"Status : Running  StartType : Automatic",""),
  ("Get-PnpDevice -Class Camera | Select-Object Status, FriendlyName",0,"OK  Integrated Camera\nOK  Integrated IR Camera",""),
  ("Get-CimInstance Win32_PnPSignedDriver | Where-Object DeviceName -like '*IR Camera*' | Select-Object DriverProviderName, DriverVersion, DriverDate",0,"Microsoft  10.0.26100.1  2024-01-01","")],
 "Reinstall the OEM IR camera driver (DriverProviderName should be the laptop vendor, not Microsoft), then re-enrol your face; if Windows Update keeps replacing it, block that specific driver update for the device."),
# 2
("power","Laptop battery drains rapidly while sleeping with the lid closed",
 "The sleep study report shows the machine repeatedly leaving low-power idle because the network adapter is armed as a wake source and the router's broadcast traffic keeps triggering it, so it never stays in deep idle overnight.",
 [("powercfg /sleepstudy /output C:\\Temp\\sleep.html",0,"Report generated",""),
  ("powercfg /devicequery wake_armed",0,"Intel(R) Wi-Fi 6 AX201\nHID-compliant mouse",""),
  ("Get-NetAdapterPowerManagement -Name 'Wi-Fi' | Select-Object WakeOnMagicPacket, WakeOnPattern",0,"WakeOnMagicPacket : Enabled  WakeOnPattern : Enabled","")],
 "Disable pattern-match wake on the Wi-Fi adapter ('Disable-NetAdapterPowerManagement -Name Wi-Fi -WakeOnPattern') and unarm the mouse; keep magic-packet wake only if Wake-on-LAN is genuinely needed."),
# 3
("hardware","USB-C charging works only when the cable is held at a certain angle",
 "Charging depends on the cable position, which means the electrical contact is intermittent rather than the power negotiation failing - the OS sees repeated AC/DC transitions each time contact is lost.",
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; Id=105} -MaxEvents 10 | Select-Object TimeCreated",0,"10 power-source transitions within 3 minutes of handling the cable",""),
  ("Get-CimInstance -ClassName BatteryStatus -Namespace ROOT\\WMI | Select-Object PowerOnline, Charging",0,"PowerOnline : False  Charging : False","")],
 "Test a known-good cable and charger first; if the fault follows the laptop rather than the cable, the USB-C port's solder joints or connector are damaged and need board-level repair - no software setting affects physical contact."),
# 4
("bluetooth","A Bluetooth device connects then disconnects again after a few seconds",
 "The headset is still paired with a phone that is within range and holds a higher connection priority, so it drops the PC connection and re-attaches to the phone each time.",
 [("Get-PnpDevice -Class Bluetooth | Where-Object FriendlyName -like '*WH-1000*' | Select-Object Status, FriendlyName",0,"OK  WH-1000XM4",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Bluetooth-BthLEEnum'} -MaxEvents 3 -ErrorAction SilentlyContinue",0,"Device disconnected (remote initiated)","")],
 "Turn Bluetooth off on the other paired device (or disconnect the headset there) while using it with the PC; multipoint headsets prioritise the last-connected phone, and the disconnect is remote-initiated rather than a Windows fault."),
# 5
("vpn","Wi-Fi connects but VPN traffic cannot reach internal resources",
 "The VPN tunnel is up and its routes exist, but the Wi-Fi interface has a lower metric than the VPN interface, so Windows prefers the physical adapter for the internal subnets and traffic never enters the tunnel.",
 [("Get-NetIPInterface -AddressFamily IPv4 | Select-Object InterfaceAlias, InterfaceMetric | Sort-Object InterfaceMetric",0,"Wi-Fi 25 / CorpVPN 45",""),
  ("Get-NetRoute -DestinationPrefix '10.0.0.0/8' | Select-Object InterfaceAlias, NextHop, RouteMetric",0,"CorpVPN  0.0.0.0  45",""),
  ("Test-NetConnection intranet.corp.local -Port 443",1,"","TcpTestSucceeded : False")],
 "Lower the VPN interface metric below Wi-Fi ('Set-NetIPInterface -InterfaceAlias CorpVPN -InterfaceMetric 1') or disable 'Use default gateway on remote network' consistently; route existence alone does not guarantee route selection."),
# 6
("security","Windows Defender scan is stuck at a fixed percentage and never completes",
 "The scan is looping inside a directory junction that points back to one of its own ancestors, so the engine keeps descending an infinite path and progress never advances.",
 [("Get-MpComputerStatus | Select-Object QuickScanStartTime, FullScanStartTime, ComputerState",0,"FullScanStartTime : 6 hours ago",""),
  ("Get-ChildItem D:\\Data -Recurse -Attributes ReparsePoint -ErrorAction SilentlyContinue | Select-Object FullName, Target",0,"D:\\Data\\Archive\\Loop -> D:\\Data","")],
 "Remove the looping junction (deleting the link does not touch the target), then restart the scan; add the path as an exclusion only if the junction is intentional and cannot be removed."),
# 7
("windows","File Explorer search cannot find files by their content",
 "Filename matches work because Explorer falls back to a direct scan, but content search requires an installed filter handler for that file type, and none is registered for PDF on this machine.",
 [("Get-Service WSearch | Select-Object Status",0,"Status : Running",""),
  ("Get-ChildItem 'HKLM:\\SOFTWARE\\Classes\\.pdf\\PersistentHandler' -ErrorAction SilentlyContinue",1,"","(no PersistentHandler registered for .pdf)")],
 "Install a PDF iFilter (Adobe's, or the one bundled with a PDF reader), then rebuild the index from Indexing Options; without a filter handler the indexer stores only metadata for that extension."),
# 8
("activedirectory","Windows login takes several minutes on a domain account",
 "Group Policy is processing synchronously and waiting on a logon script hosted on a share that is unreachable, so the desktop is held until that operation times out.",
 [("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-GroupPolicy/Operational'; Id=8001} -MaxEvents 3 | Select-Object -ExpandProperty Message",0,"Completed policy processing in 184 seconds",""),
  ("gpresult /r /scope:user | Select-String 'Logon Script'",0,"\\\\oldserver\\netlogon\\map.cmd",""),
  ("Test-NetConnection oldserver -Port 445",1,"","TcpTestSucceeded : False")],
 "Remove or repoint the logon script to a reachable path; long GP processing times in Event 8001 always identify which extension is slow, so start there rather than assuming a profile problem."),
# 9
("windows","Microsoft Store download is stuck at 'Pending' and never starts",
 "An earlier package install failed and is still queued, and the Store processes its queue serially, so every subsequent download waits behind the stuck item.",
 [("Get-AppxPackage | Where-Object Status -ne 'Ok' | Select-Object Name, Status",0,"Microsoft.GamingServices  Modified",""),
  ("Get-Service InstallService | Select-Object Status, StartType",0,"Status : Stopped  StartType : Manual","')")],
 "Start the Microsoft Store Install Service, clear the queue with 'wsreset.exe', and repair or remove the package reporting a non-Ok status; the pending state clears once the blocking item leaves the queue."),
# 10
("sandbox","Windows Sandbox cannot share the clipboard with the host",
 "Clipboard redirection is explicitly disabled in the .wsb configuration file used to launch the sandbox, so the isolation is behaving exactly as configured.",
 [("Get-Content 'C:\\Sandbox\\dev.wsb'",0,"<Configuration><ClipboardRedirection>Disable</ClipboardRedirection></Configuration>",""),
  ("Get-WindowsOptionalFeature -Online -FeatureName 'Containers-DisposableClientVM' | Select-Object State",0,"State : Enabled","")],
 "Set ClipboardRedirection to Enable in the .wsb file (or launch the default sandbox with no config file, where it is enabled); leave it disabled when analysing untrusted content, since the clipboard is a real exfiltration path."),
# 11
("docker","Docker containers cannot resolve hostnames while the host resolves fine",
 "The Docker daemon passes its own resolver configuration to containers, and while a VPN is connected the host's DNS servers are not reachable from the container network, so lookups inside containers fail.",
 [("docker run --rm alpine nslookup github.com",1,"",";; connection timed out; no servers could be reached"),
  ("Resolve-DnsName github.com | Select-Object -First 1 IPAddress",0,"140.82.121.4",""),
  ("Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, ServerAddresses",0,"CorpVPN  {10.0.0.10}","")],
 "Set explicit resolvers in daemon.json (\"dns\": [\"1.1.1.1\",\"8.8.8.8\"]) or per-container with --dns, and restart Docker; the container network cannot reach VPN-scoped internal resolvers by default."),
# 12
("wsl","A WSL distro's virtual disk keeps growing and never releases freed space",
 "The ext4.vhdx is a dynamically expanding disk: deleting files inside the distro frees space in the Linux filesystem but the VHDX itself never shrinks automatically, so the host disk keeps losing capacity.",
 [("wsl -l -v",0,"Ubuntu  Stopped  2",""),
  ("Get-ChildItem \"$env:LOCALAPPDATA\\Packages\" -Recurse -Filter 'ext4.vhdx' -ErrorAction SilentlyContinue | Select-Object FullName, @{N='GB';E={[math]::Round($_.Length/1GB,1)}}",0,"ext4.vhdx  62.4",""),
  ("wsl --shutdown",0,"","")],
 "Shut down WSL, then compact the disk with 'Optimize-VHD -Path <ext4.vhdx> -Mode Full' (needs Hyper-V) or diskpart's 'compact vdisk'; run 'sudo fstrim -a' inside the distro first so the freed blocks are actually released."),
# 13
("hyperv","A Hyper-V external virtual switch loses connectivity after the host sleeps",
 "The physical adapter re-enumerates on resume and the virtual switch's binding to it is not re-established, so VMs stay connected to a switch whose uplink is effectively gone.",
 [("Get-VMSwitch | Select-Object Name, SwitchType, NetAdapterInterfaceDescription",0,"ExternalSwitch  External  Intel(R) Ethernet I219-V",""),
  ("Get-NetAdapter | Where-Object Name -like 'vEthernet*' | Select-Object Name, Status",0,"vEthernet (ExternalSwitch)  Disconnected",""),
  ("Get-NetAdapter -Name 'Ethernet' | Select-Object Status, LinkSpeed",0,"Up  1 Gbps","")],
 "Update the physical NIC driver, and as a workaround disable sleep on the Hyper-V host or re-bind the switch after resume ('Set-VMSwitch -Name ExternalSwitch -NetAdapterName Ethernet'); hosts running VMs are normally configured never to sleep."),
# 14
("printer","Scanning works on a multifunction printer but printing fails",
 "Scanning uses the device's network scan service which discovers the printer dynamically, while printing goes through a fixed port entry that still holds the printer's old IP address, so only the print path is broken.",
 [("Get-Printer -Name 'MFC-Office' | Select-Object Name, PrinterStatus, PortName",0,"MFC-Office  Error  IP_192.168.1.50",""),
  ("Get-PrinterPort -Name 'IP_192.168.1.50' | Select-Object Name, PrinterHostAddress",0,"PrinterHostAddress : 192.168.1.50",""),
  ("Test-NetConnection 192.168.1.50 -Port 9100",1,"","TcpTestSucceeded : False")],
 "Find the printer's current IP from its control panel, update the port address, and give the device a DHCP reservation so the address stops moving; scanning kept working only because it re-discovers the device each time."),
# 15
("hardware","Webcam image appears upside down in video-call apps",
 "The camera module is physically mounted inverted and the vendor driver normally applies a rotation flag; after Windows replaced it with the generic UVC driver, no rotation is applied and the raw sensor orientation shows through.",
 [("Get-PnpDevice -Class Camera | Select-Object Status, FriendlyName",0,"OK  USB2.0 HD UVC WebCam",""),
  ("Get-CimInstance Win32_PnPSignedDriver | Where-Object DeviceName -like '*WebCam*' | Select-Object DriverProviderName, DriverVersion",0,"Microsoft  10.0.26100.1","")],
 "Install the OEM camera driver so the rotation flag is applied again; as a stopgap most conferencing apps have their own flip/rotate setting, but that only corrects the app you set it in."),
# 16
("hardware","Laptop touch screen registers phantom touches with nobody touching it",
 "The digitizer reports contacts continuously even with the screen untouched, which points to a hardware fault in the panel or a damaged flex connector rather than a driver or calibration problem.",
 [("Get-PnpDevice -Class HIDClass | Where-Object FriendlyName -like '*touch screen*' | Select-Object Status, FriendlyName",0,"OK  HID-compliant touch screen",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-PnP'} -MaxEvents 3 -ErrorAction SilentlyContinue",0,"(no device errors logged)","")],
 "Disable the touch screen in Device Manager to confirm the phantom input stops, which isolates it to the digitizer; a panel reporting contacts with no touch is a hardware replacement, not something a driver update fixes."),
# 17
("display","External monitor shows 'Out of range' and stays black",
 "The GPU is sending a mode the monitor cannot display; the driver update reset the output to a higher refresh rate than this panel supports, so the monitor rejects the signal before Windows finishes drawing.",
 [("Get-CimInstance Win32_VideoController | Select-Object Name, CurrentHorizontalResolution, CurrentRefreshRate",0,"NVIDIA RTX 3060  3840  144",""),
  ("Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorListedSupportedSourceModes -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count : 1","")],
 "Boot into Safe Mode or use the laptop's own screen to set a supported mode (start at 60 Hz), then raise it gradually; a cable that cannot carry the bandwidth produces the same message even when the monitor supports the mode."),
# 18
("audio","Audio is noticeably delayed after a Bluetooth headset reconnects",
 "On reconnect the headset negotiated the basic SBC codec instead of the low-latency codec it used before, and SBC's larger buffer is what the user perceives as lag.",
 [("Get-PnpDevice -Class AudioEndpoint | Where-Object FriendlyName -like '*WH-1000*' | Select-Object Status, FriendlyName",0,"OK  Headphones (WH-1000XM4 Stereo)",""),
  ("Get-CimInstance Win32_SoundDevice | Select-Object Name, Status",0,"Intel(R) Wireless Bluetooth(R)  OK","")],
 "Remove and re-pair the headset so codec negotiation restarts, and keep the Bluetooth driver current; if the endpoint shows as Hands-Free rather than Stereo, switch playback to the Stereo endpoint which uses the better codec."),
# 19
("backup","A scheduled backup reports success but produces an empty archive",
 "The task runs as SYSTEM, and the source path is a mapped drive letter that only exists in the interactive user's session, so the job finds nothing to copy and exits cleanly with a success code.",
 [("Get-ScheduledTask -TaskName 'NightlyArchive' | Select-Object -ExpandProperty Principal | Select-Object UserId, LogonType",0,"UserId : SYSTEM  LogonType : ServiceAccount",""),
  ("Get-ScheduledTask -TaskName 'NightlyArchive' | Select-Object -ExpandProperty Actions | Select-Object Execute, Arguments",0,"Arguments: -Source Z:\\Projects -Dest D:\\Backups",""),
  ("Get-SmbMapping | Select-Object LocalPath, RemotePath",0,"Z:  \\\\fileserver\\projects  (interactive session only)","")],
 "Replace the drive letter with the full UNC path and give the run-as account access to the share; a backup that succeeds with zero files is nearly always a context problem rather than a backup engine fault."),
# 20
("bitlocker","The BitLocker recovery key is not listed in the Microsoft account",
 "The drive was encrypted while signed in with a local account, so no key was ever escrowed online; the key exists only wherever it was saved at encryption time.",
 [("Get-BitLockerVolume -MountPoint C: | Select-Object VolumeStatus, KeyProtector",0,"FullyEncrypted  {Tpm, RecoveryPassword}",""),
  ("(Get-BitLockerVolume -MountPoint C:).KeyProtector | Where-Object KeyProtectorType -eq 'RecoveryPassword' | Select-Object KeyProtectorId",0,"{A1B2C3D4-...}","")],
 "While the machine is still unlocked, back the key up now ('BackupToAAD-BitLockerKeyProtector' for Entra-joined, or manage-bde -protectors -get to print/save it); once a machine is locked with no escrowed key, the data is unrecoverable."),
# 21
("windows","Windows Update installs successfully but keeps offering the same update",
 "The package applies but its completion is never registered because a pending servicing transaction blocks the store from committing, so the detection logic sees it as still missing on every scan.",
 [("Get-HotFix | Where-Object HotFixID -eq 'KB5034123' | Select-Object HotFixID, InstalledOn",0,"(no result - not recorded as installed)",""),
  ("Test-Path 'C:\\Windows\\WinSxS\\pending.xml'",0,"True",""),
  ("DISM /Online /Cleanup-Image /ScanHealth",0,"The component store is repairable.","")],
 "Clear the pending transaction (revert pending actions from WinRE if a reboot does not clear it), run 'DISM /Online /Cleanup-Image /RestoreHealth', then reinstall the update so it registers properly."),
# 22
("activedirectory","A domain computer's account password is out of sync after restoring from a snapshot",
 "Computer accounts rotate their password automatically every 30 days; restoring a snapshot older than the last rotation leaves the machine holding a password the domain no longer accepts, breaking the secure channel.",
 [("Test-ComputerSecureChannel -Verbose",0,"False",""),
  ("Get-ADComputer PC07 -Properties PasswordLastSet | Select-Object PasswordLastSet",0,"PasswordLastSet : 8/1/2026 (after the snapshot date)","")],
 "Repair it without rejoining using 'Test-ComputerSecureChannel -Repair -Credential (Get-Credential)'; for VMs that are restored often, consider disabling automatic machine password changes on those specific systems."),
# 23
("remote","Remote Desktop clipboard redirection stops working mid-session",
 "The clipboard bridge process on the remote host crashed; the RDP session continues normally because clipboard redirection runs in a separate process from the session itself.",
 [("Get-Process rdpclip -ErrorAction SilentlyContinue | Select-Object Id, StartTime",1,"","(process not running)"),
  ("Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -Name fDisableClip -ErrorAction SilentlyContinue",0,"fDisableClip : 0","")],
 "Start rdpclip.exe again inside the session (no reconnect needed); if it crashes repeatedly, a shell extension or clipboard-manager utility on the remote host is usually the trigger."),
# 24
("office","Office documents open with missing linked images showing red X placeholders",
 "The images are linked rather than embedded, and the original path is no longer reachable from this machine, so Word renders the placeholder instead of the picture.",
 [("Get-Item 'C:\\Docs\\Report.docx' | Select-Object Name, Length",0,"Report.docx  184320 (too small to contain the images)",""),
  ("Test-Path '\\\\oldserver\\media\\logo.png'",0,"False","")],
 "Restore access to the source path, or open the document where the images resolve and re-insert them with 'Insert and Link' replaced by plain Insert so they embed; a very small file size for an image-heavy document is the giveaway."),
# 25
("onedrive","OneDrive files stay stuck on 'Sync pending' indefinitely",
 "The affected files are held open by another application, so the sync client cannot read them to upload and leaves them queued rather than failing outright.",
 [("Get-Process OneDrive | Select-Object Responding",0,"Responding : True",""),
  ("Get-Process | Where-Object {$_.Modules.FileName -like '*Budget.xlsx*'} -ErrorAction SilentlyContinue | Select-Object Name, Id",0,"EXCEL  6120","")],
 "Close the applications holding the queued files, then let sync catch up; also check for filenames with unsupported characters (\" * : < > ? / \\ |) and paths over the length limit, which stay pending for the same reason."),
# ---- related / adjacent ----
("security","Windows Hello PIN works but fingerprint enrolment fails midway",
 "The biometric service is healthy, but the fingerprint sensor's driver is a generic WBF driver that cannot complete template creation for this sensor model, so enrolment aborts partway.",
 [("Get-Service WbioSrvc | Select-Object Status",0,"Status : Running",""),
  ("Get-PnpDevice -Class Biometric | Select-Object Status, FriendlyName",0,"OK  Windows Biometric Sensor",""),
  ("Get-CimInstance Win32_PnPSignedDriver | Where-Object DeviceClass -eq 'BIOMETRIC' | Select-Object DriverProviderName",0,"Microsoft","")],
 "Install the vendor's fingerprint driver (Synaptics/Goodix/Elan as appropriate) rather than the in-box one, then delete existing enrolments and re-enrol from scratch."),
("power","Laptop wakes from sleep on its own inside a bag and overheats",
 "A wake timer plus an armed device are both able to wake the machine, and in a closed bag it wakes, finds no way to sleep again quickly, and heats up in an enclosed space.",
 [("powercfg /waketimers",0,"Wake timer set by task 'UpdateOrchestrator\\Reboot'",""),
  ("powercfg /devicequery wake_armed",0,"Intel(R) Wi-Fi 6 AX201\nHID Keyboard Device","")],
 "Disable wake timers for the battery power plan and unarm the keyboard/network wake sources; on modern standby machines also confirm the lid-close action is Sleep rather than Do nothing."),
("bluetooth","Bluetooth audio quality drops sharply when the microphone is used, then stays poor",
 "The headset switched to the Hands-Free profile for the microphone and never returned to the higher-quality stereo profile after the call ended, so playback continues at telephony quality.",
 [("Get-PnpDevice -Class AudioEndpoint | Where-Object FriendlyName -like '*Hands-Free*' | Select-Object Status, FriendlyName",0,"OK  Headset (WH-1000XM4 Hands-Free AG Audio)","")],
 "Set the Stereo endpoint as the default playback device after calls, or disable the Hands-Free service in the device's Bluetooth properties if the headset microphone is never needed on this PC."),
("vpn","VPN connects but DNS resolves internal names to public addresses",
 "The VPN pushes internal DNS servers, but the physical adapter's DNS is queried first because of interface metric ordering, so public answers win the race for names that exist in both zones.",
 [("Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, ServerAddresses",0,"Wi-Fi {8.8.8.8} / CorpVPN {10.0.0.10}",""),
  ("Resolve-DnsName portal.corp.com | Select-Object IPAddress",0,"203.0.113.20 (public)","')")],
 "Lower the VPN interface metric and configure the corporate DNS suffix on the VPN adapter so internal names resolve through the tunnel; split-horizon names need the internal resolver to be queried first, not merely present."),
("windows","Store apps install but their tiles show as blank placeholders",
 "The package deployed successfully, but the tile assets could not be staged because the app package cache is corrupted, so the shell renders a placeholder while the app itself works.",
 [("Get-AppxPackage -Name '*Solitaire*' | Select-Object Name, Status, InstallLocation",0,"Status : Ok",""),
  ("Get-ChildItem \"$env:LOCALAPPDATA\\Packages\" -Directory -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count : 214","")],
 "Re-register the affected package ('Add-AppxPackage -Register ...AppXManifest.xml -DisableDevelopmentMode') and restart Explorer so the tile assets are re-read from the manifest."),
("docker","Docker Desktop containers lose network access after the host changes networks",
 "The Docker virtual network keeps the routing configuration from the previous host network, so container traffic is sent toward a gateway that no longer exists on the new network.",
 [("docker network inspect bridge --format '{{json .IPAM.Config}}'",0,"[{\"Subnet\":\"172.17.0.0/16\",\"Gateway\":\"172.17.0.1\"}]",""),
  ("Get-NetIPInterface -AddressFamily IPv4 | Where-Object InterfaceAlias -like '*WSL*' | Select-Object InterfaceAlias, ConnectionState",0,"vEthernet (WSL)  Connected","")],
 "Restart Docker Desktop after switching networks (or 'wsl --shutdown' then relaunch) so the virtual network is rebuilt against the current host configuration."),
("printer","A printer prints test pages but application documents come out blank",
 "Test pages are generated by the spooler itself and bypass the driver's rendering path, so a rendering fault in the driver produces blank output only for real documents.",
 [("Get-Printer -Name 'HP-Office' | Select-Object DriverName, PrinterStatus",0,"HP Universal Printing PCL 6  Normal",""),
  ("Get-PrintJob -PrinterName 'HP-Office' -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count : 0 (jobs complete without error)","")],
 "Replace the universal driver with the model-specific one, or switch the print processor to RAW; blank output with successful job completion is a rendering-stage problem rather than a connectivity one."),
("display","Screen flickers or goes black briefly when opening certain applications",
 "The applications trigger a display mode change (fullscreen optimisations or an HDR switch), and the panel blanks while it re-syncs to the new mode - visible as a flicker rather than a fault.",
 [("Get-CimInstance Win32_VideoController | Select-Object Name, CurrentRefreshRate",0,"Intel Iris Xe  120",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Display'} -MaxEvents 3 -ErrorAction SilentlyContinue",1,"","(no driver reset events)")],
 "Disable fullscreen optimisations for the affected app and turn off Auto HDR if enabled; with no TDR events logged, the blanking is a mode switch rather than a driver crash."),
("backup","File History runs but restores are missing recent versions of some files",
 "Those files live in a folder that was never added to the File History scope, so they are backed up only if they happen to sit under a default library path.",
 [("Get-Service fhsvc | Select-Object Status",0,"Status : Running",""),
  ("Get-ChildItem 'D:\\FileHistory' -Directory -ErrorAction SilentlyContinue | Select-Object Name",0,"Documents  Pictures  Desktop","")],
 "Add the missing folders to File History (Settings > Backup > More options > Add a folder); File History only covers configured folders, not the whole drive."),
("remote","Remote Desktop session shows a blurry, low-resolution desktop on a high-DPI client",
 "The RDP client is not DPI-aware for this connection, so the remote session renders at a low logical resolution and is then scaled up by the client, producing the blur.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Terminal Server Client' -Name EnableDpiScaling -ErrorAction SilentlyContinue",1,"","(value not set)")],
 "Enable 'Update the resolution on resize' / high-DPI support in the RDP client's Display tab, or add 'smart sizing:i:0' plus a matching desktop resolution to the .rdp file so the session renders natively."),
("office","Excel opens a shared workbook read-only even though nobody else has it open",
 "The file carries the read-only recommended flag, so Excel opens it read-only by default and only prompts to edit if the user chooses - this is a document property, not a lock.",
 [("Get-Item '\\\\fileserver\\finance\\Model.xlsx' | Select-Object IsReadOnly, LastWriteTime",0,"IsReadOnly : False",""),
  ("Get-ChildItem '\\\\fileserver\\finance' -Filter '~$Model.xlsx' -Force -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count : 0","")],
 "Clear 'Read-only recommended' in File > Save As > Tools > General Options; with no owner file present and the file not marked read-only on disk, the flag inside the workbook is the only remaining cause."),
("wsl","WSL cannot reach the internet while Windows itself is online",
 "The WSL virtual adapter lost its NAT configuration after a network change, so the distro has an address but no working route out through the host.",
 [("wsl -- ip route",0,"default via 172.28.144.1 dev eth0",""),
  ("Get-NetIPInterface -AddressFamily IPv4 | Where-Object InterfaceAlias -like '*WSL*' | Select-Object InterfaceAlias, ConnectionState",0,"vEthernet (WSL (Hyper-V firewall))  Disconnected",""),
  ("wsl --shutdown",0,"","")],
 "Restart WSL so the virtual network is rebuilt; if it recurs on every VPN connect, set the VPN client to allow local network access or use mirrored networking mode in .wslconfig."),
("hardware","A laptop fan runs at full speed immediately after boot and never slows down",
 "The embedded controller lost its fan curve state, which happens after an abnormal shutdown; the fan defaults to full speed because the controller has no valid thermal table to follow.",
 [("Get-CimInstance Win32_Processor | Select-Object LoadPercentage",0,"LoadPercentage : 3",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; Id=41} -MaxEvents 2",0,"Kernel-Power 41 recorded before the behaviour started","")],
 "Perform an EC reset: shut down, disconnect power and hold the power button for 30 seconds (or use the vendor's pinhole reset), then boot; with the CPU idle at 3% the fan behaviour is controller state rather than load."),
("network","Only HTTPS sites fail on one machine while everything else works",
 "TLS inspection by a locally installed security product is presenting a certificate the browsers do not trust, so the handshake fails while plain HTTP and other protocols are unaffected.",
 [("Test-NetConnection www.microsoft.com -Port 443",0,"TcpTestSucceeded : True",""),
  ("Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object Subject -like '*SecureProxy*' | Select-Object Subject, NotAfter",0,"CN=SecureProxy CA  NotAfter : 2026-07-01 (expired)","")],
 "The inspection CA certificate has expired - renew it through the security product, or disable HTTPS scanning; a reachable port 443 with universal TLS failures always points at the inspecting middlebox."),
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
base_time = datetime(2026, 8, 8, 9, 0, 0); i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goals: skipped.append(goal); continue
    key = ' '.join(goal.lower().split()[:4])
    if key in prefix_index: near.append((goal, prefix_index[key][0]))
    created = base_time + timedelta(minutes=5*i); i += 1
    steps = [{"command": c, "blocked": False, "exitCode": ec, "stdout": o, "stderr": e, "reason": None} for c, ec, o, e in commands]
    data.append({
        "id": next_id(), "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal, "domain": domain,
        "plan": ["Collect the evidence this class of problem produces",
                 "Separate the true root cause from surface symptoms",
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
print(f"Added: {i} | dups: {len(skipped)} | near: {len(near)}")
for a,b in near: print("  NEAR:", a[:55], "<>", b[:55])
print("Total:", len(data))
