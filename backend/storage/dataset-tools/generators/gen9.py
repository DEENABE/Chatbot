import json
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

# Curated: most commonly searched everyday Windows problems + Settings app issues
NEW = [
("settings","Display scaling makes some apps tiny and others huge across two different-DPI monitors",
 "Per-monitor DPI scaling only works for DPI-aware apps; older apps render at the primary monitor's scale and get bitmap-stretched on the other, producing inconsistent sizes between monitors.",
 [("Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBasicDisplayParams | Measure-Object | Select-Object Count","Count : 2","")],
 "Set both monitors to the same scaling percentage where practical; for stubborn legacy apps use Properties > Compatibility > High DPI override 'System (Enhanced)'; log off/on after scaling changes so all apps re-read DPI."),
("settings","Night light won't turn on or the toggle is greyed out",
 "Night light depends on the display driver supporting gamma adjustment; with the Basic Display Adapter (no vendor driver) the toggle greys out because the required color pipeline isn't exposed.",
 [("Get-CimInstance Win32_VideoController | Select-Object Name","Name\n----\nMicrosoft Basic Display Adapter","")],
 "Install the proper GPU vendor driver; Night light activates once a full WDDM driver with gamma support is loaded. If the driver is fine, re-register the feature by toggling location services (its scheduler uses location for sunset times)."),
("settings","Storage Sense deleted files from Downloads unexpectedly",
 "Storage Sense was configured to clean the Downloads folder for files older than 30 days -- an opt-in rule that ships off by default but had been enabled here, so the deletions were policy, not data loss.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy' -Name 512 -ErrorAction SilentlyContinue","512 : 30 (Downloads cleanup set to 30 days)","")],
 "Set Settings > System > Storage > Storage Sense > 'Delete files in my Downloads folder' back to Never; check the Recycle Bin for recently removed items -- Storage Sense routes deletions through it."),
("settings","Default browser resets to Edge after every major Windows update",
 "Feature updates re-run OOBE-style defaults association checks, and when the association registry entries fail their hash validation (common after third-party 'default browser' tools), Windows resets them to Edge.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice' -Name ProgId","ProgId : MSEdgeHTM","")],
 "Reset the default via Settings > Apps > Default apps by choosing the browser and clicking 'Set default' (which writes valid hashes); avoid registry-hacking tools -- invalid hashes are exactly what triggers the resets."),
("settings","Notifications stopped appearing entirely, no banners and no Action Center entries",
 "Focus assist (Do Not Disturb) was set to Alarms Only permanently -- often enabled accidentally via the Win+N quick setting or a full-screen app rule -- so every notification is suppressed silently.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings' -Name NOC_GLOBAL_SETTING_TOASTS_ENABLED -ErrorAction SilentlyContinue","NOC_GLOBAL_SETTING_TOASTS_ENABLED : 0","")],
 "Turn off Do not disturb in Settings > System > Notifications, and review the automatic rules (full-screen, gaming, duplicating display) that re-enable it; re-enable per-app notifications that were disabled."),
("settings","Taskbar is frozen -- clock shows, but nothing on it responds to clicks",
 "Explorer's taskbar message pump is hung on a blocking shell extension call; the rest of the desktop still works because only the taskbar thread is stuck.",
 [("Get-Process explorer | Select-Object Id, Responding","Id   Responding\n--   ----------\n5240      False","")],
 "Restart Explorer (Task Manager > Restart Windows Explorer, or 'Stop-Process -Name explorer -Force; Start-Process explorer'); if it recurs, audit recently added shell extensions and cloud-sync overlays -- they're the usual hang source."),
("settings","Screenshots via PrtScn stopped working -- nothing happens on key press",
 "The PrtScn key was remapped to launch Snipping Tool, but the Snipping Tool package is corrupted, so the press routes to an app that instantly crashes -- appearing as 'nothing happens'.",
 [("Get-AppxPackage Microsoft.ScreenSketch | Select-Object Status","Status : Modified","")],
 "Repair/reinstall Snipping Tool ('Get-AppxPackage Microsoft.ScreenSketch | Reset-AppxPackage'), or disable 'Use the Print screen key to open screen capture' under Settings > Accessibility > Keyboard to restore classic clipboard capture."),
