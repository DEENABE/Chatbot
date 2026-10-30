The single dispatcher for desktop tools: it receives a `{tool, action, params}` request from the execution ledger, runs it past the security guard twice (before and after resolving the service), enforces approval gates and timeouts, and returns a structured result to the caller.

**Status:** Implemented

## Responsibilities
- `frontend/tools/ToolEngineRouter.js` (`ToolEngineRouter.dispatch`, `getTools`): builds the service map (`file`, `powershell`, `cmd`, `services`, `registry`, `hardware`, `process`, `network`, `app`, `windowsRepair`, `uiAutomation`, `browser`, `inspector`, `desktop`, `systemSettings`, `explorer`, `winget`, `webInstall`, `software`) and the registry/policy/guard/audit chain
- Handles control actions (`confirm`, cancel confirmation, app choices) before normal dispatch
- Throws if a DANGEROUS decision comes back without the service having raised a confirmation (`Dangerous service omitted its approval gate`)
- Emits `tool:confirmation-required` and `tool:progress` events to the renderer window
- `frontend/tools/ExecutionLedger.js` (`execute`, `status`, `cancel`, `reconcile`): per-owner idempotency records on disk, 30 s default timeout, so a retried or resumed request never re-executes a completed mutation
- `ExecutionContext.js` (cancellation + owned helper processes), `DesktopRuntime.js`, `ApplicationReadiness.js`, `InputValidator.js`, `dangerGuard.js`

## Tech Stack
- Node.js inside Electron main (or `frontend/dev-host` in dev), `AbortSignal.timeout`
