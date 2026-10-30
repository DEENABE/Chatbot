Starts the bundled Node backend as a child process with a locked-down environment and per-launch secrets, waits for its readiness line, and kills it when the app quits.

**Status:** Implemented

## Responsibilities
- `frontend/electron/managers/BackendManager.js` (`startBackend`, `killBackend`): `spawn(process.execPath, [server.js])` with `CHANAKYA_DESKTOP_CHILD=1`, a fresh random `CHANAKYA_CLIENT_SECRET`, `TOOL_ENGINE_INTERNAL_URL` / `TOOL_ENGINE_SESSION_SECRET` from the Tool Bridge, and in packaged builds `NODE_ENV=production`, `APP_DATA_PATH` (per-user data root) and `FRONTEND_DIST_PATH`
- Parses `CHANAKYA_BACKEND_READY {port,pid}` from stdout to learn the actual API endpoint (`utils/runtimeEndpoint.js` shares it with preload)
- `services/BackendHealth.js` (`waitForBackend`, 15 s) gates window creation; failure shows an error dialog and quits

## Tech Stack
- Node `child_process.spawn`, Electron `app`