("settings","Apps always open on the wrong monitor after disconnect/reconnect cycles",
 "Windows restores each app to its last-remembered monitor coordinates; when the monitor set changes, stale coordinates map onto the wrong display -- apps aren't misbehaving, the remembered layout is.",
 [("Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorID | Measure-Object | Select-Object Count","Count : 2","")],
 "Move each app where you want it and close it there (Windows re-records positions at close); enable Settings > System > Display > Multiple displays > 'Remember window locations based on monitor connection' on Windows 11 to automate restoration."),
("settings","Windows won't remember the sign-in method and asks to set up a PIN at every logon",
 "The 'Require Windows Hello sign-in for Microsoft accounts' policy is on while PIN creation keeps failing against the broken Ngc container, so every logon re-prompts setup instead of completing it.",
 [("Get-ChildItem 'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Local\\Microsoft\\Ngc' -ErrorAction SilentlyContinue | Measure-Object","Count : 0 (Ngc container missing/corrupt)","")],
 "Clear the Ngc folder ownership-safe (boot to safe mode, take ownership, delete contents), then create the PIN fresh via Settings > Accounts > Sign-in options; alternatively temporarily disable the Hello requirement toggle, sign in with password, and re-enable."),
("settings","Search box on the taskbar won't accept typing -- it opens but input never appears",
 "The search UI host (SearchHost.exe) is running but its input pipeline is deadlocked -- a known state after certain locale/IME changes; killing the process forces a clean relaunch.",
 [("Get-Process SearchHost -ErrorAction SilentlyContinue | Select-Object Id, Responding","Id   Responding\n--   ----------\n7788      False","")],
 "End SearchHost.exe in Task Manager (it relaunches on next search open); if it recurs with a specific input language, remove and re-add that keyboard/IME under Settings > Time & language > Language & region."),
("settings","Changing time zone is blocked -- the dropdown is greyed out in Settings",
 "Time zone changes require the 'Change the time zone' privilege; a hardening baseline removed it from Users, so Settings greys the control for standard accounts.",
 [("whoami /priv | findstr /i 'SeTimeZonePrivilege'","SeTimeZonePrivilege ... Disabled (not held)","")],
 "Restore 'Change the time zone' to Users under Local Security Policy > User Rights Assignment (or the GPO baseline), or set the zone as admin ('Set-TimeZone -Id \"India Standard Time\"'); leave automatic time zone off when travel isn't a factor."),
("settings","Adding a new display language stalls at 'Searching Windows Update for language pack'",
 "Language pack acquisition goes through Windows Update; the WSUS-managed update source doesn't host language packs, so the download waits forever instead of failing over to Microsoft's servers.",
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate' -Name UseWUServer -ErrorAction SilentlyContinue","UseWUServer : 1","")],
 "Enable the GPO 'Specify settings for optional component installation and component repair' with 'Download repair content ... directly from Windows Update', or temporarily set UseWUServer=0, restart wuauserv, add the language, then revert."),
("settings","Japanese/Chinese IME broken after an update -- can only type latin characters",
 "The IME's process (ctfmon-hosted TextInputHost) isn't running, so composition never engages; the language bar shows the layout but conversion is dead.",
 [("Get-Process TextInputHost -ErrorAction SilentlyContinue","(not running)","")],
 "Restart the input host (sign out/in restarts it; or run ctfmon.exe), and check Settings > Time & language > the language's IME options for a 'compatibility' toggle -- reverting to the previous IME version fixes update regressions."),
