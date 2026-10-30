Shared, checkpointed state machine that every multi-step agent runs on, so a step that needs approval, fails, or is interrupted by a restart can be resumed, reconciled or cancelled safely instead of being silently retried.

**Status:** Implemented

## Responsibilities
- `orchestrator/AgentState.js`: step list, phases (`idle`, `plan`, `decide`, `waiting_confirmation`, `replan`, terminal states), budgets (`isStepBudgetExhausted`, `canReplan`, `currentStep`)
- `orchestrator/ExecutionController.js`: `plan`, `execute`, `stop`, `finish`; persists through a `save` callback
- `orchestrator/CheckpointStore.js`: one JSON file per run in `storage/agent-checkpoints/`
- `orchestrator/ExecutionSessions.js`: single active session per owner (`claimSession`, `cancelSessionRequest`)
- Recovery: `CheckpointRecovery.js`, `ManualRecovery.js` (`reviewCheckpoint`, `renewCheckpointConfirmation`) behind `/api/orchestrate/checkpoints/:id/{recovery,reconcile,resume,cancel,confirmation/renew}`
- Used by the coding agent (`ExecutionController` + `AgentState`, with SQLite persistence) and by the repair / orchestrator agents (JSON checkpoints)

## Tech Stack
- Node.js `fs` (atomic JSON writes), no external dependency
