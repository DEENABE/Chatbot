import json
from datetime import datetime, timedelta

JSON_PATH = "repair-sessions.json"
JSONL_PATH = "repair-dataset.jsonl"

NEW = [
# ---------------- BLUETOOTH (3 more) ----------------
("bluetooth","Bluetooth keyboard types the wrong characters or repeats keys randomly",
 "The keyboard is connected but its Bluetooth LE HID connection is dropping packets under interference (commonly from a nearby 2.4GHz Wi-Fi router or USB 3.0 hub), causing missed/repeated keystrokes rather than a driver fault.",
 [("Get-PnpDevice -Class Bluetooth | Where-Object FriendlyName -like '*Keyboard*' | Select-Object Status, FriendlyName","Status FriendlyName\n------ ------------\nOK     Logitech K380","")],
 "Move the keyboard closer to the PC, move any USB 3.0 devices/hubs away from the Bluetooth receiver, and replace the batteries -- low battery voltage often triggers this exact symptom."),
("bluetooth","Two Bluetooth devices keep fighting over the same COM port and one always fails to connect",
 "Both devices were assigned overlapping virtual serial (COM) ports by the Bluetooth stack, so only one can hold the port lock at a time -- a pairing bookkeeping issue rather than a hardware conflict.",
 [("Get-PnpDevice -Class Ports | Where-Object FriendlyName -like '*Bluetooth*' | Select-Object FriendlyName, Status","FriendlyName                          Status\n------------                          ------\nStandard Serial over Bluetooth (COM5) OK\nStandard Serial over Bluetooth (COM5) Error","")],
 "Remove both devices from Settings > Bluetooth & devices, restart the bthserv service, then re-pair them one at a time so each gets a distinct COM port."),
("bluetooth","Bluetooth won't turn back on after being toggled off, the switch is greyed out",
 "Airplane mode was left on at the OS level, which force-disables all radios including Bluetooth and greys out the individual toggle until it's turned off.",
 [("Get-NetAdapter | Where-Object Name -like '*Bluetooth*' | Select-Object Status","Status\n------\nDisabled",""),],
 "Turn off Airplane mode from the Action Center/Quick Settings first; the Bluetooth toggle becomes usable again once Airplane mode is disabled."),
# ---------------- AUDIO (3 more) ----------------
("audio","Sound suddenly plays through the wrong output device every time a specific app opens",
 "The app itself was explicitly overriding the default playback device via its own app-specific sound setting in Windows, separate from the system-wide default.",
 [("Get-CimInstance -Namespace root/cimv2 -ClassName Win32_SoundDevice | Select-Object Name, Status","Name              Status\n----              ------\nRealtek(R) Audio  OK","")],
 "Open Settings > Sound > Volume mixer > Advanced sound options and set that specific app's output back to 'Default' or the device you actually want."),
("audio","Getting a loud buzzing or hissing noise from speakers that goes away when headphones are plugged in",
 "The noise is present only on the speaker output path, which points to electrical interference/grounding on the analog speaker jack or cable rather than a Windows audio driver issue, since headphone output on the same device is clean.",
 [("Get-CimInstance Win32_SoundDevice | Select-Object Name, Status","Name              Status\n----              ------\nRealtek(R) Audio  OK","")],
 "Try a different speaker cable and a different wall outlet/power strip to rule out a ground loop; if the buzzing follows the speakers to another PC, the speakers themselves are the source."),
("audio","All audio randomly cuts out for a second every few minutes on a USB headset",
 "USB Selective Suspend is periodically powering down the headset's USB connection to save energy, causing the brief audio dropouts -- the same underlying mechanism as USB mouse micro-freezes.",
 [("powercfg /q SCHEME_CURRENT SUB_USB USBSELECTSUSPEND","Current AC Power Setting Index: 0x00000001","")],
 "Disable USB selective suspend while on AC power via Power Options > USB settings, or check the headset's own USB Root Hub entry in Device Manager and uncheck 'Allow the computer to turn off this device'."),
# ---------------- DISPLAY (5) ----------------
("display","Second monitor keeps flickering only at its native high refresh rate",
 "The cable/port doesn't reliably support the bandwidth needed for that resolution at the higher refresh rate, so the display intermittently drops signal and flickers -- a bandwidth/cable issue rather than a GPU fault.",
 [("Get-CimInstance Win32_VideoController | Select-Object Name, CurrentRefreshRate","Name                    CurrentRefreshRate\n----                    ------------------\nNVIDIA GeForce RTX 3060                144","")],
 "Try a certified high-bandwidth cable (DisplayPort 1.4 or HDMI 2.1 depending on the monitor) or step down to a lower refresh rate to confirm the cable is the cause."),
("display","Colors look washed out or overly warm on one monitor compared to another identical model",
 "A Night Light or a custom ICC color profile is applied to only one of the two displays, shifting its color temperature independently of the other monitor.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current\\default$windows.data.bluelightreduction.settings' -ErrorAction SilentlyContinue","Night Light settings present and enabled for this display profile","")],
 "Check Settings > System > Display > Night light and Color profile settings per-monitor; make sure both displays are using the same (or no custom) color profile if you want matching color."),
