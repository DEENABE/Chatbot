The backend's task-executing agents — coding, Windows repair, app/desktop control and file/document operations — which share one checkpointed execution state machine and reach the desktop only through the authenticated Tool Bridge.

**Status:** Implemented (see each agent for scope limits)

## Responsibilities
- Host the four agents in `backend/src/coding/`, `backend/src/orchestrator/`, `backend/src/ai/` and `backend/src/fileagent/`
- Provide the common execution core (`orchestrator/ExecutionController.js`, `AgentState.js`, `CheckpointStore.js`, `ExecutionSessions.js`) with phases such as `plan → decide → waiting_confirmation → replan`
- Keep model output advisory: models propose typed tool calls; policy, approval and verification are enforced in code
- Drill down to see each agent and how they connect

## Tech Stack
- Node.js ESM, Ollama (planning/decisions), SQLite (coding tasks, grants, audit), JSON checkpoint files in `storage/agent-checkpoints/` (orchestrator / repair)
