# Translation architecture (IndicTrans2)

The Translator feature (sidebar tab, `POST /api/translate`) translates between English and five Indian languages using [AI4Bharat's IndicTrans2](https://github.com/AI4Bharat/IndicTrans2), a neural machine translation model purpose-built for Indic languages — not a general-purpose chat LLM prompted to translate.

## 1. Architecture

```text
User (Translator UI or curl)
        │
        ▼
POST /api/translate            requireAuth ─► translateLimiter (per-user, 15/min default)
        │
        ▼
Input validation                requireEnum/requireString (backend/src/lib/validate.js)
        │
        ▼
Language resolution             "auto" ─► languageDetect.js (Unicode script heuristic)
        │                       explicit code ─► used as-is
        ▼
Glossary substitution           glossary.js — known English terms swapped for a
        │                       pre-approved target-language rendering, word-boundary-safe
        ▼
Translation router              backend calls the IndicTrans2 service's /translate;
        │                       the service itself picks one of 3 directional models
        ▼
IndicTrans2 microservice        indictrans-service/ (Python, FastAPI) — local process,
   (loopback HTTP)               loopback-only, exactly like this app already talks to Ollama
        │
        ▼
Translated text
        │
        ▼
Optional Qwen3 post-processing   translationPostProcess.js — OFF by default
   (TRANSLATION_POST_PROCESSING) (TRANSLATION_POST_PROCESSING=true). Light fluency polish
        │                        only; failure here is non-fatal (falls back to the
        │                        unpolished IndicTrans2 output).
        ▼
{ translation } response
```

Qwen3/Ollama is never the translator. It is available only as an optional, disabled-by-default polish pass over IndicTrans2's own output — the same local Ollama instance every other AI feature in this app already uses, not a second AI backend.

## 2. Supported languages

| Language | Code (FLORES-200) | Native |
|---|---|---|
| English | `eng_Latn` | English |
| Hindi | `hin_Deva` | हिन्दी |
| Tamil | `tam_Taml` | தமிழ் |
| Kannada | `kan_Knda` | ಕನ್ನಡ |
| Telugu | `tel_Telu` | తెలుగు |
| Malayalam | `mal_Mlym` | മലയാളം |

Supported translation modes: English → Indic, Indic → English, and Indic → Indic (e.g. Tamil → Hindi, Kannada → Malayalam). Both languages must be in the table above and must differ — the same-language case short-circuits to the input text unchanged, with no model call.

### How to add another Indic language

1. Add one entry to `backend/src/services/languageRegistry.js`'s `LANGUAGES` object.
2. Add the matching entry to `indictrans-service/app/languages.py`'s `LANGUAGES` dict.
3. Add the display entry (label + native script) to `frontend/src/translator/TranslatorPanel.jsx`'s `LANGUAGES` array.
4. Confirm IndicTrans2's checkpoints actually cover the language — if not, this requires an updated checkpoint or fine-tuning (see §13), not a code change here.

No other file needs to change — the route, service, rate limiter, and UI all read from these registries rather than hardcoding a language list.

## 3. Model

**AI4Bharat IndicTrans2**, distilled checkpoints (200-320M parameters — smaller and faster than the full 1B-parameter models, chosen for desktop CPU inference):

| Direction | HuggingFace checkpoint |
|---|---|
| English → Indic | `ai4bharat/indictrans2-en-indic-dist-200M` |
| Indic → English | `ai4bharat/indictrans2-indic-en-dist-200M` |
| Indic → Indic | `ai4bharat/indictrans2-indic-indic-dist-320M` |

These are three separate models, not one multi-directional model — the "translation router" in the architecture diagram picks the right one based on the request's source/target languages (`indictrans-service/app/languages.py`'s `resolve_direction()`).

## 4. Installation & setup

Full setup instructions live in [`indictrans-service/README.md`](../indictrans-service/README.md). Summary:

```bash
cd indictrans-service
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
python scripts/download_model.py --dest ./models   # separate, explicit, one-time
cp .env.example .env   # set INDICTRANS_MODEL_PATH=./models
uvicorn app.main:app --host 127.0.0.1 --port 8100
```

The Node backend never downloads or auto-starts this service. Translation requests fail with a clear error (not a crash) if it isn't running.

## 5. CPU / GPU configuration

`TRANSLATION_DEVICE` in `indictrans-service/.env`: `auto` (default, uses CUDA if available), `cpu`, or `cuda` (forces GPU, fails clearly if unavailable). See the service README's CPU vs GPU section for guidance on when GPU setup is worth the effort.

## 6. Environment variables

**Node backend** (`backend/.env`):

| Variable | Default | Purpose |
|---|---|---|
| `INDICTRANS_SERVICE_URL` | `http://127.0.0.1:8100` | Where the Python service listens |
| `INDICTRANS_TIMEOUT_MS` | `120000` | Max wait for one translation |
| `TRANSLATE_MAX_CHARS` | `5000` | Max input text length |
| `TRANSLATION_POST_PROCESSING` | `false` | Enable optional Qwen3 polish pass |
| `TRANSLATION_POST_PROCESSING_MODEL` | falls back to `DEFAULT_MODEL`, then `qwen3` | Model used for polish |
| `TRANSLATION_POST_PROCESSING_TIMEOUT_MS` | `30000` | Max wait for the polish pass |
| `TRANSLATE_WINDOW_MS` / `TRANSLATE_MAX_REQUESTS` | `60000` / `15` | Rate limit window/ceiling, per user |