("display","Windows keeps forgetting my monitor arrangement/wallpaper after every reboot",
 "Windows is re-detecting the displays in a different order at each boot (common with a docking station or KVM switch), so the saved arrangement doesn't match the new detection order and resets.",
 [("Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorID | Select-Object InstanceName","InstanceName\n------------\nDISPLAY\\AUO1234\\...\nDISPLAY\\SAM5678\\...","")],
 "Ensure all monitors are powered on and connected before the PC boots (docks/KVMs can delay one port's handshake), and update the dock/GPU driver, which often fixes inconsistent enumeration order."),
("display","External monitor connected through a USB-C dock only outputs at a low resolution",
 "The dock's USB-C port is negotiating DisplayPort Alt Mode at a lower lane count than needed for full resolution (often because the same port is also carrying USB data and power delivery), capping the achievable output.",
 [("Get-CimInstance Win32_VideoController | Select-Object Name, CurrentHorizontalResolution, CurrentVerticalResolution","Name                       CurrentHorizontalResolution CurrentVerticalResolution\n----                       --------------------------- --------------------------\nIntel(R) Iris Xe Graphics                          1920                       1080","")],
 "Use a dock/cable rated for full DisplayPort Alt Mode (4 lanes) at your target resolution, or connect the monitor directly via its own DisplayPort/HDMI cable instead of through the dock."),
("display","Getting a 'No signal' message when waking a monitor from sleep, requires unplugging the cable to fix",
 "The monitor and GPU are failing to renegotiate the display handshake after a DPMS power-down, a known compatibility quirk between certain GPU driver versions and monitor firmware.",
 [("Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion","Name                    DriverVersion\n----                    -------------\nNVIDIA GeForce RTX 3060 27.21.14.5678","")],
 "Update the GPU driver to the latest version and check for a firmware update for the monitor itself; as a workaround, disabling 'Turn off display' in the power plan avoids triggering the handshake failure."),
# ---------------- SYNC / MOBILITY (5) ----------------
("cloud","Phone Link (Your Phone) app won't connect to an Android phone anymore",
 "The paired Bluetooth link between the PC and phone is healthy, but the Phone Link companion app on the phone itself was force-stopped by Android's battery optimization, breaking the background connection Phone Link needs.",
 [("Get-PnpDevice -Class Bluetooth | Where-Object FriendlyName -like '*Phone*' | Select-Object Status","Status\n------\nOK","")],
 "On the phone, exclude the Link to Windows / Phone Link app from battery optimization, then reopen Phone Link on the PC and reconnect."),
("cloud","Cloud Clipboard (Win+V sync across devices) has stopped syncing between two PCs",
 "Clipboard History/Sync is a per-device toggle that requires being signed into the same Microsoft account on both machines; on this PC the sync toggle itself had been turned off after a recent sign-out/sign-in.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Clipboard' -Name EnableClipboardHistory -ErrorAction SilentlyContinue","EnableClipboardHistory : 0","")],
 "Turn Clipboard History and 'Sync across devices' back on under Settings > System > Clipboard on both PCs, and confirm both are signed into the same Microsoft account."),
