import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const ollamaHost = new URL(ollamaUrl).hostname;
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(ollamaHost)) {
  throw new Error('OLLAMA_URL must point to localhost. Chanakya AI refuses remote AI endpoints.');
}

// Development retains its existing data. Electron passes a writable per-user
// root for installed builds; mutable data never goes under resources/ASAR.
const appDataPath = path.resolve(process.env.APP_DATA_PATH || root);
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host))
  throw new Error('HOST must be loopback for the local desktop API.');
const translationUrl = process.env.INDICTRANS_SERVICE_URL || 'http://127.0.0.1:8100';
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(translationUrl).hostname))
  throw new Error('INDICTRANS_SERVICE_URL must point to localhost.');

export const config = {
  // The one canonical persistent-data root everything else in this file
  // (dbFile, uploadDir, vectorDir, pluginsDir, ocrDir) is derived from.
  // Exposed directly so diagnostics/scripts can report it without having
  // to re-derive it from dbFile's path.
  appDataPath,
  // Must match frontend/electron/utils/constants.js's BACKEND_PORT — that
  // file can't import this one (separate package, no shared module path
  // across the Electron/Node boundary), so the default here is kept in
  // sync with it by hand. If you change one, change the other.
  port: Number(process.env.PORT || 3001),
  // Loopback only — the README already claimed this, but app.listen() never
  // actually passed a host, so Node defaulted to 0.0.0.0 (every interface).
  // Anyone else on the same network could reach the agent/repair PowerShell
  // routes; this closes that off.
  host,
  ollamaUrl,
  // No built-in chat model. Models are discovered from the local Ollama at run time (services/modelRouter.js,
  // services/modelRegistry.js) and chosen in Settings → Models or automatically from their declared capabilities.
  // DEFAULT_MODEL only pins a tag for background jobs that have no signed-in user; empty means "decide at run time".
  defaultModel: process.env.DEFAULT_MODEL || '',
  // Not a chat model: this is the vector format of the existing document index. Changing it changes the embedding
  // dimension, so documents indexed with another model would stop matching until they are re-indexed. Override with
  // EMBEDDING_MODEL only together with a re-index; Settings → Models shows whether it is installed.
  embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
  maxFileSize: Number(process.env.MAX_FILE_SIZE_MB || 25) * 1024 * 1024,
  ragTopK: Number(process.env.RAG_TOP_K || 5),
  // How long Ollama keeps a model in memory after a request. Shorter = frees
  // RAM/VRAM sooner when idle (at the cost of a reload on the next request).
  // e.g. '5m' (responsive), '30s' (aggressive), '0' (unload immediately).
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE || '5m',
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  uploadDir: path.join(appDataPath, 'storage', 'uploads'),
  vectorDir: path.join(appDataPath, 'storage', 'lancedb'),
  dbFile: path.join(appDataPath, 'storage', 'db.sqlite'),
  pluginsDir: path.join(appDataPath, 'storage', 'plugins'),
  ocrDir: path.join(appDataPath, 'storage', 'ocr'),
  frontendDist: process.env.FRONTEND_DIST_PATH || path.resolve(root, '..', 'frontend', 'dist'),

  // Translator feature (routes/translate.js, services/translationService.js).
  // The actual translation engine is IndicTrans2, running in a separate
  // local Python microservice (indictrans-service/ at the repo root) —
  // reached over loopback HTTP exactly like Ollama is, never a remote
  // endpoint. Qwen (Ollama) is used only for the OPTIONAL post-processing
  // pass below, never as the translator itself.
  //
  // Earlier in this app's history the translator called Ollama/Qwen
  // directly (no IndicTrans2 involved) — that history is why
  // Earlier the translator used a fixed Qwen tag. It no longer names a model:
  // TRANSLATION_POST_PROCESSING_MODEL / TRANSLATION_FALLBACK_MODEL / DEFAULT_MODEL may pin an installed tag,
  // otherwise the General-route model that is actually installed is used (modelRouter.resolveGeneralModel).
  translate: {
    maxChars: Number(process.env.TRANSLATE_MAX_CHARS || 5000),

    // Where the IndicTrans2 microservice listens. Same loopback-only
    // posture as ollamaUrl (see the OLLAMA_URL check above this object) —
    // this app refuses remote AI endpoints by design.
    serviceUrl: translationUrl,
    // IndicTrans2 inference latency on CPU (the common case for a desktop
    // install) is unproven without a real deployment — 120s is a
    // deliberately generous starting point for a ~5000-char request; the
    // service itself fails predictably (503/504, see translationService.js)
    // rather than hanging indefinitely if this is ever too tight.
    serviceTimeoutMs: Number(process.env.INDICTRANS_TIMEOUT_MS || 120_000),

    // Optional Qwen fluency/terminology polish over IndicTrans2's raw
    // output. OFF by default — must be explicitly enabled, and its
    // failure is always non-fatal (falls back to the unpolished
    // IndicTrans2 output rather than failing the whole request).
    postProcessingEnabled: process.env.TRANSLATION_POST_PROCESSING === 'true',
    postProcessingModel:
      process.env.TRANSLATION_POST_PROCESSING_MODEL || process.env.DEFAULT_MODEL || '',
    postProcessingTimeoutMs: Number(process.env.TRANSLATION_POST_PROCESSING_TIMEOUT_MS || 30_000),
  },

  // Auth abuse protection (middleware/rateLimiter.js). Configurable rather
  // than hardcoded so limits can be tuned without touching application
  // logic — server-side only, never read by the frontend/Electron side.
  rateLimits: {
    // Broad per-IP ceiling shared across register/login/forgot/reset — the
    // "this IP is hammering the auth surface overall" signal, independent
    // of which specific endpoint or account it's currently hitting.
    ipWindowMs: Number(process.env.AUTH_IP_WINDOW_MS || 15 * 60 * 1000),
    ipMaxAttempts: Number(process.env.AUTH_IP_MAX_ATTEMPTS || 30),

    // Login: keyed by ip+username, so hammering one account doesn't lock
    // out every other user on the box. Only failed attempts count — see
    // loginLimiter's skipSuccessfulRequests.
    loginWindowMs: Number(process.env.AUTH_LOGIN_WINDOW_MS || 15 * 60 * 1000),
    loginMaxAttempts: Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS || 10),

    // Forgot-password: also ip+username-keyed (the request body still has
    // a username, unlike reset-password below).
    resetRequestWindowMs: Number(process.env.AUTH_RESET_REQUEST_WINDOW_MS || 15 * 60 * 1000),
    resetRequestMaxAttempts: Number(process.env.AUTH_RESET_REQUEST_MAX_ATTEMPTS || 5),

    // Reset-password (confirm step): ip-only — the request body is
    // {token, newPassword}, no username, by design (Phase 4).
    resetConfirmWindowMs: Number(process.env.AUTH_RESET_CONFIRM_WINDOW_MS || 15 * 60 * 1000),
    resetConfirmMaxAttempts: Number(process.env.AUTH_RESET_CONFIRM_MAX_ATTEMPTS || 10),

    // Registration: ip-only — there's no account to key on yet. A longer
    // window than login since legitimately registering is rarer than
    // logging in.
    registerWindowMs: Number(process.env.AUTH_REGISTER_WINDOW_MS || 60 * 60 * 1000),
    registerMaxAttempts: Number(process.env.AUTH_REGISTER_MAX_ATTEMPTS || 10),

    // Progressive delay on login: once an ip+username pair's failure count
    // (the same counter loginLimiter already tracks — not a second one)
    // exceeds this threshold, each further attempt within the window is
    // delayed before the server even processes it, growing linearly up to
    // a cap. Attempts under the threshold are instant, so a normal person
    // mistyping their password twice never notices this.
    progressiveDelayThreshold: Number(process.env.AUTH_LOGIN_PROGRESSIVE_DELAY_THRESHOLD || 3),
    progressiveDelayStepMs: Number(process.env.AUTH_LOGIN_PROGRESSIVE_DELAY_STEP_MS || 300),
    progressiveDelayMaxMs: Number(process.env.AUTH_LOGIN_PROGRESSIVE_DELAY_MAX_MS || 3000),

    // Translator: keyed per authenticated user (not IP — see
    // middleware/rateLimiter.js), so one busy account can't exhaust another
    // user's budget on this shared desktop app.
    translateWindowMs: Number(process.env.TRANSLATE_WINDOW_MS || 60 * 1000),
    translateMaxRequests: Number(process.env.TRANSLATE_MAX_REQUESTS || 15),
  },
};
