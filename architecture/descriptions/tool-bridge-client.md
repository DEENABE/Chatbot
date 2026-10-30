Backend-side HTTP client for the Electron Tool Bridge — the only way backend agents can request a desktop tool, check its status, cancel it or renew a confirmation.

**Status:** Implemented (requires the app to be launched by Electron or `npm run dev:tools`; under plain `npm run dev:plain` the bridge URL is unset and tool calls fail)

## Responsibilities
- Reads `TOOL_ENGINE_INTERNAL_URL` + `TOOL_ENGINE_SESSION_SECRET` injected by `BackendManager` / dev-host (`refreshBridgeUrl`)
- `callTool` → `POST /` (or `/approve` when the step carries a human `confirmationId`) with `Authorization: Bearer <secret>`, `x-execution-owner`, `x-model-route: windows`
- `cancelToolRequest` (`/cancel`), `inspectToolCall` (`/status`), `reviewToolCall` (`/reconcile`), `renewToolConfirmation` / `cancelToolConfirmation` (`/confirmations/*`), `checkBridgeHealth` (`GET /health`)
- Called by `orchestrator/AgentExecutor.js` (`executeStep`), `CheckpointRecovery.js`, `ManualRecovery.js`, `routes/orchestrate.js`
- Does **not** call the bridge's `/mcp` endpoint (no in-repo MCP client)

## Tech Stack
- Node `fetch` over loopback HTTP