("cloud","Dynamic Lock (auto-lock PC when phone leaves Bluetooth range) isn't working",
 "The phone was successfully paired for Dynamic Lock previously, but the Bluetooth pairing itself had been removed/re-created since, and Dynamic Lock's setting still points at the old (now invalid) paired-device reference.",
 [("Get-PnpDevice -Class Bluetooth | Select-Object Status, FriendlyName","Status FriendlyName\n------ ------------\nOK     Pixel 8","")],
 "Go to Settings > Accounts > Sign-in options > Dynamic lock, uncheck then re-check 'Allow Windows to detect...' so it re-links to the currently paired phone."),
("cloud","SharePoint/OneDrive shows a sync conflict with duplicate files ending in '-computername'",
 "Two devices edited the same file while offline (or nearly simultaneously), so OneDrive couldn't merge the changes and created a conflict copy instead of silently overwriting either version.",
 [("Get-ChildItem 'C:\\Users\\Public\\OneDrive - Company' -Recurse -Filter '*-PC*.docx' | Select-Object -First 3 Name","Name\n----\nBudget-DESKTOP-A1B2C3.docx","")],
 "Manually compare the conflicting copies and merge the changes you want to keep into one file, then delete the duplicate; avoid editing the same file offline on two devices simultaneously going forward."),
("cloud","OneDrive 'Files On-Demand' placeholders show a red X and won't download",
 "The cloud-only placeholder files can't reach OneDrive's servers to fetch their content, most often due to the account being temporarily unlinked or over its storage quota rather than a corrupted placeholder.",
 [("Get-Process OneDrive -ErrorAction SilentlyContinue | Select-Object Responding","Responding\n----------\n      True","")],
 "Check the OneDrive icon in the system tray for a storage-full or sign-in-required warning; resolve that (free up space or re-sign in) and the red X placeholders should resolve automatically."),
# ---------------- WSL / DEV TOOLING (5, non-Docker) ----------------
("wsl","A WSL2 Linux distro won't launch, just closes the terminal window immediately",
 "The specific distro's virtual disk (ext4.vhdx) had become corrupted, likely from an unclean shutdown of the host, so the Linux kernel fails to mount the root filesystem and the session exits instantly.",
 [("wsl --list --verbose","NAME      STATE           VERSION\nUbuntu    Stopped               2","")],
 "Try 'wsl --shutdown' followed by relaunching; if it still fails, run 'wsl --unregister Ubuntu' (this deletes that distro's data) and reinstall it, or restore the .vhdx from a backup if you have one."),
("wsl","WSL2 is using far more RAM than expected and won't release it back",
 "WSL2's Linux kernel caches file-system pages aggressively and by default has no memory ceiling configured, so its vmmem process can grow to consume most of the host's free RAM over a long session.",
 [("Get-Process vmmem -ErrorAction SilentlyContinue | Select-Object WorkingSet64","WorkingSet64\n------------\n  6442450944","")],
 "Create/edit '%UserProfile%\\.wslconfig' with a '[wsl2] memory=4GB' cap, then run 'wsl --shutdown' to apply it on next launch."),
("wsl","Localhost port forwarding from WSL2 to Windows stopped working after a network change",
 "WSL2's internal virtual network adapter gets a new IP on every restart, and Windows' localhost-forwarding relies on that mapping refreshing correctly -- a recent network profile change left it stale.",
 [("wsl hostname -I","172.28.144.12","")],
 "Run 'wsl --shutdown' and relaunch the distro to force WSL2 to rebuild its network adapter and refresh the localhost forwarding mapping."),
("terminal","PowerShell scripts won't run, error says 'running scripts is disabled on this system'",
 "The execution policy on this machine is set to Restricted, which blocks all local .ps1 scripts from running as a security default -- this is expected out-of-the-box behavior, not a bug.",
 [("Get-ExecutionPolicy -List","Scope           ExecutionPolicy\n-----           ---------------\nLocalMachine    Restricted","")],
 "Run 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned' (safer than allowing everything system-wide) so locally written/trusted scripts can run while downloaded ones still require a signature."),
