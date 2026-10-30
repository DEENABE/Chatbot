Local software-engineering agent that plans, edits, runs and verifies code inside a user-authorized workspace folder using a local Ollama coding model, and refuses to report success until required validations have actually passed on the current file contents.

**Status:** Implemented. Caveats:
- `git.status` / `git.diff` go through `CommandExecutionService`, which **fails closed** (`ISOLATION_UNAVAILABLE`) because no OS isolation provider is wired in production — effectively unavailable
- Remote/cloud Ollama models are rejected (`CodingModelAdapter.isRemoteModel`)

## Responsibilities
- Service: `backend/src/coding/CodingAgentService.js` (`start`, `drive`, `perform`, `dispatch`, `tryFinish`, `verify`, `approve`, `cancel`), persisted by `CodingTaskRepository.js` (`coding_tasks`, `coding_grants`, `coding_execution_grants`, `coding_tool_approvals`, `coding_audit`)
- Model: `CodingModelAdapter.js` (default `qwen2.5-coder:14b`, timeout `CODING_MODEL_TIMEOUT_SECONDS`), prompts from `CodingGuidance.js`, loop protection by `RepeatGuard.js`
- Tools (`contracts.js` → `CODING_TOOLS`, executed by `CodingToolEngine.js`): READ — `workspace.open/inspect`, `fs.list/read`, `code.search/symbols/diff`, `git.status/diff`, `runtime.inspect`, `exec.output`, `checkpoint.list`; SAFE_WRITE — `fs.mkdir/write/patch`, `exec.stop`, `checkpoint.create`; DANGEROUS (needs approval) — `fs.delete`, `exec.run`, `tests.run`, `exec.start`, `preview.start`, `deps.install`, `runtime.install`, `checkpoint.restore`
- File confinement: `WorkspaceFiles.js` + `WindowsWorkspaceGuard.cs` (hash-pinned C# helper via `Add-Type`); processes via `ProjectRuntime.js` → `WindowsProjectProcess.js` + `ProjectProcessHost.cs`; toolchains in `Toolchains.js` / `ToolchainCommands.js`; new projects in `NewProject.js` / `ProjectScaffold.js` (React + Vite scaffold); previews in `ProjectPreview.js`
- API: `/api/coding/*` (`routes/coding.js`); UI: `frontend/src/coding/CodingWorkspace.jsx`, `CodingPanel.jsx`, `RuntimePanel.jsx`

## Plan → edit → test → debug loop

```mermaid
flowchart TD
  S[POST /coding/tasks] --> A[authorize workspace: write grant + execution policy]
  A --> I[seed: workspace.inspect → checkpoint.create → fs.list → runtime.inspect]
  I --> SC{new project?}
  SC -->|yes| SF[scaffold React/Vite]
  SC -->|no| P
  SF --> P[plan: model.next with tool definitions + validation state]
  P --> RG{RepeatGuard: repeated call?}
  RG -->|repeated| FIN
  RG -->|no| K{tool risk}
  K -->|READ / SAFE_WRITE| X[perform: fs.write / fs.patch / read]
  K -->|DANGEROUS| W[status waiting_approval]
  W -->|user approves POST /tasks/:id/approval| X2[exec.run / tests.run / deps.install]
  X --> P
  X2 --> P
  P -->|model says finish| FIN[tryFinish → verify]
  FIN --> V{files match recorded changes AND required validations passed?}
  V -->|yes| D[status done + summary]
  V -->|validation missing| NV[nextValidation: run tests/build]
  NV --> P
  V -->|failed, under 3 repairs| DBG[verificationFeedback to model = debug]
  DBG --> P
  V -->|failed 3 times| E[status error]
```

## Tech Stack
- Node.js, Ollama (`/api/chat`), PowerShell + C# helpers for Windows confinement, SQLite
