Gives the assistant scoped, auditable memory across four tiers — per-conversation short-term facts, per-task state, per-user long-term facts and per-machine system facts — while refusing to store secrets or anything not typed by the user.

**Status:** Implemented (typed tiers). The older flat `memories` table + `services/memoryService.js` is still served by `GET/POST/DELETE /api/memory` (legacy, kept for compatibility).

## Responsibilities
- `memory/MemoryManager.js`: `observeConversation`, `processUserMessage`, `observeReportedTools` — entry points called from chat/agent routes
- `memory/MemoryCandidateExtractor.js`: only the authenticated user's own text is eligible ("never scan RAG or model output")
- `memory/MemoryPolicy.js` + `memory/validation.js`: decisions and a secret detector that rejects passwords, bearer/JWT-looking strings, API keys, private keys, long hex tokens
- `memory/ShortTermMemoryService.js` (≤24 entries, 16 KB, 24 h TTL), `TaskMemoryService.js` (revisioned events), `LongTermMemoryService.js` (category/key/value + confidence), `SystemMemoryService.js` (STATIC / SEMI_STATIC / DYNAMIC with expiry)
- `memory/MemoryRetriever.js`: budgeted context block + `MEMORY_GUIDANCE` prompt text injected into chat
- `memory/runtime.js`: shared `memoryManager`, `memoryRequest` middleware (AsyncLocalStorage scope), checkpoint projection
- Every write is recorded in `memory_audit`

## Tech Stack
- better-sqlite3 tables created by `memory/migrations.js` (versioned via `memory_migrations`)