("dev","A .NET application fails to launch with a 'missing runtime' error after a clean Windows install",
 "The application requires a specific .NET Desktop Runtime version that isn't bundled with Windows by default and was never installed, rather than the app itself being broken.",
 [("dotnet --list-runtimes","(no output -- no .NET runtimes installed)","")],
 "Install the exact .NET Desktop Runtime version the app requires from Microsoft's official .NET downloads page (the app's error message usually states the required version)."),
# ---------------- ACCESSIBILITY (3) ----------------
("accessibility","Narrator starts automatically every time the PC boots, even though it wasn't asked for",
 "A Narrator auto-start toggle was enabled (sometimes turned on accidentally with Ctrl+Windows+Enter, Narrator's own launch shortcut), so it launches at every sign-in.",
 [("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Narrator\\NoRoam' -Name 'WinEnterLaunchEnabled' -ErrorAction SilentlyContinue","WinEnterLaunchEnabled : 1","")],
 "Go to Settings > Accessibility > Narrator and turn off 'Allow the shortcut to start Narrator' if you don't use it, or turn off 'Start Narrator automatically after I sign in'."),
("accessibility","On-screen items are magnified/zoomed and won't go back to normal size",
 "Windows Magnifier was toggled on (commonly via the Win + '+' shortcut pressed accidentally) and is actively zooming the desktop.",
 [("Get-Process Magnify -ErrorAction SilentlyContinue","Id   ProcessName\n--   -----------\n5124 Magnify","")],
 "Press Win + Esc to close Magnifier, or Ctrl + Alt + Scroll wheel / Win + '-' to zoom back out; check Settings > Accessibility > Magnifier if it keeps re-triggering."),
("accessibility","High Contrast mode turned on by itself and won't turn off from Settings",
 "The left Alt + left Shift + Print Screen keyboard shortcut for toggling High Contrast was pressed (easy to hit accidentally on some keyboard layouts), and the shortcut itself is what's re-triggering it.",
 [("Get-ItemProperty 'HKCU:\\Control Panel\\Accessibility\\HighContrast' -Name Flags","Flags : 126","")],
 "Press the same shortcut (left Alt + left Shift + Print Screen) again to toggle it off, or disable that hotkey entirely under Settings > Accessibility > Contrast themes > Keyboard shortcut."),
# ---------------- UPDATES (5) ----------------
("windows","Windows 11 upgrade is blocked with 'This PC doesn't currently meet all the system requirements'",
 "The PC Health Check flagged a specific requirement (commonly TPM 2.0 not enabled, or Secure Boot off) rather than the hardware being fundamentally unsupported -- many PCs have the capable hardware, just disabled in firmware.",
 [("Get-Tpm | Select-Object TpmPresent, TpmVersion","TpmPresent TpmVersion\n---------- ----------\n      True     {1.2}","")],
 "Enter BIOS/UEFI and enable the TPM (or 'PTT'/'fTPM') and Secure Boot if the motherboard supports the newer versions; if the TPM is truly 1.2-only with no upgrade path, the hardware genuinely doesn't qualify."),
("windows","A specific feature update keeps failing and rolling back with the same error every time",
 "Setup logs point to a specific driver blocking the upgrade's compatibility check, and Windows automatically rolls back to the previous build whenever that block is hit, rather than leaving the system half-upgraded.",
 [("Get-Content 'C:\\$WINDOWS.~BT\\Sources\\Panther\\setupact.log' -Tail 20 -ErrorAction SilentlyContinue","Migration choice: incompatible driver detected: oem_camera.sys","")],
 "Update or temporarily uninstall the specific driver named in the setup log, then retry the feature update; reinstall the driver's latest version afterward if needed."),
