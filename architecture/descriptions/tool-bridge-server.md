Loopback HTTP server inside Electron main that lets the backend request desktop tools with a per-launch shared secret, and that also hosts the read-only MCP endpoint.

**Status:** Implemented (`/mcp` endpoint has no in-repo caller — unverified as used)

## Responsibilities
- `frontend/electron/ipc/toolBridgeServer.js` (`createToolBridgeServer`): random 32-byte secret, constant-time `Authorization: Bearer` check, mandatory `x-execution-owner` (owner becomes `backend:<id>`), 256 KB body cap
- Endpoints: `GET /health`; `POST /` and `/approve` (only when `x-model-route: windows`), `/cancel`, `/status`, `/reconcile`, `/confirmations/renew`, `/confirmations/cancel`, `/mcp`
- Started by `startInternalToolServer()` in `ipc/tool.ipc.js` before the backend, so its URL and secret can be injected into the backend's environment
- Reused unchanged by `frontend/dev-host/index.js` for `npm run dev:tools`

## Tech Stack
- Node `http`, `crypto.timingSafeEqual`
