The main-process side of the preload bridge: validates that each IPC call comes from the app's own window and routes it to window control, screen capture, workspace pickers, session storage or the tool engine.

**Status:** Implemented

## Responsibilities
- `ipc/window.ipc.js`: `window-set-mode`, `window-get-mode`, `window-toggle-expand`, `window-set-ocr-mode`, `window-set-toolbar-mode`, drag / minimize / close / resize
- `ipc/system.ipc.js`: `show-notification`, `save-file`, `tts:speak` / `tts:stop` / `tts:voices`
- `ipc/capture.ipc.js`: `capture-screen`, `get-screen-sources`
- `ipc/workspace.ipc.js`: `workspace:choose-directory`
- `ipc/auth.ipc.js`: `auth:get-token`, `auth:set-token`, `auth:clear-token` (in-memory `SessionStore`)
- `ipc/tool.ipc.js` (`registerToolIPCHandlers`): `tool:execute`, `tool:approve`, `tool:cancel-request`, `tool:renew-confirmation`, `tool:app-permission`, `tool:choose-app`, `tool:desktop-status`, offline installer picks, and `software:*` (providers, discover, resolve, action, register/remove source, choose, pick installer/directory, reveal); wires `ExecutionLedger`, `ToolEngineRouter`, `ProtectedRunner`, `wireRepairLedger`
- Trust check: `utils/ipcTrust.js` (`requireTrustedSender` / `isTrustedSender` → main window's main frame only)

## Tech Stack
- Electron `ipcMain.handle` / `ipcMain.on`, `contextBridge` (preload.cjs)