("windows","Update Delivery Optimization is saturating the internet connection uploading to other PCs",
 "Delivery Optimization is configured to share downloaded update bits with other PCs over the internet (not just the local network), which can consume significant upload bandwidth in the background.",
 [("Get-DeliveryOptimizationStatus | Select-Object -First 1","DownloadMode : InternetAndLan","")],
 "Change the mode under Settings > Windows Update > Delivery Optimization to 'LAN only' (or turn it off) if you don't want it uploading to other PCs over the internet."),
("windows","Windows Update has been 'Paused' and I can't figure out why or how to fully resume it",
 "Updates were paused (either manually or automatically after a previous failed update), and the pause remains active until its expiration date or is manually cleared.",
 [("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings' -Name PauseUpdatesExpiryTime -ErrorAction SilentlyContinue","PauseUpdatesExpiryTime : 2026-08-15","")],
 "Go to Settings > Windows Update and click 'Resume updates'; if it silently re-pauses, check Group Policy/MDM for an organization-managed update pause policy."),
("windows","After a recent update, a previously working app now refuses to open citing a compatibility block",
 "Windows Update proactively applies compatibility 'safeguard holds' that block specific known-incompatible app/driver combinations from launching until a fix ships, rather than the app being uninstalled or corrupted.",
 [("Get-CimInstance -Namespace root/cimv2 -ClassName Win32_ReliabilityRecords -ErrorAction SilentlyContinue | Select-Object -First 1 Message","(no direct PS cmdlet exposes safeguard holds; check Windows Release Health dashboard for known issues)","")],
 "Check the Windows Release Health / Message Center for a known safeguard hold matching this app; it typically lifts automatically once Microsoft or the app vendor ships a fix, without needing anything from you."),
# ---------------- ACCOUNTS / CREDENTIALS (4) ----------------
("security","Switching a Microsoft account back to a local account keeps failing partway through",
 "The switch to a local account requires disconnecting several linked services (OneDrive sync, Windows Hello, activation binding) first, and one of them -- an active OneDrive sync -- was blocking the conversion from completing.",
 [("Get-Process OneDrive -ErrorAction SilentlyContinue | Select-Object Responding","Responding\n----------\n      True","")],
 "Pause/unlink OneDrive first (Settings > Accounts > Unlink this PC), then retry Settings > Accounts > Your info > 'Sign in with a local account instead'."),
("security","A saved password in Credential Manager is wrong and keeps causing repeated login prompts for a network share",
 "An old, since-changed password for the network share is still cached in Windows Credential Manager, and Windows keeps retrying that stale credential automatically before ever prompting for the correct one.",
 [("cmdkey /list | Select-String 'fileserver'","Target: fileserver.corp.local\nType: Domain Password","")],
 "Open Credential Manager (Control Panel > Credential Manager > Windows Credentials), remove the stale entry for that server, and reconnect so Windows prompts fresh and saves the current password."),
("security","Windows Hello PIN stopped working and it won't let me set a new one",
 "The PIN's underlying cryptographic container (tied to the TPM) had become corrupted, likely after a TPM firmware update, so Windows can neither validate the old PIN nor create a fresh one over the broken container.",
 [("Get-Tpm | Select-Object TpmReady, TpmOwned","TpmReady TpmOwned\n-------- --------\n    True     True","")],
 "Go to Settings > Accounts > Sign-in options > PIN > 'I forgot my PIN' to reset it (requires your Microsoft/domain password once); this rebuilds the PIN's TPM-backed container from scratch."),
("security","Family Safety / Parental Controls is blocking an app that should be allowed",
 "The child account has an app/content restriction policy active that's evaluated by the Family Safety service independent of local admin settings, so a local override alone won't unblock it.",
 [("Get-Service '*FamilySafety*' -ErrorAction SilentlyContinue | Select-Object Status","(Family Safety enforcement is cloud-managed via the Microsoft Family portal, not a local Windows service)","")],
 "The parent/organizer account needs to approve the specific app or adjust screen time/content filters from family.microsoft.com or the Family Safety app -- this can't be changed from the child's local Settings."),
