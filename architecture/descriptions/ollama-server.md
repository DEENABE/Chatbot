The user's local Ollama daemon as seen from the backend: the single inference endpoint for chat, coding, planning, vision and embeddings.

**Status:** Implemented (external prerequisite — the backend starts without it but every model feature reports "offline")

## Responsibilities
- `POST /api/chat` / `/api/generate` — streamed chat and JSON-mode completions (`services/ollamaService.js`, `coding/CodingModelAdapter.js`)
- `POST /api/embed` — document and query embeddings (`services/vectorService.js`)
- `GET /api/tags`, `POST /api/show` — model discovery and declared capabilities (`completion`, `vision`, `tools`, `embedding`) used by `services/modelRouter.js`
- `GET /api/ps` — currently loaded models (`listLoadedModels()` in `services/ollamaService.js`, also `services/modelRegistry.js`), fed to `services/gpuProfile.js` for hardware-aware residency

## Tech Stack
- Ollama HTTP API on `OLLAMA_URL` (local-only enforced by `lib/localServiceUrl.js`); remote/cloud models are rejected by the coding adapter (`isRemoteModel`)