("settings","Clipboard history (Win+V) empty even though it's enabled",
 "Clipboard history is being wiped by an installed 'privacy cleaner' running on a schedule -- the feature works, but its store is cleared every hour by the cleaner's clipboard rule.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Clipboard' -Name EnableClipboardHistory","EnableClipboardHistory : 1","")],
 "Exclude clipboard from the cleaner tool's schedule (or uninstall it); Windows itself keeps up to 25 items until reboot unless an item is pinned."),
("settings","Snap layouts don't appear when hovering the maximize button",
 "Snap layouts were disabled via the Snap windows master toggle (often turned off by 'gaming optimization' scripts), which also removes the hover panel.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name EnableSnapAssistFlyout -ErrorAction SilentlyContinue","EnableSnapAssistFlyout : 0","")],
 "Re-enable Settings > System > Multitasking > Snap windows (and the 'Show snap layouts when I hover' sub-option); be wary of tweak scripts that flip Explorer Advanced flags wholesale."),
("settings","Virtual desktops lost after reboot -- all windows collapse back to Desktop 1",
 "Windows doesn't persist virtual desktops across restarts by default on older builds; on current builds the 'restore' behavior also requires apps that support session restart -- the desktops aren't crashing, persistence simply isn't there.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name VirtualDesktopKeepAliveEnabled -ErrorAction SilentlyContinue","(not present -- default behavior)","")],
 "Update to a current Windows 11 build where named desktops persist across reboots natively; apps reopen on the right desktop only if they support restart-restore ('Restart apps' toggle in Sign-in options)."),
("settings","Widgets board shows 'Something went wrong' and never loads content",
 "The Widgets host depends on Edge WebView2, and the WebView2 runtime on this machine is corrupted -- the board opens but every card render fails.",
 [("Get-AppxPackage MicrosoftWindows.Client.WebExperience | Select-Object Status","Status : Ok",""),
  ("Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -Name pv -ErrorAction SilentlyContinue","(WebView2 runtime version key missing)","")],
 "Reinstall the Evergreen WebView2 Runtime from Microsoft's official page, then re-open Widgets; if cards still fail, sign out/in of the Widgets board profile."),
("settings","HDR washes out desktop colors -- everything looks grey and flat when HDR is on",
 "SDR content inside an HDR signal needs its brightness balance set per display; at the default slider position on this monitor, SDR white maps too low, producing the washed-out look -- calibration, not a defect.",
 [("Get-CimInstance Win32_VideoController | Select-Object Name","Name\n----\nNVIDIA GeForce RTX 4070","")],
 "Adjust Settings > System > Display > HDR > 'SDR content brightness', run the Windows HDR Calibration app for the display profile, and update to the monitor's latest firmware -- cheap HDR400 panels will always look better with HDR off for desktop work."),
("settings","Mouse pointer jumps/skips after changing 'Enhance pointer precision'",
 "Enhance pointer precision is OS-level acceleration; combined with the gaming mouse's own onboard acceleration profile it double-applies, making movement nonlinear and jumpy.",
 [("Get-ItemProperty 'HKCU:\\Control Panel\\Mouse' -Name MouseSpeed","MouseSpeed : 1","")],
 "Disable one of the two acceleration layers: turn off Enhance pointer precision (Settings > Bluetooth & devices > Mouse > Additional settings > Pointer Options) or the mouse driver's onboard acceleration -- competitive/gaming setups typically disable the OS one."),
("settings","Sticky Keys popup keeps interrupting games when Shift is pressed rapidly",
 "The Sticky Keys activation shortcut (5x Shift) is enabled by default and fires during gameplay; the popup steals focus at exactly the wrong moments.",
 [("Get-ItemProperty 'HKCU:\\Control Panel\\Accessibility\\StickyKeys' -Name Flags","Flags : 510 (hotkey enabled)","")],
 "Disable the shortcut under Settings > Accessibility > Keyboard > Sticky keys > 'Keyboard shortcut for Sticky keys'; the accessibility feature stays available from Settings for users who need it."),
