import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const ollamaHost = new URL(ollamaUrl).hostname;
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(ollamaHost)) {
  throw new Error('OLLAMA_URL must point to localhost. Chanakya AI refuses remote AI endpoints.');
}

const appDataPath = process.env.APP_DATA_PATH || root;

export const config = {
  port: Number(process.env.PORT || 3001),
  // Loopback only — the README already claimed this, but app.listen() never
  // actually passed a host, so Node defaulted to 0.0.0.0 (every interface).
  // Anyone else on the same network could reach the agent/repair PowerShell
  // routes; this closes that off.
  host: process.env.HOST || '127.0.0.1',
  ollamaUrl,
  defaultModel: process.env.DEFAULT_MODEL || 'llama3',
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
  frontendDist: path.resolve(root, '..', 'frontend', 'dist'),

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
    progressiveDelayMaxMs: Number(process.env.AUTH_LOGIN_PROGRESSIVE_DELAY_MAX_MS || 3000)
  }
};

export const supportedModels = [
  { id: 'llama3', label: 'Llama 3', family: 'Meta' },
  { id: 'mistral', label: 'Mistral', family: 'Mistral AI' },
  { id: 'qwen3', label: 'Qwen 3', family: 'Alibaba' },
  { id: 'qwen2.5', label: 'Qwen 2.5 (agent)', family: 'Alibaba' },
  { id: 'llama3.1', label: 'Llama 3.1', family: 'Meta' },
  // { id: 'gemma3', label: 'Gemma 3', family: 'Google' }
];
