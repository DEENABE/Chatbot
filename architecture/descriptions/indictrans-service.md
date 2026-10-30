Optional local Python microservice that runs AI4Bharat IndicTrans2 checkpoints for English ↔ Indic and Indic ↔ Indic translation, giving higher-quality Indic translations than a general LLM.

**Status:** Implemented, optional. It needs a separately installed translator pack (bundled Python + model weights, `build-translator-pack.cmd`, `indictrans-service/setup-translator.cmd`); when missing, the backend falls back to Ollama.

## Responsibilities
- FastAPI app `indictrans-service/app/main.py`: `GET /health`, `POST /translate` (400 for unsupported pair, 503 when the model isn't loaded)
- Language codes and direction resolution in `app/languages.py`; lazy model loading in `app/model_registry.py`; request/response schemas in `app/schemas.py`
- Bound to `127.0.0.1:8100` by design ("do not expose beyond localhost")
- Started detached by the backend (`backend/src/services/indictransProcess.js`) from the pack's own `python/python.exe` or a dev `.venv`, and stopped only if the backend owns it

## Tech Stack
- Python, FastAPI, uvicorn, pydantic 2, torch, transformers **4.44.2 (pinned)**, sentencepiece, IndicTransToolkit