**Python service** (`indictrans-service/.env`): `INDICTRANS_HOST`, `INDICTRANS_PORT`, `INDICTRANS_MODEL_PATH`, `TRANSLATION_DEVICE`, `INDICTRANS_MAX_CHARS`, `INDICTRANS_MAX_NEW_TOKENS`, `INDICTRANS_NUM_BEAMS` — see `indictrans-service/.env.example` for defaults.

## 7. API usage

```bash
curl -X POST http://127.0.0.1:3001/api/translate \
  -H "Authorization: Bearer <session token>" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "The motor should be disconnected before maintenance.",
    "sourceLanguage": "eng_Latn",
    "targetLanguage": "tam_Taml"
  }'
```

```json
{ "translation": "பராமரிப்பிற்கு முன் மோட்டார் துண்டிக்கப்பட வேண்டும்." }
```

Auto-detect the source language:

```bash
curl -X POST http://127.0.0.1:3001/api/translate \
  -H "Authorization: Bearer <session token>" \
  -H "Content-Type: application/json" \
  -d '{ "text": "வணக்கம்", "sourceLanguage": "auto", "targetLanguage": "eng_Latn" }'
```

Error response shape (always `{ "error": "<safe message>" }`, HTTP status varies — 400 for a bad request, 503 for the translation service being unreachable/not-loaded, 504 for a timeout, 429 for rate limiting):

```json
{ "error": "The translation model is not installed or not loaded. See indictrans-service/README.md for setup." }
```

## 8. Frontend usage

Sidebar → **Translator**. Pick "From" (or leave on "Auto Detect") and "To", type or paste text, press **Translate** (or Ctrl+Enter). Swap is disabled while "Auto Detect" is selected — there's nothing to swap it with.

## 9. Security

- Same authentication as every other route: `requireAuth` (Bearer session token), no separate auth system.
- Loopback-only: both the Ollama and IndicTrans2 endpoints must resolve to `localhost`/`127.0.0.1` — this app refuses remote AI endpoints by design.
- No credentials in play at all for the translation engine itself — IndicTrans2 has no API key.
- Errors returned to the client are always hand-authored safe messages (`TranslationError` in `translationService.js`); raw provider details (filesystem paths, stack traces, internal error text) are logged server-side only, tagged with the request's correlation id, never sent to the client.
- Logging is structured and operational only — source/target language, character count, duration, engine used. The translated text itself is never logged.

## 10. Rate limiting

`translateLimiter` (`backend/src/middleware/rateLimiter.js`), keyed per authenticated user (not per-IP — every request in this desktop app shares one loopback address, so an IP-based key would let one busy account exhaust the budget for everyone on the machine). Default: 15 requests/minute per user, configurable via `TRANSLATE_WINDOW_MS`/`TRANSLATE_MAX_REQUESTS`.

## 11. Troubleshooting

See [`indictrans-service/README.md`](../indictrans-service/README.md)'s troubleshooting table for service-side issues (model not loaded, CUDA not detected, etc.). On the Node side: the backend logs a one-time, non-blocking check at startup (`[translate] IndicTrans2 service reachable...` or a "not reachable" warning) — check the backend's console output first if translation requests are failing.

## 12. Deferred to a later phase

These were explicitly scoped out of the initial implementation (see the design plan this feature was built from) and are documented here so implementing them later is mechanical, not a redesign:

- **PDF/document translation.** Design sketch: a new `POST /api/translate/document` route, reusing only `backend/src/services/documentService.js`'s `extractDocument()`/`isSupportedDocument()` for text extraction — never `chunkText.js`/`vectorService.js`, which are RAG-specific and must not be touched by translation (no embeddings or vector records should ever be created for a translation request). Extracted text would be split into paragraphs, each paragraph run through a `preserveNonTranslatable()` masking pass (regex-based: URLs, email addresses, code-fence blocks, likely API keys/tokens/hashes, file paths — each replaced with a placeholder unlikely to be mangled by translation, e.g. a rare Unicode private-use-area marker rather than plain brackets) before being sent to `/translate`, then reassembled with the masked spans restored from their original text afterward. Structure preservation (headings, lists, tables) needs care specific to each source format (`.docx` via mammoth, `.pdf` via pdf-parse) and should be prototyped against real documents before committing to an approach.
- **Glossary beyond the seed mechanism** — the current `glossary.js` proves the substitution mechanism with two example entries; a real deployment would want a larger, persistent (file- or DB-backed) glossary, and support for Indic-keyed (not just English-keyed) terms.
- **Batching / multi-paragraph limits** — no real latency data exists yet from an actual IndicTrans2 deployment to size this correctly.
- **Electron packaging of the Python service.** The service currently must be started manually, alongside the Node backend and Ollama. Auto-start/stop lifecycle management from the Electron main process, and bundling a Python runtime into the packaged `.exe`, are both out of scope for now — `frontend/scripts/prepare-backend.cjs`/`afterPack.cjs` are Node-only and untouched by this feature.

## 13. Future fine-tuning preparation

Not implemented — inference must be proven reliable first. If domain-specific fine-tuning is pursued later, parallel-corpus training data should use this shape:

```json
{
  "source_language": "eng_Latn",
  "target_language": "tam_Taml",
  "source_text": "The bearing should be replaced.",
  "target_text": "தாங்கியை மாற்ற வேண்டும்."
}
```

Applicable to any supported pair — English↔Hindi/Tamil/Telugu/Kannada/Malayalam, or Indic↔Indic (Tamil↔Hindi, etc.).
