The Windows session the app automates and repairs, reached by two processes: the Electron Tool Engine (all desktop tools) and the backend coding agent (approved project commands inside a coding workspace).

**Status:** Implemented

## Responsibilities
- Electron side: PowerShell scripts under `frontend/tools/apps/` (packaged as `resources/desktop-control`), .NET UI Automation helper `DesktopAccessibility.cs`, Windows services, winget, installed Chromium browsers (playwright-core), File Explorer
- Backend side: coding-agent processes launched through `backend/src/coding/WindowsProjectProcess.js` (C# host `ProjectProcessHost.cs`) and file writes confined by `WindowsWorkspaceGuard.cs`
- Print Spooler service — the only service the repair agent may mutate

## Tech Stack
- Windows 10/11, PowerShell 5.1, .NET Framework `Add-Type` helpers, Win32 services, HKCU registry