# ---------------- FILE SHARING / BACKUP (5) ----------------
("file","Files copied to a network share silently lose their custom NTFS permissions",
 "The destination share doesn't have 'Preserve permissions' behavior for cross-volume copies enabled by default, so Windows applies the destination folder's inherited permissions instead of carrying over the source ACLs.",
 [("Get-Acl 'C:\\Users\\Public\\data\\report.docx' | Select-Object -ExpandProperty AccessToString","Shows source ACL with custom entries not present after copying to \\\\server\\share","")],
 "Use 'robocopy /copyall' (or Xcopy /O) instead of a plain drag-and-drop copy to explicitly carry over NTFS permissions and ownership to the destination."),
("file","An EFS-encrypted file shows 'Access is denied' when opened on a different PC by the same user",
 "EFS encryption keys are tied to the user's certificate on the original machine; without exporting and importing that certificate to the new PC, even the same user account can't decrypt the file there.",
 [("cipher /c 'C:\\Users\\Public\\secret.docx'","Encryption Certificate Hash: (certificate not present in this profile's store)","")],
 "On the original PC, export the EFS certificate and private key with 'certmgr.msc' (or 'cipher /x'), then import it into the new PC's certificate store before trying to open the file there."),
("file","Volume Shadow Copy / File History backups suddenly stopped and show an error",
 "The Volume Shadow Copy service, which File History depends on to snapshot files while they're in use, was stopped, so no new restore points/versions could be captured.",
 [("Get-Service VSS | Select-Object Status, StartType","Status  StartType\n------  ---------\nStopped   Manual","")],
 "Start the VSS service ('Start-Service VSS') and set it to Automatic if File History needs it running continuously; then trigger a manual File History backup to confirm it resumes."),
("file","Getting 'You have exceeded your storage quota' when saving to a specific folder on a shared server",
 "A per-user or per-folder NTFS disk quota is configured on that specific volume, independent of the overall free space on the server, and this user's quota has been reached.",
 [("Get-Content 'C:\\Users\\Public\\data\\quota_report.txt' -ErrorAction SilentlyContinue","(quota enforcement is server-side; check with the file-server admin for the current quota and usage)","")],
 "Ask the file-server admin to review/raise the disk quota for your account on that volume, or clean up unneeded files in that specific folder to get back under the limit."),
("file","Robocopy jobs fail partway through with 'Access is denied' on only a few specific files",
 "A handful of files in the source were open/locked by another process (or protected by a security-conscious antivirus real-time scan) at the moment Robocopy tried to read them, causing just those files to fail while the rest copy fine.",
 [("robocopy 'C:\\Source' 'D:\\Dest' /LOG:copy.log /R:1 /W:1","2 files FAILED with ERROR 5 (Access is denied) in copy.log","")],
 "Re-run the same robocopy command with '/Z' (restartable mode) and a higher '/R' retry count; if it's consistently the same files, check whether an app or antivirus scan has them open at that time."),
# ---------------- GAMING / PERIPHERAL SOFTWARE (4) ----------------
("gaming","Xbox Game Bar pops up unexpectedly during gameplay and causes a frame drop each time",
 "A background hotkey combination overlapping with a game's own keybinding is triggering Game Bar's overlay to open unintentionally during play, causing the momentary stutter when it renders.",
 [("Get-Process GameBar -ErrorAction SilentlyContinue | Select-Object Id","Id\n--\n7744","")],
 "Check Settings > Gaming > Xbox Game Bar for the exact open-overlay shortcut and change it to something that doesn't conflict with your games, or turn Game Bar off entirely if you don't use its features."),
("gaming","NVIDIA ShadowPlay/GeForce Experience recording causes noticeable FPS drops during gameplay",
 "Instant Replay's background recording is encoding continuously using the same GPU that's rendering the game, and on this card the encoder and render engines are contending for resources under this specific game's load.",
 [("Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM","Name                    AdapterRAM\n----                    ----------\nNVIDIA GeForce GTX 1660 6442450944","")],
 "Lower the Instant Replay recording resolution/bitrate in GeForce Experience settings, or disable it for demanding titles where every frame matters."),
