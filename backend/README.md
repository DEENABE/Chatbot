# Local AI Assistant (RAG over your database)

Local desktop AI assistant using Ollama-served models (Llama/Qwen/Mistral/Gemma)
with a RAG pipeline over your existing database. Fast retrieval + reranking +
context compression before generation, with per-user token usage tracking.

## 1. Prerequisites

- Node.js 18+
- [Ollama](https://ollama.com) installed and running locally
- Pull the models you need:
  ```bash
  ollama pull qwen2.5:7b          # or llama3.1:8b, mistral:7b, gemma2:9b
  ollama pull nomic-embed-text    # embedding model
  ```

## 2. Install

```bash
cd local-ai-assistant
npm install
cp .env.example .env
```

Edit `.env` — set `CHAT_MODEL` to whichever model you're actually running
(`llama3.1:8b`, `qwen2.5:7b`, `mistral:7b`, or `gemma2:9b`), and point
`SOURCE_DB_URL` at your real database once you wire it up (see step 3).

## 3. Connect your real database

Open `src/ingest/loadSources.js`. It ships with a demo in-memory dataset so
the pipeline runs out of the box. Replace `loadFromSourceDb()` and
`countSourceRows()` with a real adapter — commented Postgres and MySQL
examples are included in that file. This is the ONLY file you need to
change to point the assistant at your actual huge database.

## 4. Index your data ("training" step)

This is not model fine-tuning — it's building the searchable vector index
your model will pull context from at answer time.

```bash
npm run ingest
```

Safe to re-run any time — already-indexed chunks are skipped via content
hash, so this doubles as your incremental update job. Schedule
`scripts/reindex.sh` via cron to keep the index fresh as your source DB
changes.

## 5. Start the server

```bash
npm start
```

## 6. Ask a question

```bash
curl -N -X POST http://localhost:3000/assistant/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What was the Q3 revenue growth?", "userId": "u1"}'
```

Streams back Server-Sent Events: `{"token": "..."}` chunks, then a final
`{"done": true, "usage": {...}, "sources": [...]}`.

## 7. Check token usage

```bash
curl http://localhost:3000/usage/u1
```

## File map

| File | Purpose |
|---|---|
| `src/server.js` | Express app entry point |
| `src/config/index.js` | All tunable settings (models, topK, token budget, context limits) |
| `src/db/schema.sql`, `connection.js` | SQLite + sqlite-vec index setup |
| `src/ingest/*` | Indexing pipeline: clean → chunk → embed → store (run via `npm run ingest`) |
| `src/retrieval/*` | Query-time: embed query → vector search → rerank → compress context |
| `src/llm/*` | Ollama client, prompt building, token counting/limits |
| `src/routes/ask.js` | Main RAG endpoint (streaming) |
| `src/routes/ingestRoute.js` | Optional API-triggered re-index (batch by batch) |
| `src/routes/usage.js` | Per-user token usage lookup |
| `src/middleware/*` | Error handling, rate limiting |
| `scripts/reindex.sh` | Cron-friendly re-index trigger |

## Tuning knobs (in `.env`)

- `VECTOR_TOPK` — how many candidates to pull from vector search (default 20)
- `RERANK_TOPK` — how many survive reranking into the final context (default 6)
- `CONTEXT_TOKEN_BUDGET` — max tokens of context sent to the LLM (default 1500)
- `CHUNK_SIZE_TOKENS` / `CHUNK_OVERLAP_TOKENS` — indexing chunk size (default 400/50)

## What's still on you

- Wiring `loadSources.js` to your actual DB (only real gap left)
- If you want higher-precision reranking, swap the heuristic in
  `retrieval/rerank.js` for a real cross-encoder model (e.g. `bge-reranker-base`)
  served locally
- Multi-turn conversation memory isn't included — `promptBuilder.js` accepts
  a `history` array, you'd need to store/pass prior turns per session