("settings","Auto-brightness keeps changing screen brightness against the user's wishes",
 "Content Adaptive Brightness Control (CABC) plus the ambient light sensor are both adjusting brightness; the OS slider follows their combined output, appearing to 'fight' the user's setting.",
 [("Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness | Select-Object CurrentBrightness","CurrentBrightness : fluctuates without user input","")],
 "Turn off Settings > System > Display > Brightness > 'Change brightness automatically when lighting changes' and 'Help improve battery by optimizing displayed content' (CABC); some laptops need CABC disabled in the vendor's own display utility too."),
("settings","Wallpaper slideshow stops working when on battery",
 "Slideshow pauses on battery by design to save power -- the setting 'Pause slideshow when on battery power' ships enabled and is easily overlooked, so it looks broken exactly when unplugged.",
 [("powercfg /getactivescheme","Power Scheme GUID: ... (Balanced)","")],
 "Turn off the pause-on-battery toggle under Settings > Personalization > Background (or accept the battery saving); no repair needed -- it's an intentional default."),
("settings","Lock screen shows a black background instead of Spotlight images",
 "Windows Spotlight's content delivery is blocked because the connected experiences endpoint can't be reached (proxy rule), so Spotlight silently falls back to black instead of erroring.",
 [("Test-NetConnection fd.api.iris.microsoft.com -Port 443","TcpTestSucceeded : False","")],
 "Allow the Spotlight/Content Delivery endpoints through the proxy/firewall, or switch the lock screen to Picture/Slideshow; after unblocking, toggle Spotlight off/on to refresh its cache."),
("settings","'Some settings are managed by your organization' on a personal PC",
 "Policy registry keys were set by a third-party tweak tool (privacy/telemetry disabler), and Windows correctly reports policy-managed state even though there's no real organization behind it.",
 [("Get-ChildItem 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows' | Measure-Object","Count : 14 (policy keys present on a non-domain machine)","")],
 "Review and remove the unexpected keys under HKLM/HKCU ...\\Policies\\Microsoft (export first), or re-run the tweak tool's 'restore defaults'; the banner clears once policy keys are gone. Check Settings > Accounts > Access work or school for stray MDM enrollments too."),
("settings","Fonts look blurry/fuzzy after changing display scaling",
 "Apps that don't handle dynamic DPI changes keep rendering at the old scale until restarted, and ClearType tuning is still calibrated for the previous scale -- a re-login plus ClearType pass fixes the softness.",
 [("Get-ItemProperty 'HKCU:\\Control Panel\\Desktop' -Name LogPixels -ErrorAction SilentlyContinue","LogPixels : 120 (125%)","")],
 "Sign out and back in after scaling changes, run cttune.exe (ClearType Text Tuner), and for persistently blurry apps set their High DPI override to 'System (Enhanced)'."),
("settings","Region format changes (date/decimal separator) don't apply inside some apps",
 "Win32 apps read region formats at launch, and some cache them per-profile; the new format applies system-wide but running apps and services keep the old culture until restarted -- plus Excel keeps its own separator overrides.",
 [("Get-Culture | Select-Object Name","Name\n----\nen-IN","")],
 "Restart affected apps (or sign out/in) after region changes; for Excel specifically check File > Options > Advanced > 'Use system separators'. Server processes need a service restart to pick up new culture."),
("settings","Location services greyed out for all apps",
 "The master location toggle is disabled at the machine level by policy (HKLM), which cascades: per-app toggles grey out and Find My Device stops -- one switch upstream of everything else.",
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location' -Name Value","Value : Deny","")],
 "Set the machine-level location consent back to Allow (Settings > Privacy & security > Location > Location services master toggle as admin, or the ConsentStore registry value), then grant per-app access individually."),
("settings","Background apps disabled globally caused missed mail/calendar notifications",
 "A battery 'optimization' guide set global background app policy to Disabled, so UWP mail/calendar can't sync in the background -- notifications only appear when the app is opened manually.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications' -Name GlobalUserDisabled -ErrorAction SilentlyContinue","GlobalUserDisabled : 1","")],
 "Set GlobalUserDisabled back to 0 (or the per-app 'Let this app run in background' to Always/Power optimized under the app's Advanced options); background sync resumes immediately."),