("gaming","RGB lighting software (from the motherboard/mouse/keyboard vendors) causes stutters when multiple RGB apps are open together",
 "Two separate RGB control services from different vendors are both polling the same USB HID devices simultaneously, and that contention is what's producing the periodic stutter, not the games themselves.",
 [("Get-Process | Where-Object Name -match 'RGB|Synapse|iCUE|Aura' | Select-Object Name, CPU","Name          CPU\n----          ---\niCUE        142.6\nAuraService  98.3","")],
 "Use only one vendor's RGB software as the 'master' controller (most support handing off control via SDKs like Razer Chroma Connect) and close the others rather than running multiple simultaneously."),
("gaming","Controller (Xbox/PlayStation) input has noticeable lag only in wireless mode, wired is fine",
 "The wireless dongle/Bluetooth channel is experiencing interference from a nearby 2.4GHz Wi-Fi network, adding polling latency that isn't present over the direct USB wired connection.",
 [("Get-PnpDevice -Class HIDClass | Where-Object FriendlyName -like '*Controller*' | Select-Object Status, FriendlyName","Status FriendlyName\n------ ------------\nOK     Xbox Wireless Controller","")],
 "Move the wireless receiver/dongle to a USB extension cable away from the PC case and other 2.4GHz devices, or switch the router to primarily use the 5GHz band to reduce 2.4GHz congestion."),
]

with open(JSON_PATH, encoding="utf-8") as f:
    data = json.load(f)
with open(JSONL_PATH, encoding="utf-8") as f:
    jsonl_lines = [l for l in f if l.strip()]

existing_ids = set(d["id"] for d in data)
existing_goals = set(d["goal"] for d in data)
n = 1
def next_id():
    global n
    while True:
        cand = f"new-win-repair-{n:03d}"
        n += 1
        if cand not in existing_ids:
            return cand

skipped = []
base_time = datetime(2026, 7, 28, 15, 45, 0)
i = 0
for domain, goal, summary, commands, recommendation in NEW:
    if goal in existing_goals:
        skipped.append(goal)
        continue
    created = base_time + timedelta(minutes=5 * i)
    feedback_at = created + timedelta(minutes=2)
    i += 1
    steps = [{"command": c, "blocked": False, "exitCode": 0, "stdout": o, "stderr": e, "reason": None} for c, o, e in commands]
    entry = {
        "id": next_id(),
        "createdAt": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "goal": goal,
        "domain": domain,
        "plan": [f"Diagnose the {domain} issue with read-only checks", "Apply the appropriate safe fix or give a clear recommendation"],
        "steps": steps,
        "resolved": True,
        "summary": summary,
        "recommendation": recommendation,
        "feedback": {"worked": True, "note": "", "at": feedback_at.strftime("%Y-%m-%dT%H:%M:%S.000Z")}
    }
    data.append(entry)
    existing_goals.add(goal)

    cmd_lines = "\n".join(f"- {c[0]}" for c in commands)
    assistant_content = f"{summary}\nCommands used:\n{cmd_lines}\nRecommendation: {recommendation}"
    chat = {"messages": [
        {"role": "system", "content": f"You are a Windows repair expert specializing in {domain} problems. Diagnose with read-only commands first, then apply safe fixes."},
        {"role": "user", "content": goal},
        {"role": "assistant", "content": assistant_content}
    ]}
    jsonl_lines.append(json.dumps(chat, ensure_ascii=False) + "\n")

with open(JSON_PATH, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
with open(JSONL_PATH, "w", encoding="utf-8") as f:
    f.writelines(jsonl_lines)

print("Added:", i, "Skipped duplicates:", len(skipped), skipped)
print("Total JSON entries:", len(data))
print("Total JSONL lines:", len(jsonl_lines))

ids = [d["id"] for d in data]
assert len(ids) == len(set(ids))
goals = [d["goal"] for d in data]
assert len(goals) == len(set(goals))
with open(JSONL_PATH, encoding="utf-8") as f:
    ulines = [json.loads(l) for l in f if l.strip()]
users = [m["content"] for o in ulines for m in o["messages"] if m["role"] == "user"]
assert len(users) == len(set(users))
print("All validation passed: no duplicate ids/goals/prompts")
