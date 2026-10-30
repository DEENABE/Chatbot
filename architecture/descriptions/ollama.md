User-installed local LLM server that performs every chat, coding, planning and embedding inference Chanakya AI needs; the app never ships or downloads model weights itself.

**Status:** Implemented (required dependency)

## Responsibilities
- Serve chat/completions (`/api/chat`, `/api/generate`) and embeddings (`/api/embed`, legacy `/api/embeddings`)
- Report installed models and their declared capabilities (`/api/tags`, `/api/show`) so the model router can pick eligible models per agent
- Report loaded models (`/api/ps`) for hardware-aware placement

## Tech Stack
- Ollama at `OLLAMA_URL` (default `http://127.0.0.1:11434`; `localServiceUrl()` in `backend/src/config.js` rejects non-local URLs)
- Default embedding model `nomic-embed-text`; default coding model `qwen2.5-coder:14b` (both overridable via env / Settings)
