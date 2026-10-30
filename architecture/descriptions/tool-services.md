The concrete Windows capabilities behind each tool name — app launch and UI Automation, browser automation, File Explorer, system settings, software install, files, services, processes, registry, hardware and network inspection.

**Status:** Implemented (each service only runs actions the registry and policy allow)

## Responsibilities
- App & UI: `AppService.js`, `AppInspectorService.js`, `UIAutomationService.js`, `GenericDesktopService.js` backed by PowerShell scripts in `frontend/tools/apps/` and `DesktopAccessibility.cs`
- Browser: `BrowserAutomationService.js` drives the user's installed Chrome/Edge/Brave through playwright-core (no bundled browser)
- Files & Explorer: `FileService.js`, `../fileexplorer/ExplorerToolService.js` (user-approved roots)
- System: `SystemSettingsService.js` (+ `SettingsWorker.js`, `SettingsElevator.js`), `WinServicesService.js`, `ProcessService.js`, `RegistryService.js`, `HardwareService.js`, `NetworkService.js`, `PowerShellService.js`, `CmdService.js`
- Software: `WingetService.js`, `WebInstallService.js`, `SoftwareService.js` with providers in `../software/providers/` (winget, metadata, offline) — online discovery and every install are DANGEROUS and confirmed
- Repair: `WindowsRepairService.js` (typed `inspectSpooler` / `startSpooler` / `verifySpooler`, requests confirmation for start, delegates execution to the protected runner)

## Tech Stack
- PowerShell 5.1, .NET UI Automation, winget, playwright-core 1.63