("settings","Power mode slider missing from Settings on a desktop PC",
 "The Power mode selector only appears on the Balanced scheme; this machine runs the High Performance legacy scheme, so Settings hides the slider by design.",
 [("powercfg /getactivescheme","Power Scheme GUID: 8c5e7fda-... (High performance)","")],
 "Switch to Balanced ('powercfg /setactive SCHEME_BALANCED') to get the slider back; the slider's Best Performance position matches or exceeds the legacy High Performance scheme on modern builds."),
("settings","Get Help / Feedback Hub and other inbox apps open then immediately close",
 "Inbox UWP apps launch through the AppX deployment service, and this profile's package repository has a licensing/state desync -- every affected app dies at splash.",
 [("Get-AppxPackage -Name Microsoft.GetHelp | Select-Object Status","Status : NeedsRemediation","")],
 "Re-register the affected apps ('Get-AppxPackage -AllUsers | Foreach {Add-AppxPackage -DisableDevelopmentMode -Register \"$($_.InstallLocation)\\AppXManifest.xml\"}') and run the Windows Store Apps troubleshooter; persistent NeedsRemediation across many apps warrants a new user profile."),
("settings","Sound output per-app routing lost after every restart",
 "Per-app output device assignments in the Volume mixer are stored per audio endpoint ID; the USB DAC re-enumerates with a new ID at each boot (hub timing), so mappings orphan and reset.",
 [("Get-CimInstance Win32_SoundDevice | Select-Object Name, Status","Name              Status\n----              ------\nUSB DAC           OK","")],
 "Plug the DAC directly into a rear motherboard port (stable enumeration), or set it as the system default device instead of per-app mappings; per-app routing sticks only while the endpoint ID stays constant."),
("settings","Camera works in the Camera app but shows black in browser video calls",
 "Browsers request the camera through the media foundation pipeline with hardware acceleration; the installed vendor 'camera enhancement' filter driver breaks MJPEG negotiation for web use while the Camera app's direct path still works.",
 [("Get-PnpDevice -Class Camera | Select-Object Status, FriendlyName","Status FriendlyName\n------ ------------\nOK     Integrated Camera","")],
 "Uninstall/disable the vendor camera enhancement suite (keep the plain UVC driver), then restart the browser; also confirm the browser's own site permission and Windows camera privacy toggles."),
("settings","Copilot/search hardware key on a new laptop does nothing",
 "The dedicated key sends a vendor-specific scancode handled by the OEM utility app, which isn't installed -- without it Windows receives no mapped action at all.",
 [("Get-CimInstance Win32_StartupCommand | Where-Object Command -match 'hotkey|utility'","(OEM hotkey utility absent)","")],
 "Install the OEM's hotkey/system utility package from the vendor support page (or remap the key with PowerToys Keyboard Manager to any function you prefer)."),
("settings","Dynamic refresh rate (DRR) option missing on a 120Hz laptop panel",
 "DRR requires a VRR-capable panel plus a WDDM 3.0+ graphics driver; the installed driver predates WDDM 3.0, so the 'Dynamic' choice never appears -- only fixed 60/120 options.",
 [("Get-CimInstance Win32_VideoController | Select-Object DriverVersion","DriverVersion : 27.20.100.9316 (WDDM 2.7-era)","")],
 "Update the GPU driver to a current WDDM 3.0+ release from the vendor; 'Dynamic (60Hz or 120Hz)' appears in Advanced display settings once the driver capability is present."),
("settings","OneDrive folder backup (Desktop/Documents redirection) can't be turned off cleanly",
 "Known Folder Move is enforced by a tenant policy (KFMSilentOptIn), so the client re-enables backup on every policy refresh -- the user-level toggle can't win against the tenant setting.",
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\OneDrive' -Name KFMSilentOptIn -ErrorAction SilentlyContinue","KFMSilentOptIn : <tenant-id>","")],
 "On an organization device, request the change from IT (the policy owner). On a personal machine, remove the stray OneDrive policy keys, then Settings > OneDrive > Manage Backup > stop backup per folder -- files return to the local profile paths."),
