# IndicTrans2 Translation Service

A small local Python microservice that runs [AI4Bharat's IndicTrans2](https://github.com/AI4Bharat/IndicTrans2) — a neural machine translation model purpose-built for Indian languages — and exposes it over a plain local HTTP API. The main Chanakya AI backend (Node/Express) calls this service the same way it already calls Ollama: a separate local process, reached over loopback HTTP, never anything remote.

This is a genuinely separate runtime from the rest of the app (Node/Electron). It is **not** started automatically, **not** bundled into the packaged `.exe`, and **not** required for the rest of the app to work — only the Translator feature depends on it. Everything else (chat, RAG, documents, auth) is unaffected if this service isn't running.

## Why a separate service, not part of the Node backend

IndicTrans2 is a PyTorch/HuggingFace model with custom tokenization (`IndicTransToolkit`, script normalization/transliteration). There is no mature way to run it from Node.js directly. Running it as a small FastAPI service mirrors exactly how this app already treats Ollama — a local, loopback-only AI backend the Node server calls over HTTP — rather than inventing a different integration pattern.

## Setup

**1. Prerequisite:** Python 3.10 or newer.

**2. Create a virtual environment and install dependencies:**

```bash
cd indictrans-service
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux
pip install -r requirements.txt
```

For GPU/CUDA support, install the matching CUDA build of PyTorch *before* the step above — see [pytorch.org/get-started/locally](https://pytorch.org/get-started/locally/) for the exact command for your CUDA version. `pip install -r requirements.txt` will then see `torch` already satisfied and leave it alone. Without this step, the CPU-only build is installed and the service runs on CPU (slower, but fully functional).

**3. Download the models — a separate, explicit step (never automatic):**

```bash
python scripts/download_model.py --dest ./models
```

This downloads three checkpoints (~200-320M parameters each, the "distilled" variants — smaller and faster than IndicTrans2's full 1B-parameter models, appropriate for a desktop app) from HuggingFace: `en-indic`, `indic-en`, `indic-indic`. This is a one-time, multi-hundred-MB-to-low-GB download per direction. You can download only the directions you need with `--only en-indic indic-en`, for example — the service degrades gracefully (a clear "model not loaded" error, not a crash) for any direction whose checkpoint isn't present.

**4. Configure:**

```bash
cp .env.example .env
```

Edit `.env` and set `INDICTRANS_MODEL_PATH` to the `--dest` path from step 3 (e.g. `./models`, resolved to an absolute path).

**5. Run:**

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8100
```

**6. Verify:**

```bash
curl http://127.0.0.1:8100/health
```

Should report `"status": "ok"` and which directions loaded successfully.

**7. Point the Node backend at it:** in `backend/.env`, set `INDICTRANS_SERVICE_URL=http://127.0.0.1:8100` (this is already the default, so it's only needed if you changed the port in step 6).

## Auto-start

The Node backend auto-starts this service for you — you no longer need a third terminal running `uvicorn` by hand. On every backend startup (`npm run dev`, `npm start`, or the packaged `.exe`), it checks whether this service is already reachable; if not, and a completed setup (venv + downloaded models, steps 1-5 above) is found, it spawns `uvicorn` itself in the background. The spawned process is intentionally **not** tied to the backend's own lifecycle — it keeps running even if the backend restarts (e.g. every file save under `node --watch`) or exits, exactly like this app already treats Ollama, since reloading ~6GB of model weights on every restart would make active development painful. Stop it yourself (Task Manager, or `taskkill`) if you want it gone.

This is found automatically as long as `indictrans-service/` sits where it does in this repo — a sibling of `backend/`. That's always true for a normal dev checkout, but **not** true for the packaged `.exe`: its bundled backend is copied away from the rest of the repo (deliberately — the venv and model weights are never shipped in the installer). To make the packaged app auto-start it too, set an `INDICTRANS_SERVICE_DIR` environment variable (Windows: System Properties → Environment Variables, or `setx INDICTRANS_SERVICE_DIR "C:\path\to\indictrans-service"`) pointing at your local setup — the exe inherits it from the OS environment. Without it, the packaged app behaves as before: it just logs that the service isn't reachable and expects you to start it manually.

## CPU vs GPU

`TRANSLATION_DEVICE` in `.env`:
- `auto` (default) — uses CUDA if `torch.cuda.is_available()`, otherwise CPU.
- `cpu` — force CPU even if a GPU is present (useful for testing).
- `cuda` — force GPU; fails clearly at load time if no CUDA device is available.

CPU inference works but is meaningfully slower per request than GPU. This is a translation service for a desktop app processing one request at a time, not a high-throughput deployment — CPU is a reasonable default for most users; GPU is worth the setup effort if you're translating frequently or in bulk.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/health` returns `model_missing` | `INDICTRANS_MODEL_PATH` unset, or `download_model.py` hasn't been run yet |
| A specific direction (e.g. Tamil→Hindi) returns `MODEL_NOT_LOADED` (503) but others work | That direction's checkpoint wasn't downloaded — re-run `download_model.py --only indic-indic` |
| First request after starting the service is very slow | Expected — model weights load into memory lazily on first use in some configurations, or the OS is paging in a large checkpoint file for the first time. Subsequent requests reuse the already-loaded model and are much faster. |
| `CUDA not detected` even though you have a GPU | Confirm you installed the CUDA build of `torch` (see step 2) — the default `pip install -r requirements.txt` alone installs CPU-only |
| Node backend logs "IndicTrans2 service not reachable" at startup | This service isn't running, or `INDICTRANS_SERVICE_URL` doesn't match the port it's actually listening on |
| `ImportError: IndicTransToolkit` | `pip install -r requirements.txt` didn't complete, or you're running `uvicorn` from outside the activated virtualenv |

## API

See `/health` and `POST /translate` in `app/main.py`. Full API documentation, curl examples, and the Node-side integration contract live in [`docs/translation-architecture.md`](../docs/translation-architecture.md) at the repo root.
