The host operating system and its installed applications, which Chanakya AI inspects and operates on the user's behalf through typed, policy-checked tools.

**Status:** Implemented (Windows-only; `platform === "win32"` is assumed by the tool services)

## Responsibilities
- Target of desktop automation: launching apps, UI Automation clicks/typing, File Explorer, Settings pages, browser automation via the installed Chrome/Edge/Brave
- Target of repair: the Print Spooler service (typed start/verify) and read-only diagnostics for network, Bluetooth, audio and system
- Provides speech synthesis (via `say` → PowerShell `System.Speech`) and a local speech recognizer fallback

## Tech Stack
- PowerShell 5 (`powershell.exe -NoProfile -NonInteractive`), .NET UI Automation (`DesktopAccessibility.cs`), Windows services, HKCU registry (restricted to `HKCU\Software\Chanakya`)
