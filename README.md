# Chanakya Enterprise AI Assistant

A private, desktop-style knowledge assistant built around Ollama and a local LanceDB vector store. Documents, embeddings, chat history, speech recognition, and generation remain on the machine.

## Architecture

```text
PDF / DOCX / XLSX / CSV / TXT
            │
            ▼
   local text extraction
            │
            ▼
  overlapping text chunks ──► Ollama embeddings
                                  │
                                  ▼
                            local LanceDB
                                  │
User question ──► similarity search ──► cited context ──► Ollama generate ──► streamed answer
```

## Stack

- UI: React 19, Vite, Tailwind CSS, Framer Motion, Axios
- API: Node.js 20+, Express, Multer
- parsing: `pdf-parse`, `mammoth`, `read-excel-file`
- RAG: Ollama embeddings + LanceDB persisted under `backend/storage/lancedb`
- voice: browser microphone capture + Windows on-device speech recognition; browser speech synthesis for read-aloud

## Prerequisites

1. Install [Node.js 20 or newer](https://nodejs.org/).
2. Install [Ollama](https://ollama.com/) and start it:

   ```powershell
   ollama serve
   ```

3. Pull an embedding model and at least one chat model:

   ```powershell
   ollama pull nomic-embed-text
   ollama pull llama3
   ```

   Other supported chat models are `mistral`, `qwen3`, `deepseek-r1`, and `gemma3`.

## Install and run

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. The local API listens only on `127.0.0.1:3001` and Vite proxies `/api` during development.

## Production build

```powershell
npm run build
npm start
```

Open `http://127.0.0.1:3001`. Express serves the compiled frontend and API from one local process.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/upload` | Multipart upload (`documents`) and local indexing |
| `POST` | `/api/chat` | NDJSON streaming chat response with retrieved sources |
| `GET` | `/api/models` | Supported and locally installed Ollama models |
| `GET` | `/api/history` | Persisted conversation sessions and messages |
| `GET` | `/api/documents` | Persisted local knowledge-library metadata |
| `GET` | `/api/health` | Local API health check |

Example chat request:

```json
{
  "message": "Summarize the main operational risks",
  "model": "llama3",
  "history": []
}
```

## Local data and security

- The API binds to loopback (`127.0.0.1`) and has no cloud AI integration.
- Startup rejects an `OLLAMA_URL` whose hostname is not loopback.
- Ollama defaults to `http://127.0.0.1:11434`.
- Uploaded originals live under `backend/storage/uploads`.
- vectors live under `backend/storage/lancedb`.
- chat history lives in `backend/storage/history.json`.
- generated runtime data is ignored by Git.
- the frontend does not import remote fonts, analytics, or third-party scripts.
- push-to-talk records a local WAV and uses Windows' installed speech engine through the loopback API; it does not fall back to network-backed recognition.

For a stricter deployment, limit filesystem permissions on `backend/storage`, use full-disk encryption, and set `FRONTEND_ORIGIN` to the exact local origin.

## Configuration

Copy `.env.example` to `.env` and adjust:

| Variable | Default |
| --- | --- |
| `PORT` | `3001` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` |
| `DEFAULT_MODEL` | `llama3` |
| `EMBEDDING_MODEL` | `nomic-embed-text` |
| `MAX_FILE_SIZE_MB` | `25` |
| `RAG_TOP_K` | `5` |
| `FRONTEND_ORIGIN` | `http://localhost:5173` |

## Tests

```powershell
npm test
```

## Folder structure

```text
chanakya/
├── backend/
│   ├── src/
│   │   ├── lib/                 # chunking and tests
│   │   ├── routes/              # upload, chat, models, history
│   │   ├── services/            # extraction, Ollama, vectors, history
│   │   ├── app.js
│   │   ├── config.js
│   │   └── server.js
│   └── storage/                 # local uploads, vectors, chat history
├── frontend/
│   ├── public/                  # Chanakya avatar
│   └── src/
│       ├── components/
│       ├── hooks/
│       ├── lib/
│       ├── App.jsx
│       └── styles.css
├── .env.example
└── package.json
```
