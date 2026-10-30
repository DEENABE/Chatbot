In-chat document/data agent that summarizes whole documents, cleans and transforms spreadsheets with exact JavaScript arithmetic, converts between formats, extracts entities, and organizes folders through a reviewable plan → apply → undo cycle.

**Status:** Implemented (added 27 Oct 2026 per `docs/FILE_AGENT.md`)

## Responsibilities
- Routing: `fileagent/intent.js` (`detectFileTask`) is checked by `routes/chat.js` before normal doc retrieval; `fileagent/index.js` (`runFileAgent`) runs the task with deps from `fileagent/runtime.js`
- Table operations: the model proposes a JSON plan (`planner.js` → `planTableOperations`, `validatePlan`, `fallbackPlan`), and `tableOps.js` executes it exactly (dedupe, filter, merge, group totals)
- Summaries: map → reduce over every chunk (`summarize.js`), not just retrieved ones
- Extraction: emails, phones, dates, amounts, links, tables (`extract.js`)
- Outputs: CSV/XLSX writers (`writers.js`), DOCX/HTML→PDF (`documents.js`), served via `GET /api/file-agent/outputs/:id` (`outputs.js`)
- Folder organization (`organize.js`): `createPlan` (read-only preview) → `POST /api/file-agent/plans/:id/apply` → `POST .../undo`; refuses protected roots (`assertOrganizableRoot`) and only moves files inside the chosen folder
- UI: `frontend/src/chat/FileAgentLink.jsx` renders download / Apply / Undo buttons

## Tech Stack
- Node.js, no extra npm dependency (XLSX/DOCX written directly), Ollama for planning/summaries
