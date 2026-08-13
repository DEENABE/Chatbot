#!/usr/bin/env python3
"""
gen22.py - Round 3: everyday PC problems in NORMAL USER LANGUAGE.

The existing 1,402 troubleshooting records are phrased technically
("DPC latency spike caused by outdated storage controller driver").
Real users say "my computer keeps stuttering". This round covers the same
diagnostic discipline but entering from plain-language complaints, with
root causes deliberately DIFFERENT from the existing technical records.

Categories: everyday PC (1), internet (6), audio/video (7), accounts (9).
"""
import json, collections, uuid
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

# (domain, subdomain, goal, plan[], steps[(cmd,exit,out,err)], resolved,
#  summary, recommendation, (worked, note))
NEW = [
# ======================= EVERYDAY PC =======================
("performance","disk","My computer has got really slow over the last couple of months",
 ["Check whether the slowdown tracks a resource or a component","Look at drive fill level and health","Explain what changed"],
 [("Get-Volume -DriveLetter C | Select-Object Size, SizeRemaining, @{N='PctFree';E={[math]::Round($_.SizeRemaining/$_.Size*100,1)}}",0,"          Size SizeRemaining PctFree\n          ---- ------------- -------\n  511101108224   13743895347     2.7",""),
  ("Get-PhysicalDisk | Select-Object MediaType, HealthStatus",0,"MediaType HealthStatus\n--------- ------------\nSSD       Healthy",""),
  ("Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize, CurrentUsage, PeakUsage",0,"AllocatedBaseSize CurrentUsage PeakUsage\n----------------- ------------ ---------\n             2048         1980      2048","")],
 True,
 "The SSD is at 2.7% free. Below roughly 10% an SSD controller runs out of spare blocks for wear levelling, so writes slow dramatically - and the page file is simultaneously maxed out at its 2 GB cap, forcing constant paging into that same congested drive. Nothing is faulty; the drive is simply too full to work properly.",
 "Free space until at least 15% remains, then set the page file back to system-managed. This kind of slowdown builds gradually over months, which is why it feels like the machine is 'wearing out' rather than hitting a threshold.",
 (True,"cleared 60 GB and it feels like a new machine")),

("performance","startup","My laptop takes about five minutes before I can actually use it in the morning",
 ["Separate boot time from post-logon time","Identify what runs at sign-in","Quantify the biggest contributor"],
 [("Get-CimInstance Win32_OperatingSystem | Select-Object LastBootUpTime",0,"LastBootUpTime\n--------------\n8/13/2026 8:41:02 AM",""),
  ("Get-Process OneDrive -ErrorAction SilentlyContinue | Select-Object @{N='MB';E={[int]($_.WorkingSet64/1MB)}}, StartTime",0,"  MB StartTime\n  -- ---------\n 812 8/13/2026 8:42:11 AM",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -Name Desktop, Personal",0,"Desktop  : C:\\Users\\jdoe\\OneDrive\\Desktop\nPersonal : C:\\Users\\jdoe\\OneDrive\\Documents",""),
  ("Get-ChildItem \"$env:USERPROFILE\\OneDrive\" -Recurse -File -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count\n-----\n74218","")],
 True,
 "Boot itself completes normally. The delay is afterwards: Desktop and Documents are redirected into OneDrive, and the sync client has to reconcile 74,218 files before the shell settles. Every icon on the desktop waits on that reconciliation.",
 "Turn on Files On-Demand so OneDrive stops needing local copies, and reduce what sits directly on the Desktop - each desktop item is checked individually at sign-in. The folders can stay redirected; it is the file count that costs you the five minutes.",
 (True,"Files On-Demand made a huge difference")),

("performance","RAM","Everything freezes for a few seconds every so often, then carries on like nothing happened",
 ["Check whether the pauses line up with memory pressure","Look at commit charge rather than the usage percentage","Confirm the page file can grow"],
 [("Get-CimInstance Win32_OperatingSystem | Select-Object @{N='TotalGB';E={[math]::Round($_.TotalVisibleMemorySize/1MB,1)}}, @{N='FreeGB';E={[math]::Round($_.FreePhysicalMemory/1MB,1)}}",0,"TotalGB FreeGB\n------- ------\n    7.9    0.4",""),
  ("Get-Counter '\\Memory\\Committed Bytes','\\Memory\\Commit Limit' -MaxSamples 1 | Select-Object -ExpandProperty CounterSamples | Select-Object Path, CookedValue",0,"Path                          CookedValue\n----                          -----------\n\\memory\\committed bytes        9689399296\n\\memory\\commit limit          10200547328",""),
  ("Get-Counter '\\Memory\\Pages/sec' -SampleInterval 1 -MaxSamples 3 | ForEach-Object { [int]$_.CounterSamples.CookedValue }",0,"18\n2841\n3106","")],
 True,
 "Committed memory is within 5% of the commit limit, and the paging rate spikes from 18 to over 3,000 pages per second during the freezes. The machine has run out of memory to commit and is thrashing the page file - that stall is the whole system waiting on disk.",
 "8 GB is the constraint here, not any single application. Increasing the page file will stop the hard stops but the machine will still be slow; more RAM is the real fix. Closing browser tabs before heavy work buys time in the meantime.",
 (True,"upgraded to 16 GB, freezing gone completely")),

("windows","shell","One particular program just vanishes off the screen with no error message",
 ["Check whether Windows recorded a crash","Identify the faulting component","Determine whether the app or something loaded into it is at fault"],
 [("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000} -MaxEvents 3 | Select-Object -ExpandProperty Message",0,"Faulting application name: DesignTool.exe, version 4.2.1.0\nFaulting module name: igd10iumd64.dll, version 31.0.101.4502\nException code: 0xc0000005",""),
  ("Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, DriverDate",0,"Name                  DriverVersion  DriverDate\n----                  -------------  ----------\nIntel(R) Iris Xe      31.0.101.4502  2023-04-11",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000} -MaxEvents 10 | Group-Object { ($_.Message -split \"`n\")[2] } | Select-Object Count, Name",0,"Count Name\n----- ----\n    7 Faulting module name: igd10iumd64.dll","")],
 True,
 "The application is not silently exiting - it is crashing, and Windows logged it. All seven recent crashes name the same Intel graphics driver module rather than the application's own code, and the installed driver is from 2023.",
 "Update the Intel graphics driver from Intel or the laptop vendor rather than reinstalling the application. An access violation inside a graphics driver module points at the driver, and reinstalling the app would not have touched it.",
 (True,"driver update fixed it, was about to reinstall the software")),

("windows","shell","The screen is completely stuck - I can move the mouse but nothing responds to clicks",
 ["Establish whether the whole system is frozen or only the shell","Check whether Explorer is responding","Restore the shell without rebooting"],
 [("Get-Process explorer | Select-Object Id, Responding",0," Id Responding\n -- ----------\n5240      False",""),
  ("Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\" | Select-Object PercentProcessorTime",0,"PercentProcessorTime\n--------------------\n                   6",""),
  ("Get-Process | Where-Object { -not $_.Responding } | Select-Object Name, Id",0,"Name       Id\n----       --\nexplorer 5240",""),
  ("Stop-Process -Name explorer -Force; Start-Process explorer",0,"","")],
 True,
 "The mouse moving proves the kernel and graphics stack are alive - only the shell is hung. CPU sits at 6% and Explorer is the sole non-responding process, so a full reboot was unnecessary; restarting Explorer alone brought the desktop back with every application still open.",
 "Ctrl+Shift+Esc still opens Task Manager when the desktop is frozen - use File > Run new task > explorer.exe to do this without a command line. If it recurs, a shell extension is usually responsible; that can be narrowed down separately.",
 (True,"didn't lose any of my open work, brilliant")),

("power","power management","My PC restarts by itself overnight and I lose whatever I had open",
 ["Find out what initiated the restart","Distinguish a crash from a deliberate restart","Check the update configuration"],
 [("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1074} -MaxEvents 3 | Select-Object -ExpandProperty Message",0,"The process C:\\Windows\\uus\\...\\MoUsoCoreWorker.exe has initiated the restart of computer on behalf of user NT AUTHORITY\\SYSTEM: Operating System: Service pack (Planned)",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; Id=41} -MaxEvents 3 -ErrorAction SilentlyContinue",1,"","No events were found that match the specified selection criteria."),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings' -Name ActiveHoursStart, ActiveHoursEnd -ErrorAction SilentlyContinue",0,"ActiveHoursStart : 8\nActiveHoursEnd   : 17","")],
 True,
 "These are planned restarts by Windows Update, not crashes - there are no Kernel-Power 41 events at all. Active hours are set to 08:00-17:00, so Windows considers the night a safe window and restarts to finish installing updates.",
 "Extend active hours to cover the evening, or enable 'Restart this device as soon as possible' so it prompts you instead. Nothing here is faulty - the machine is doing exactly what the update settings permit.",
 (True,"changed active hours to 7am-11pm, no more surprises")),

("display","display","The screen goes black for a second or two while I'm working, then comes back",
 ["Check whether the display driver is recovering from a fault","Look for a pattern in when it happens","Confirm the card itself is healthy"],
 [("Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Display'; Id=4101} -MaxEvents 5 | Select-Object TimeCreated",0,"TimeCreated\n-----------\n8/13/2026 2:41:09 PM\n8/13/2026 1:58:22 PM\n8/13/2026 11:14:47 AM",""),
  ("Get-CimInstance Win32_VideoController | Select-Object Name, Status, DriverVersion",0,"Name                    Status DriverVersion\n----                    ------ -------------\nNVIDIA GeForce RTX 3060 OK     31.0.15.3623",""),
  ("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} -MaxEvents 3 -ErrorAction SilentlyContinue",1,"","(no bugcheck events - the driver recovered each time)")],
 True,
 "The graphics driver is timing out and being reset by Windows - that reset is the black second. It happened three times today and recovered every time, which is why there is no crash and no blue screen. The card reports healthy, so this is the driver rather than failing hardware.",
 "Clean-install the current NVIDIA driver using DDU in Safe Mode, and reset any overclock to stock first. Recovered timeouts are a warning sign: left alone they often progress to a full bugcheck.",
 (True,"clean driver install stopped it")),

("hardware","hardware","The laptop gets really hot and the fan never stops, even when I'm just browsing",
 ["Check whether the CPU is actually loaded","Identify what is consuming it","Distinguish a workload from a cooling problem"],
 [("Get-CimInstance Win32_Processor | Select-Object LoadPercentage, CurrentClockSpeed, MaxClockSpeed",0,"LoadPercentage CurrentClockSpeed MaxClockSpeed\n-------------- ----------------- -------------\n            84              1600          4700",""),
  ("Get-Process | Sort-Object CPU -Descending | Select-Object -First 3 Name, CPU, Id",0,"Name           CPU     Id\n----           ---     --\nSearchIndexer 8241.3 4880\nchrome         912.4 9214",""),
  ("Get-Service WSearch | Select-Object Status",0,"Status\n------\nRunning",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-Search'} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"The protocol handler could not be loaded for an item in the indexed scope","")],
 True,
 "The CPU is genuinely at 84% and clocked down to 1.6 GHz from 4.7 - that is thermal throttling caused by real load, not a cooling fault. The load is the search indexer, which is looping on files it cannot parse and never reaching an idle state, so it never stops working.",
 "Exclude the folder containing the unparseable files from indexing, then rebuild the index. The fan and heat are symptoms of the runaway indexer; the cooling system is doing its job correctly under a load that should not be there.",
 (True,"it was a folder of CAD files, excluded it and the laptop went quiet")),

("power","power management","Battery only lasts about an hour now and it used to last all day",
 ["Compare the battery's current capacity against its design capacity","Check whether an application is the drain","Separate wear from workload"],
 [("Get-CimInstance -ClassName BatteryStaticData -Namespace ROOT\\WMI | Select-Object DesignedCapacity",0,"DesignedCapacity\n----------------\n           52000",""),
  ("Get-CimInstance -ClassName BatteryFullChargedCapacity -Namespace ROOT\\WMI | Select-Object FullChargedCapacity",0,"FullChargedCapacity\n-------------------\n              44200",""),
  ("powercfg /requests",0,"SYSTEM:\n[DRIVER] Realtek High Definition Audio\n\nDISPLAY:\nNone.",""),
  ("Get-Process | Sort-Object CPU -Descending | Select-Object -First 3 Name, CPU",0,"Name          CPU\n----          ---\nTeams      3841.2\nchrome     2104.8","")],
 True,
 "The battery is at 85% of its design capacity, which is normal wear and cannot explain a drop from all day to one hour. The real cause is an audio driver holding a system power request that prevents the machine ever entering low-power idle, combined with Teams consuming CPU continuously.",
 "Update the Realtek audio driver to clear the stuck power request, and check Teams' background settings. Battery wear at 85% would cost you perhaps 15% of runtime - the power request is costing far more than that.",
 (True,"audio driver update got most of the battery life back")),

("power","power management","Laptop is plugged in but the battery still goes down while I'm working",
 ["Check the charging state and power draw","Compare the adapter's rating against the load","Determine whether this is a fault or a capacity limit"],
 [("Get-CimInstance -ClassName BatteryStatus -Namespace ROOT\\WMI | Select-Object PowerOnline, Charging, Discharging, DischargeRate",0,"PowerOnline Charging Discharging DischargeRate\n----------- -------- ----------- -------------\n       True    False        True         12400",""),
  ("Get-CimInstance Win32_Battery | Select-Object BatteryStatus, EstimatedChargeRemaining",0,"BatteryStatus EstimatedChargeRemaining\n------------- ------------------------\n            1                       61",""),
  ("Get-CimInstance Win32_VideoController | Select-Object Name",0,"Name\n----\nIntel(R) Iris Xe Graphics\nNVIDIA GeForce RTX 4060","")],
 True,
 "The adapter is connected and supplying power, but the machine is drawing more than it provides - so the shortfall comes from the battery even while plugged in. With a discrete GPU under load this is normal behaviour for an underpowered charger, typically a lower-wattage USB-C adapter rather than the one supplied.",
 "Use the manufacturer's full-wattage adapter, particularly for GPU work. If you are already using it, check whether the cable is rated for the required wattage - many USB-C cables cap well below what the charger can deliver.",
 (True,"was using the small travel charger, swapped back and it charges fine")),

("file","file management","A load of my files have just disappeared from Documents",
 ["Confirm whether the files are gone or simply not local","Check the folder's actual location","Establish what changed"],
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -Name Personal",0,"Personal : C:\\Users\\jdoe\\OneDrive\\Documents",""),
  ("Get-ChildItem 'C:\\Users\\jdoe\\Documents' -Force -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count\n-----\n    0",""),
  ("Get-ChildItem 'C:\\Users\\jdoe\\OneDrive\\Documents' -Force | Measure-Object | Select-Object Count",0,"Count\n-----\n 3104",""),
  ("Get-Process OneDrive -ErrorAction SilentlyContinue | Select-Object Responding",0,"Responding\n----------\n      True","")],
 True,
 "Nothing has been deleted. Documents was redirected into OneDrive, so the old local folder is empty while all 3,104 files sit under the OneDrive path. Anything opened through a saved shortcut to the old location now finds an empty folder.",
 "Use the Documents entry in the navigation pane rather than old shortcuts, since that follows the redirection. If you would rather have them local again, OneDrive's backup settings can stop managing the folder - but do that from the OneDrive settings, not by moving files by hand.",
 (True,"huge relief, they were all there under OneDrive")),

("file","file management","I downloaded something and now I can't find it anywhere",
 ["Check where the browser actually saved it","Search by recent modification rather than by name","Rule out automatic cleanup"],
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -Name '{374DE290-123F-4565-9164-39C4925E467B}'",0,"{374DE290-...} : D:\\Downloads",""),
  ("Get-ChildItem 'D:\\Downloads' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name, LastWriteTime",0,"Name                    LastWriteTime\n----                    -------------\ninvoice-aug.pdf         8/13/2026 3:41 PM\nsetup-tool.exe          8/13/2026 3:12 PM",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy' -Name 512 -ErrorAction SilentlyContinue",0,"512 : 0  (Downloads cleanup disabled)","")],
 True,
 "The Downloads folder was moved to D: at some point, so the file went there rather than to the Downloads shortcut being checked. Sorting by modification date found it immediately. Storage Sense is not deleting downloads, so nothing was cleaned up.",
 "Sorting by Date modified is the fastest way to find a recent download regardless of its name. If you would prefer downloads back on C:, the folder location can be changed in its Properties, but the existing files would need moving too.",
 (True,"it was on D: the whole time")),

("file","file management","When I double-click this file Windows asks me which program to use",
 ["Identify the file type and whether a handler is registered","Check whether a previous handler was removed","Set an appropriate association"],
 [("Get-Item 'C:\\Users\\jdoe\\Documents\\plan.psd' | Select-Object Extension, Length",0,"Extension Length\n--------- ------\n.psd      4821042",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.psd\\UserChoice' -ErrorAction SilentlyContinue",1,"","(no UserChoice - no default application set)"),
  ("Get-ChildItem 'HKLM:\\SOFTWARE\\Classes\\.psd' -ErrorAction SilentlyContinue",1,"","(no class registered for .psd)")],
 True,
 "No application on this machine has registered itself to open .psd files - the software that used to handle them has been uninstalled, or was never installed here. Windows is asking because it genuinely has no handler, not because an association is broken.",
 "Install an application that opens this format, or use Open with > Choose another app and tick 'Always use this app' to set the association once. Windows Photos can display flattened PSDs if you only need to view it.",
 (True,"forgot Photoshop was on my old laptop")),

("file","file management","My PDFs suddenly all open in the browser instead of the PDF reader",
 ["Check the current association","Determine what changed it","Restore the intended handler"],
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice' -Name ProgId",0,"ProgId : MSEdgePDF",""),
  ("Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object DisplayName -like '*Acrobat*' | Select-Object DisplayName, DisplayVersion",0,"DisplayName                   DisplayVersion\n-----------                   --------------\nAdobe Acrobat Reader          24.2.20857",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Setup'} -MaxEvents 3 -ErrorAction SilentlyContinue | Select-Object TimeCreated, Id",0,"TimeCreated          Id\n-----------          --\n8/12/2026 3:14:02 AM  2","")],
 True,
 "The PDF reader is still installed and working. A Windows update installed the night before reset the .pdf association to Edge - feature and cumulative updates re-assert Microsoft defaults when the existing association's registration fails validation.",
 "Reset it through Settings > Apps > Default apps rather than editing the registry, because Windows validates a hash on that key and a hand-edited value gets reset again at the next update. Choosing it from Settings writes a valid one.",
 (True,"set it from Settings and it stuck this time")),

# ======================= INTERNET =======================
("network","DHCP","Internet just stopped working - it was fine an hour ago",
 ["Work up the stack: adapter, address, gateway, name resolution","Find the first layer that fails","Fix at that layer and re-test"],
 [("Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object Name, LinkSpeed",0,"Name  LinkSpeed\n----  ---------\nWi-Fi 866 Mbps",""),
  ("Get-NetIPConfiguration -InterfaceAlias 'Wi-Fi' | Select-Object IPv4Address, IPv4DefaultGateway",0,"IPv4Address        : 169.254.14.201\nIPv4DefaultGateway :",""),
  ("Test-NetConnection 192.168.1.1 -InformationLevel Quiet",1,"","False"),
  ("ipconfig /release; ipconfig /renew",0,"Wireless LAN adapter Wi-Fi:\n   IPv4 Address. . . . . . . . . . . : 192.168.1.74\n   Default Gateway . . . . . . . . . : 192.168.1.1",""),
  ("Test-NetConnection 8.8.8.8 -InformationLevel Quiet",0,"True","")],
 True,
 "The Wi-Fi link was up but the address was a self-assigned 169.254 one with no gateway, meaning the router never answered the DHCP request. Releasing and renewing pulled a valid lease and connectivity returned immediately.",
 "If the 169.254 address comes back, the router's DHCP pool may be exhausted or its lease table stale - restarting the router clears both. A machine that keeps losing its lease is worth giving a DHCP reservation.",
 (True,"back online in under a minute")),

("network","Wi-Fi","Wi-Fi says connected with full bars but nothing will load",
 ["Confirm the local network works before blaming the internet","Test each layer outward","Identify where the path breaks"],
 [("Get-NetIPConfiguration -InterfaceAlias 'Wi-Fi' | Select-Object IPv4Address, IPv4DefaultGateway",0,"IPv4Address        : 192.168.1.58\nIPv4DefaultGateway : 192.168.1.254",""),
  ("Test-NetConnection 192.168.1.254 -InformationLevel Quiet",0,"True",""),
  ("Test-NetConnection 8.8.8.8 -InformationLevel Quiet",0,"True",""),
  ("Resolve-DnsName microsoft.com -ErrorAction SilentlyContinue",1,"","Resolve-DnsName : microsoft.com : DNS name does not exist"),
  ("Get-DnsClientServerAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi' | Select-Object ServerAddresses",0,"ServerAddresses\n---------------\n{10.0.0.254}","")],
 True,
 "The router responds and raw internet addresses are reachable, so the connection itself is fine. Name resolution is the failure: the adapter is still configured with a DNS server from a previous network that does not exist here, so no website name can be turned into an address.",
 "Set the adapter's DNS back to automatic so it takes the router's setting. Manually configured DNS follows you between networks and breaks browsing on every network except the one it was set for.",
 (True,"was set to my old office DNS from months ago")),

("network","Wi-Fi","Wi-Fi keeps dropping every few minutes at home but is fine at the office",
 ["Rule out signal and power settings","Look for competing access points on the same name","Explain the location-specific behaviour"],
 [("netsh wlan show interfaces",0,"    SSID                   : HomeNet\n    Signal                 : 78%\n    Radio type             : 802.11ac\n    Channel                : 6",""),
  ("Get-NetAdapterPowerManagement -Name 'Wi-Fi' | Select-Object AllowComputerToTurnOffDevice",0,"AllowComputerToTurnOffDevice\n----------------------------\n                    Disabled",""),
  ("netsh wlan show networks mode=bssid | Select-String 'SSID|Signal|Channel' | Select-Object -First 9",0,"SSID 1 : HomeNet\n    Signal : 78%\n    Channel: 6\n    Signal : 74%\n    Channel: 36","")],
 True,
 "Signal is adequate and adapter power saving is already off, so neither explains the drops. Two access points broadcast the same network name on different bands, and the laptop sits at a distance where it repeatedly re-evaluates and switches between them - each switch is a brief disconnection.",
 "On the router, give the 5 GHz band a distinct name and connect to that one specifically, or enable band steering properly if the hardware supports it. The office network does not do this, which is why the problem follows the location rather than the laptop.",
 (True,"split the bands and it's been solid since")),

("network","Wi-Fi","Can't connect to my phone's hotspot from the laptop, other devices connect fine",
 ["Check whether the laptop can see the hotspot at all","Compare the band the phone is using against the adapter's capability","Confirm the limitation"],
 [("netsh wlan show networks | Select-String 'MyPhone'",1,"","(hotspot not listed in the scan results)"),
  ("netsh wlan show drivers | Select-String 'Radio types supported'",0,"    Radio types supported  : 802.11b 802.11g 802.11n",""),
  ("netsh wlan show networks mode=bssid | Select-String 'Channel' | Select-Object -First 4",0,"    Channel: 1\n    Channel: 6\n    Channel: 11","")],
 True,
 "The laptop's adapter supports only 2.4 GHz standards - there is no 802.11ac or ax in its radio list. The phone is broadcasting its hotspot on 5 GHz, which this adapter physically cannot see, which is why the network never appears in the scan while other devices connect normally.",
 "Switch the phone's hotspot band to 2.4 GHz in its hotspot settings - most phones offer this as a compatibility option. The alternative is a USB Wi-Fi adapter that supports 5 GHz; the built-in one cannot be made to work by any driver change.",
 (True,"changed the phone to 2.4 GHz and it appeared straight away")),

("network","DNS","One particular website won't open but everything else is fine",
 ["Check whether the name resolves","Compare against a public resolver","Test the connection separately from the browser"],
 [("Resolve-DnsName shop.example.com | Select-Object Name, IPAddress",0,"Name              IPAddress\n----              ---------\nshop.example.com  203.0.113.44",""),
  ("Resolve-DnsName shop.example.com -Server 1.1.1.1 | Select-Object IPAddress",0,"IPAddress\n---------\n198.51.100.20",""),
  ("Test-NetConnection 203.0.113.44 -Port 443 -InformationLevel Quiet",1,"","False"),
  ("Test-NetConnection 198.51.100.20 -Port 443 -InformationLevel Quiet",0,"True",""),
  ("Clear-DnsClientCache",0,"","")],
 True,
 "The local resolver returns a stale address that no longer hosts the site, while a public resolver returns the current one - and only the current address accepts connections. The site moved servers and this machine cached the old record past its usefulness.",
 "Flushing the cache resolves it immediately. If it recurs for other sites, the router's DNS proxy is caching too aggressively; setting the adapter to use a public resolver directly avoids that middle layer.",
 (True,"cleared the cache and the site loaded")),

("network","proxy","Websites work in Edge but not in Chrome on the same laptop",
 ["Confirm the network path is healthy","Compare what each browser uses for DNS","Identify the browser-specific setting"],
 [("Test-NetConnection www.google.com -Port 443 -InformationLevel Quiet",0,"True",""),
  ("Resolve-DnsName intranet.corp.local | Select-Object IPAddress",0,"IPAddress\n---------\n10.0.5.20",""),
  ("Get-DnsClientDohServerAddress -ErrorAction SilentlyContinue | Select-Object ServerAddress, DohTemplate",0,"ServerAddress DohTemplate\n------------- -----------\n1.1.1.1       https://cloudflare-dns.com/dns-query","")],
 True,
 "Windows itself resolves and connects fine. Chrome is using its own Secure DNS setting, sending lookups to a public resolver over HTTPS - that resolver knows nothing about internal names, so internal sites fail in Chrome while Edge, which is using the system resolver, works.",
 "Turn off Use secure DNS in Chrome's privacy settings, or set it to 'With your current service provider'. On a machine that needs internal names, browser-level DNS bypasses the resolver that knows about them.",
 (True,"turned off secure DNS and the intranet works again")),

("network","SMB","Can't get into the shared folder at work even though I'm connected to the VPN",
 ["Confirm the VPN tunnel is up and routing","Test whether the file server is reachable","Check name resolution for internal hosts"],
 [("Get-NetAdapter | Where-Object InterfaceDescription -like '*VPN*' | Select-Object Name, Status",0,"Name      Status\n----      ------\nCorpVPN   Up",""),
  ("Resolve-DnsName fileserver.corp.local -ErrorAction SilentlyContinue",1,"","Resolve-DnsName : fileserver.corp.local : DNS name does not exist"),
  ("Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, ServerAddresses",0,"InterfaceAlias ServerAddresses\n-------------- ---------------\nWi-Fi          {192.168.1.1}\nCorpVPN        {10.0.0.10}",""),
  ("Get-NetIPInterface -AddressFamily IPv4 | Select-Object InterfaceAlias, InterfaceMetric | Sort-Object InterfaceMetric",0,"InterfaceAlias InterfaceMetric\n-------------- ---------------\nWi-Fi                       25\nCorpVPN                     45","")],
 True,
 "The tunnel is up and the VPN does supply an internal DNS server, but the Wi-Fi adapter has a lower metric, so Windows queries the home router first. It has no idea what fileserver.corp.local is, and the lookup fails before the VPN's resolver is ever consulted.",
 "Lower the VPN interface metric below the physical adapter so its DNS is queried first. Reaching the share by IP address would work as a stopgap, but fixing the metric is what makes every internal name resolve properly.",
 (True,"IT changed the metric on the VPN profile, works now")),

# ======================= AUDIO / VIDEO =======================
("audio","audio","No sound at all from the laptop speakers",
 ["Check the audio services are running","Look at which device is set as default","Confirm the speakers are actually selected"],
 [("Get-Service AudioSrv, AudioEndpointBuilder | Select-Object Name, Status",0,"Name                 Status\n----                 ------\nAudioSrv             Running\nAudioEndpointBuilder Running",""),
  ("Get-PnpDevice -Class AudioEndpoint | Select-Object Status, FriendlyName",0,"Status FriendlyName\n------ ------------\nOK     Speakers (Realtek Audio)\nOK     LG TV (NVIDIA High Definition Audio)",""),
  ("Get-CimInstance Win32_SoundDevice | Select-Object Name, Status",0,"Name             Status\n----             ------\nRealtek(R) Audio OK","")],
 True,
 "Both audio services are running and the speakers are present and healthy. The default playback device is the LG TV over HDMI, left over from when the laptop was last connected to it - so all sound is being sent to a display that is no longer attached.",
 "Click the volume icon and pick Speakers (Realtek Audio) as the output. Windows remembers the last-used device per connection, so this recurs whenever the HDMI display is unplugged while it is the default.",
 (True,"sound was going to a TV in another room, so obvious now")),

("audio","audio","Sound is really quiet even with the volume at maximum",
 ["Check the system and per-application volume separately","Look at enhancement settings","Identify what is limiting the output"],
 [("Get-CimInstance Win32_SoundDevice | Select-Object Name, Status",0,"Name             Status\n----             ------\nRealtek(R) Audio OK",""),
  ("Get-PnpDevice -Class AudioEndpoint | Where-Object Status -eq 'OK' | Select-Object FriendlyName",0,"FriendlyName\n------------\nSpeakers (Realtek Audio)",""),
  ("Get-Process | Where-Object { $_.Name -match 'Teams|Discord|zoom' } | Select-Object Name, Id",0,"Name  Id\n----  --\nTeams 6120","")],
 True,
 "The device is healthy and the system volume is at maximum, so the limit is being applied after that. Teams is running and its communications setting is reducing all other sounds when it detects call activity - a per-application ducking behaviour rather than a volume control.",
 "Set 'Do nothing' under Sound Control Panel > Communications, which stops Windows reducing other audio during calls. Also check the per-app volume in the volume mixer, since an application slider set low overrides the master volume.",
 (True,"the communications setting was the culprit")),

("audio","audio","Headphones don't do anything when I plug them into the laptop",
 ["Check whether Windows detects the plug event at all","Look at the jack detection configuration","Determine whether it is the jack or the device"],
 [("Get-PnpDevice -Class AudioEndpoint | Select-Object Status, FriendlyName",0,"Status FriendlyName\n------ ------------\nOK     Speakers (Realtek Audio)",""),
  ("Get-CimInstance Win32_PnPSignedDriver | Where-Object DeviceName -like '*Realtek*Audio*' | Select-Object DriverProviderName, DriverVersion, DriverDate",0,"DriverProviderName DriverVersion DriverDate\n------------------ ------------- ----------\nMicrosoft          10.0.26100.1  2024-01-01","")],
 True,
 "No headphone endpoint appears when the jack is used, and the audio driver is the generic Microsoft one rather than Realtek's. The generic driver handles basic playback but does not implement the jack-detection logic this laptop's codec needs, so plugging in is never registered.",
 "Install the Realtek audio driver from the laptop vendor's support page. The generic driver working for speakers is exactly why this looks like a broken jack - the hardware is fine, the detection layer is missing.",
 (True,"vendor driver fixed it, headphones switch automatically now")),

("audio","audio","My microphone works in Sound settings but nobody can hear me in Teams",
 ["Confirm the microphone works at system level","Check the per-application permission","Check what device the application is using"],
 [("Get-PnpDevice -Class AudioEndpoint | Where-Object FriendlyName -like '*Microphone*' | Select-Object Status, FriendlyName",0,"Status FriendlyName\n------ ------------\nOK     Microphone Array (Realtek Audio)",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone' -Name Value",0,"Value : Allow",""),
  ("Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object PSChildName -like '*Teams*' | Select-Object PSChildName, Value",0,"PSChildName                Value\n-----------                -----\nC##?#C:#Program Files#Teams Deny","")],
 True,
 "The microphone hardware works and the global microphone permission is allowed - but there is a second, per-application permission layer for desktop apps, and Teams specifically is set to Deny. That is why the level meter moves in Settings while Teams receives silence.",
 "Turn Teams on under Settings > Privacy & security > Microphone > Let desktop apps access your microphone. The per-app list is separate from the master toggle, which is why the global setting looked correct.",
 (True,"the per-app list was scrolled down, Teams was off")),

("hardware","camera/biometrics","Camera says it's being used by another app but I can't find which one",
 ["Identify what currently holds the camera","Check the recent access history","Release it without rebooting"],
 [("Get-PnpDevice -Class Camera | Select-Object Status, FriendlyName",0,"Status FriendlyName\n------ ------------\nOK     Integrated Camera",""),
  ("Get-Process | Where-Object { $_.Name -match 'Teams|zoom|Skype|obs|chrome' } | Select-Object Name, Id, MainWindowTitle",0,"Name  Id   MainWindowTitle\n----  --   ---------------\nTeams 4412\nchrome 9214 Meet - Google Chrome",""),
  ("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam\\NonPackaged' -ErrorAction SilentlyContinue | Select-Object LastUsedTimeStop",0,"LastUsedTimeStop : 0   (a non-packaged app currently has it open)","")],
 True,
 "A Google Meet tab is still open in Chrome and holding the camera, with Teams also running in the background. The LastUsedTimeStop value of 0 confirms an application currently has it open rather than having released it - only one application can use the camera at a time.",
 "Close the Meet tab, or quit Chrome entirely if the tab is not obvious. Windows shows which apps recently used the camera under Privacy & security > Camera > Recent activity, which is the quickest way to identify the holder next time.",
 (True,"had a Meet tab open from this morning")),

("display","display","Nothing appears on the second monitor even though the cable is plugged in",
 ["Check whether Windows sees a second display at all","Confirm the connection type supports video","Identify the limiting component"],
 [("Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBasicDisplayParams | Measure-Object | Select-Object Count",0,"Count\n-----\n    1",""),
  ("Get-PnpDevice -Class Monitor | Select-Object Status, FriendlyName",0,"Status FriendlyName\n------ ------------\nOK     Generic PnP Monitor",""),
  ("Get-CimInstance Win32_VideoController | Select-Object Name, CurrentHorizontalResolution",0,"Name                      CurrentHorizontalResolution\n----                      ---------------------------\nIntel(R) Iris Xe Graphics                        1920","")],
 True,
 "Windows detects only one display, so the second monitor is not reaching the graphics stack at all. The laptop is connected through a USB-C cable that carries power and data but not DisplayPort Alt Mode - a charge-only cable looks identical to a full-featured one.",
 "Use a cable explicitly rated for video over USB-C, or connect via the HDMI port instead. If a video-capable cable still shows one display, check the monitor's input source setting before suspecting the laptop.",
 (True,"borrowed a proper cable and it worked immediately")),

("audio","audio","No sound when I connect the laptop to the TV with HDMI",
 ["Check whether an HDMI audio endpoint exists","Confirm which device is default","Verify the TV can accept the format being sent"],
 [("Get-PnpDevice -Class AudioEndpoint | Select-Object Status, FriendlyName",0,"Status FriendlyName\n------ ------------\nOK     Speakers (Realtek Audio)\nOK     Samsung TV (Intel Display Audio)",""),
  ("Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBasicDisplayParams | Measure-Object | Select-Object Count",0,"Count\n-----\n    2",""),
  ("Get-CimInstance Win32_SoundDevice | Select-Object Name, Status",0,"Name                 Status\n----                 ------\nIntel Display Audio  OK","")],
 True,
 "Video is working and an HDMI audio endpoint for the TV exists and is healthy - it is simply not the default device, so sound continues going to the laptop speakers. HDMI carries audio and video separately, and Windows does not switch audio automatically on every connection.",
 "Select the TV under the volume icon's output list. If it disappears when the TV is off, that is normal - the endpoint only exists while the display is powered and on the correct input.",
 (True,"just had to pick the TV in the output list")),

# ======================= ACCOUNTS =======================
("security","account security","Forgot my PIN - is there any way back in without wiping the laptop?",
 ["Establish which sign-in options are configured","Confirm the account type","Identify the recovery path"],
 [("Get-LocalUser | Where-Object Enabled -eq $true | Select-Object Name, PrincipalSource",0,"Name PrincipalSource\n---- ---------------\njdoe MicrosoftAccount",""),
  ("Get-Tpm | Select-Object TpmPresent, TpmReady",0,"TpmPresent TpmReady\n---------- --------\n      True     True",""),
  ("Get-BitLockerVolume -MountPoint C: | Select-Object ProtectionStatus",0,"ProtectionStatus\n----------------\n              On","")],
 True,
 "This is a Microsoft account, which means the PIN is only one of several sign-in methods - the account password still works and is not stored on this device. There is no need for any reset that would risk data, and BitLocker being on makes a wipe-and-reinstall actively dangerous without the recovery key.",
 "At the sign-in screen choose 'Sign-in options' and use your Microsoft account password, then set a new PIN from Settings once inside. Before doing anything more drastic, confirm your BitLocker recovery key is saved to your Microsoft account.",
 (True,"the password option was right there, felt silly")),

("security","account security","Windows keeps saying my PIN isn't available and asks me to set it up again every time",
 ["Check the PIN container state","Confirm the TPM is healthy","Determine whether this is repairable in place"],
 [("Get-Tpm | Select-Object TpmPresent, TpmReady, TpmOwned",0,"TpmPresent TpmReady TpmOwned\n---------- -------- --------\n      True     True     True",""),
  ("Get-ChildItem 'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Local\\Microsoft\\Ngc' -Force -ErrorAction SilentlyContinue | Measure-Object | Select-Object Count",0,"Count\n-----\n    0",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-HelloForBusiness/Operational'} -MaxEvents 2 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Message",0,"The user's PIN credential provisioning failed: key container not found","")],
 True,
 "The TPM is healthy and owned, but the Ngc folder that holds the PIN's key container is empty - so each setup attempt writes a container that is not there on the next sign-in. This typically follows a TPM firmware update or an interrupted profile operation.",
 "Use 'I forgot my PIN' on the sign-in options page, which rebuilds the container from scratch rather than reusing the broken one. Clearing the TPM is not required and would trigger BitLocker recovery unnecessarily.",
 (True,"the forgot-PIN route rebuilt it properly")),

("security","account security","It says my account is locked out but I've only typed the password twice",
 ["Check the lockout state and bad password count","Find where the failed attempts originate","Distinguish user error from a background source"],
 [("Get-LocalUser jdoe | Select-Object Name, Enabled, PrincipalSource",0,"Name Enabled PrincipalSource\n---- ------- ---------------\njdoe    True ActiveDirectory",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625} -MaxEvents 5 | Select-Object TimeCreated",0,"TimeCreated\n-----------\n8/13/2026 9:02:14 AM\n8/13/2026 9:02:11 AM\n8/13/2026 9:02:08 AM",""),
  ("cmdkey /list | Select-String 'Target'",0,"Target: Domain:target=fileserver.corp.local\nTarget: Domain:target=mail.corp.local","")],
 True,
 "Three failed attempts arrived within six seconds - far faster than anyone types. Saved credentials for two internal servers still hold the previous password and retry automatically, consuming the lockout allowance before the user's own attempts are even counted.",
 "Remove the stale entries from Credential Manager, then have the account unlocked. Until those saved credentials are cleared, unlocking will only last until the next automatic retry.",
 (True,"deleted two saved credentials and it stopped locking")),

("security","permissions","It says I need administrator permission but my account IS the administrator",
 ["Check the account's group membership","Check the elevation state of the current session","Explain the distinction"],
 [("whoami /groups | Select-String 'Administrators'",0,"BUILTIN\\Administrators  Alias  S-1-5-32-544  Group used for deny only",""),
  ("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",0,"False",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name EnableLUA, ConsentPromptBehaviorAdmin",0,"EnableLUA                  : 1\nConsentPromptBehaviorAdmin : 5","")],
 True,
 "The account is an administrator, but the group membership shows as 'used for deny only' - User Account Control issues a filtered token for normal work and only grants the full one when a process is explicitly elevated. Being an admin and running as admin are two different things.",
 "Right-click the application and choose Run as administrator, or use Windows Terminal (Admin). This is by design and is one of the more effective protections in Windows - do not disable UAC to work around it.",
 (True,"never understood that distinction before")),

("security","account security","Windows keeps popping up asking me to sign in to my Microsoft account",
 ["Check the account's connection state","Look for what triggers the prompt","Identify which component lost its token"],
 [("Get-LocalUser | Where-Object PrincipalSource -eq 'MicrosoftAccount' | Select-Object Name",0,"Name\n----\njdoe",""),
  ("dsregcmd /status | Select-String 'WorkplaceJoined|AzureAdJoined|NgcSet'",0,"AzureAdJoined : NO\nWorkplaceJoined : NO\nNgcSet : YES",""),
  ("cmdkey /list | Select-String 'MicrosoftAccount|MicrosoftOffice'",0,"Target: MicrosoftAccount:user=jdoe@outlook.com","")],
 True,
 "The account is a personal Microsoft account with a saved credential that no longer validates - the password was changed on another device, so every service that relied on the cached token now prompts. Nothing is broken; the stored credential is simply out of date.",
 "Sign in once through Settings > Accounts > Your info, which refreshes the token for all the dependent services at once. Signing in through an individual prompt often only fixes that one component.",
 (True,"changed my password on my phone last week, that explains it")),

("windows","AppX/Store","Microsoft Store won't open at all - it flashes and closes",
 ["Check the package state","Check the supporting services","Repair without reinstalling everything"],
 [("Get-AppxPackage -Name 'Microsoft.WindowsStore' | Select-Object Name, Version, Status",0,"Name                   Version        Status\n----                   -------        ------\nMicrosoft.WindowsStore 22408.1401.4.0 Modified",""),
  ("Get-Service ClipSVC, InstallService | Select-Object Name, Status",0,"Name           Status\n----           ------\nClipSVC        Running\nInstallService Stopped",""),
  ("Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000} -MaxEvents 2 | Select-Object -ExpandProperty Message",0,"Faulting application name: WinStore.App.exe","")],
 True,
 "The Store package reports a Modified status, meaning its files no longer match the signed manifest, and the Install Service that it depends on is stopped. Both need addressing - starting the service alone would leave a package that still fails validation.",
 "Start the Microsoft Store Install Service, then run 'wsreset.exe' to clear the cache. If the status stays Modified, re-register the package with Add-AppxPackage against its manifest rather than attempting to uninstall the Store.",
 (True,"wsreset after starting the service sorted it")),

("windows","system configuration","My laptop clock is always wrong and it keeps changing itself back",
 ["Check the time service state and its source","Compare against a reference","Identify why sync fails"],
 [("w32tm /query /status",0,"Leap Indicator: 3(not synchronized)\nSource: Local CMOS Clock\nLast Successful Sync Time: unspecified",""),
  ("Get-Service W32Time | Select-Object Status, StartType",0,"Status  StartType\n------  ---------\nRunning    Manual",""),
  ("Get-TimeZone | Select-Object Id, BaseUtcOffset",0,"Id                      BaseUtcOffset\n--                      -------------\nPacific Standard Time      -08:00:00",""),
  ("w32tm /resync",1,"","The computer did not resync because no time data was available.")],
 True,
 "The time service is running but has never successfully synchronised - it is falling back to the hardware clock. The time zone is also set to Pacific while the machine is being used elsewhere, so even a correct sync would show the wrong local time.",
 "Set the correct time zone first, then point the time service at a reachable source and resync. If the clock also drifts while powered off, the CMOS battery is failing and should be replaced.",
 (True,"time zone was wrong from when I bought it secondhand")),
]

# ---------------------------------------------------------------- build
with open(JSON_PATH, encoding="utf-8") as f: data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f: jsonl_lines = [l for l in f if l.strip()]

existing_goals = {d["goal"] for d in data}
prefix = collections.defaultdict(list)
for g in existing_goals: prefix[' '.join(g.lower().split()[:4])].append(g)

base = datetime(2026, 8, 14, 9, 0, 0)
added = skipped = 0
near = []
for i, (dom, sub, goal, plan, cmds, resolved, summary, rec, fb) in enumerate(NEW):
    if goal in existing_goals: skipped += 1; continue
    k = ' '.join(goal.lower().split()[:4])
    if k in prefix: near.append((goal, prefix[k][0]))
    created = base + timedelta(minutes=8*i)
    steps = [{"command": c, "blocked": False, "exitCode": e, "stdout": o, "stderr": er, "reason": None}
             for c, e, o, er in cmds]
    data.append({
        "id": str(uuid.uuid4()),
        "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal, "domain": dom, "subdomain": sub,
        "plan": list(plan), "steps": steps, "resolved": resolved,
        "summary": summary, "recommendation": rec,
        "feedback": {"worked": fb[0], "note": fb[1],
                     "at": (created+timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}})
    existing_goals.add(goal); prefix[k].append(goal); added += 1
    cl = "\n".join(f"- {c[0]}" + (f"  [FAILED: {c[3][:70]}]" if c[1] else "") for c in cmds)
    note = "" if resolved else "\nNOTE: not resolved - see recommendation."
    jsonl_lines.append(json.dumps({"messages":[
        {"role":"system","content":f"You are a Windows repair expert specializing in {dom} ({sub}) problems. Diagnose with read-only commands first, then apply safe fixes. When a command fails, interpret the error and adapt."},
        {"role":"user","content":goal},
        {"role":"assistant","content":f"{summary}\nCommands used:\n{cl}\nRecommendation: {rec}{note}"}]}, ensure_ascii=False)+"\n")

with open(JSON_PATH,"w",encoding="utf-8") as f: json.dump(data,f,indent=2,ensure_ascii=False); f.write("\n")
with open(JSONL_PATH,"w",encoding="utf-8") as f: f.writelines(jsonl_lines)

print(f"added: {added} | exact dups skipped: {skipped} | prefix collisions: {len(near)}")
for a,b in near: print("  NEAR:", a[:52], "<>", b[:52])
print("Total JSON:", len(data), "| Total JSONL:", len(jsonl_lines))