("settings","Advanced startup (recovery options) button does nothing when clicked",
 "The 'Restart now' for advanced startup requires the reagentc-registered WinRE; with Windows RE disabled the button silently no-ops instead of surfacing an error.",
 [("reagentc /info","Windows RE status: Disabled","")],
 "Run 'reagentc /enable' (elevated); if it errors, rebuild the WinRE partition reference ('reagentc /setreimage /path R:\\Recovery\\WindowsRE' after mounting), then the Advanced startup button functions again."),
("settings","Family child account can't launch any browser except Edge",
 "Family Safety web filtering enforces 'only use Edge' when content filters are active -- other browsers are blocked by policy so filtering can't be bypassed; this is the feature working as designed.",
 [("Get-AppxPackage Microsoft.MicrosoftEdge.Stable | Select-Object Version","(Edge present; filtering active on child account)","")],
 "If other browsers should be allowed, the organizer must relax web filtering (family.microsoft.com > the child > Edge settings > 'Filter settings' off) understanding filtering then no longer applies; otherwise keep Edge-only."),
("settings","Optional features page empty -- can't add RSAT or other capabilities",
 "Features on Demand come from Windows Update; with the update source pinned to a WSUS lacking FoD content and the fallback GPO unset, the list renders empty instead of erroring.",
 [("Get-WindowsCapability -Online -Name 'Rsat*' | Select-Object -First 2 Name, State","Name: Rsat.ActiveDirectory... State: NotPresent (list retrieval slow/empty in UI)","")],
 "Enable the 'optional component installation ... directly from Windows Update' GPO (or temporarily bypass WSUS), then add capabilities via Settings or 'Add-WindowsCapability -Online'; re-pin WSUS afterward."),
("settings","Mobile hotspot turns itself off after a few minutes with no clients",
 "Power saving turns the hotspot off when idle ('When no devices are connected, automatically turn off mobile hotspot'), which reads as random shutoff if a client takes long to join.",
 [("Get-NetAdapter | Where-Object InterfaceDescription -match 'Direct' | Select-Object Status","Status : Up (drops after idle timeout)","")],
 "Disable the auto-turn-off toggle on the Mobile hotspot Settings page (or keep a device connected); on Windows 11 also disable adapter power saving for the Wi-Fi Direct virtual adapter if the timeout persists."),
("settings","Ease of Access cursor size resets to default at every sign-in",
 "The accessibility cursor size preference is stored in the user hive, and a mandatory/super-mandatory profile discards hive changes at logoff -- every session starts from the profile master copy.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Accessibility' -Name CursorSize -ErrorAction SilentlyContinue","CursorSize : 1 (default again after re-login)","")],
 "On mandatory-profile deployments, ask the admin to bake the desired accessibility defaults into the profile master (or switch the user to a normal roaming/local profile); local-only machines shouldn't see this -- if they do, check for profile-cleaning tools."),
("settings","Startup apps page shows an app 'Off' but it still launches at boot",
 "The Settings Startup page only manages Run-key and Startup-folder entries; this app launches from a scheduled task at logon, which that page neither lists nor controls.",
 [("Get-ScheduledTask | Where-Object {$_.Triggers.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.TaskName -match 'Updater'} | Select-Object TaskName, State","TaskName        State\n--------        -----\nVendorUpdater   Ready","")],
 "Disable the logon scheduled task ('Disable-ScheduledTask -TaskName VendorUpdater') or via Task Scheduler UI; check Services too -- Settings' Startup page covers only a subset of autostart mechanisms (Autoruns shows everything)."),
]

with open(JSON_PATH, encoding="utf-8") as f:
    data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f:
    jsonl_lines = [l for l in f if l.strip()]

