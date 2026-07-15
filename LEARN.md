# Chanakya AI — Code Map & Learning Guide

A guide to *where* everything lives and *what order* to read it in. Paths are
relative to the project root (`E:\chatbot`).

---

## 1. The big picture — 3 processes

```
Electron main process        React UI (renderer)         Express backend
frontend/electron/           frontend/src/               backend/src/
- opens the window           - chat screen, buttons      - REST + streaming API
- runs Windows tools         - talks to backend over     - talks to Ollama (LLM)
- starts the backend           http://127.0.0.1:3001     - LanceDB + JSON store
```

- The **UI** never talks to the LLM directly. It calls the **backend**.
- The **backend** talks to **Ollama** (the local AI) and stores data.
- The **Electron main** process wraps everything into a desktop app and also
  runs the low-level Windows tools.

---

## 2. Suggested reading order (start here)

Read these in order — each builds on the last.

### Step 1 — How a chat message flows (the core loop)
1. `frontend/src/chat/InputArea.jsx` — the text box + buttons. `handleSend()` is
   where a message begins.
2. `frontend/src/stores/useAppStore.js` → `sendMessage()` — the "brain" of the
   UI. It adds your message, calls the backend, and streams the answer back.
   This is the single most important file to understand.
3. `frontend/src/services/api.js` → `streamChat()` — how the UI reads the
   backend's streaming (NDJSON) response line by line.
4. `backend/src/routes/chat.js` — the backend endpoint. Builds the prompt,
   searches your documents, and streams tokens from the model.
5. `frontend/src/chat/MessageList.jsx` — how messages are drawn on screen
   (and the scroll behaviour).

### Step 2 — How the AI actually runs (Ollama)
6. `backend/src/services/ollamaService.js` — every call to the local AI.
   - `streamChat()` — chat + tool-calling
   - `streamGenerate()` — plain text generation
   - `embed()` — turns text into vectors (for document search)

### Step 3 — How documents become searchable (RAG)
7. `backend/src/routes/upload.js` — receives uploaded files.
8. `backend/src/services/documentService.js` — extracts text from PDF/DOCX/XLSX.
9. `backend/src/lib/chunkText.js` — splits text into chunks.
10. `backend/src/services/vectorService.js` — embeds chunks and stores/searches
    them in LanceDB. `searchChunks()` is the "retrieval" in RAG.

### Step 4 — The autonomous Auto-Repair agent (what we built)
Read these together — this is a complete mini-agent:
11. `backend/src/agent/agentBrain.js` — asks the AI "what's the next step?" and
    gets back a JSON decision. Read the `SYSTEM_PROMPT` — that text *is* the
    agent's personality and rules.
12. `backend/src/agent/dangerClassifier.js` — decides if a command is safe to
    run automatically (`read` / `fix` / `blocked`).
13. `backend/src/agent/powershellRunner.js` — actually runs a PowerShell command.
14. `backend/src/agent/agentLoop.js` — the loop that ties 11–13 together:
    think → run → observe → repeat.
15. `backend/src/routes/agent.js` — exposes the loop at `POST /api/agent`.
16. `backend/src/agent/runAgent.cli.js` — run the agent from the terminal:
    `node src/agent/runAgent.cli.js "wifi not working" --max 6`
17. In the UI: `useAppStore.js` → `_streamAutoRepair()` and the Wrench toggle in
    `InputArea.jsx`.

### Step 5 — Login, password, data storage
18. `backend/src/routes/auth.js` — login / register / change-password /
    reset-password endpoints.
19. `backend/src/services/authService.js` — password hashing (scrypt) and the
    actual logic.
20. `backend/src/db/connection.js` — the small home-made "database". It stores
    everything in a JSON file and fakes just enough SQL to work. Read this to
    understand how history, folders, users, and documents are saved.
21. `frontend/src/components/LoginScreen.jsx` — the login / forgot-password UI.
22. `frontend/src/profile/ProfileDetails.jsx` — the change-password UI.

### Step 6 — The Windows tools (structured version)
23. `frontend/tools/ToolEngineRouter.js` — routes a `{tool, action, params}`
    request to the right service.
24. `frontend/tools/services/*.js` — one file per capability: `PowerShellService`,
    `NetworkService`, `ProcessService`, `WinServicesService`, `HardwareService`,
    `RegistryService`, `FileService`, `CmdService`. Each lists its `actions`.
25. `frontend/tools/BaseToolService.js` — the shared "validate → confirm → run"
    lifecycle every tool follows.
26. `frontend/electron/preload.cjs` — the secure bridge that lets the UI call
    these tools (`window.toolEngine`).

---

## 3. Folder cheat-sheet

| Folder | What's in it |
|---|---|
| `backend/src/routes/` | API endpoints (one file per feature) |
| `backend/src/services/` | The logic behind each endpoint |
| `backend/src/agent/` | The autonomous Auto-Repair agent |
| `backend/src/db/` | The JSON "database" |
| `frontend/src/` | The React UI |
| `frontend/src/stores/useAppStore.js` | All UI state + actions (Zustand) |
| `frontend/src/services/api.js` | Every call the UI makes to the backend |
| `frontend/electron/` | The desktop-app shell (window, tray, backend launcher) |
| `frontend/tools/` | The 8 structured Windows tools |

---

## 4. How to run it while learning (see changes live)

```powershell
# 1. Make sure Ollama is running with the models
ollama serve
ollama pull qwen3
ollama pull nomic-embed-text

# 2. Run backend + frontend in dev mode (auto-reloads on edits)
cd E:\chatbot
npm run dev
```

Then open `http://localhost:5173`. Edit any file under `frontend/src` and the
page reloads instantly. Edit any `backend/src` file and the backend restarts.

> Tip: the structured Windows tools (Wrench button aside) only work inside the
> real Electron app, not the browser. To run the desktop app in dev:
> `npm run electron` from the `frontend` folder.

---

## 5. Two concepts worth understanding deeply

- **Streaming (NDJSON):** the backend sends one JSON object per line as the
  answer is generated, instead of waiting for the whole thing. Look at how
  `send({ type: 'token', text })` in the backend matches `onToken` in
  `api.js`. Every `type` (`sources`, `token`, `tool_call`, `done`, `error`)
  has a matching handler in the UI.

- **The agent loop (ReAct):** the AI doesn't fix your PC in one shot. It does
  one small step, reads the result, then decides the next step. That "decide →
  act → observe → repeat" cycle in `agentLoop.js` is the heart of every AI
  agent, including big ones.