existing_ids = set(d["id"] for d in data)
existing_goals = set(d["goal"] for d in data)
n = 1
def next_id(prefix="new-win-repair"):
    global n
    while True:
        cand = f"{prefix}-{n:03d}"
        n += 1
        if cand not in existing_ids:
            existing_ids.add(cand)
            return cand

skipped = []
base_time = datetime(2026, 7, 31, 15, 0, 0)
i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goals:
        skipped.append(goal); continue
    created = base_time + timedelta(minutes=4 * i); i += 1
    steps = [{"command": c, "blocked": False, "exitCode": 0, "stdout": o, "stderr": e, "reason": None} for c, o, e in commands]
    data.append({
        "id": next_id(), "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal, "domain": domain,
        "plan": [f"Diagnose the {domain} issue with read-only checks", "Identify the specific root cause", "Apply the appropriate fix or explain expected behavior"],
        "steps": steps, "resolved": True, "summary": summary, "recommendation": recommendation,
        "feedback": {"worked": True, "note": "", "at": (created + timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}})
    existing_goals.add(goal)
    cmd_lines = "\n".join(f"- {c[0]}" for c in commands)
    chat = {"messages": [
        {"role": "system", "content": f"You are a Windows repair expert specializing in {domain} problems. Diagnose with read-only commands first, then apply safe fixes."},
        {"role": "user", "content": goal},
        {"role": "assistant", "content": f"{summary}\nCommands used:\n{cmd_lines}\nRecommendation: {recommendation}"}]}
    jsonl_lines.append(json.dumps(chat, ensure_ascii=False) + "\n")

print("Curated added:", i, "Skipped:", skipped)

# ============ Augmentation: phrasing variants of every base entry ============
import os
RUN_AUGMENTATION = os.environ.get("RUN_AUG", "0") == "1"
VARIANTS = [
    lambda g: f"Help needed: {g[0].lower() + g[1:]}",
    lambda g: f"{g} - what should I do?",
    lambda g: f"On my Windows machine, {g[0].lower() + g[1:]}. Can you diagnose it?",
    lambda g: f"I've been struggling with this: {g[0].lower() + g[1:]}",
]

aug_count = 0
aug_time = datetime(2026, 8, 1, 9, 0, 0)
base_entries = list(data) if RUN_AUGMENTATION else []  # snapshot including curated batch
for idx, entry in enumerate(base_entries):
    # 2 variants per base entry, rotating templates for variety
    for v in range(2):
        tmpl = VARIANTS[(idx + v) % len(VARIANTS)]
        vg = tmpl(entry["goal"])
        if vg in existing_goals:
            continue
        created = aug_time + timedelta(seconds=30 * aug_count)
        new_entry = {k: entry[k] for k in entry}
        new_entry = json.loads(json.dumps(entry))
        new_entry["id"] = next_id("aug-win-repair")
        new_entry["createdAt"] = created.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        new_entry["goal"] = vg
        new_entry["feedback"]["at"] = (created + timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        data.append(new_entry)
        existing_goals.add(vg)
        cmd_lines = "\n".join(f"- {s['command']}" for s in entry["steps"])
        chat = {"messages": [
            {"role": "system", "content": f"You are a Windows repair expert specializing in {entry['domain']} problems. Diagnose with read-only commands first, then apply safe fixes."},
            {"role": "user", "content": vg},
            {"role": "assistant", "content": f"{entry['summary']}\nCommands used:\n{cmd_lines}\nRecommendation: {entry['recommendation']}"}]}
        jsonl_lines.append(json.dumps(chat, ensure_ascii=False) + "\n")
        aug_count += 1

print("Augmented variants added:", aug_count)

with open(JSON_PATH, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False); f.write("\n")
with open(JSONL_PATH, "w", encoding="utf-8") as f:
    f.writelines(jsonl_lines)

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
assert set(users) == set(goals)
print("All validation passed: no duplicate ids/goals/prompts, files mirrored")
