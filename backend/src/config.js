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
  frontendDist: path.resolve(root, '..', 'frontend', 'dist')
};

export const supportedModels = [
  { id: 'llama3', label: 'Llama 3', family: 'Meta' },
  { id: 'mistral', label: 'Mistral', family: 'Mistral AI' },
  { id: 'qwen3', label: 'Qwen 3', family: 'Alibaba' },
  { id: 'qwen2.5', label: 'Qwen 2.5 (agent)', family: 'Alibaba' },
  { id: 'llama3.1', label: 'Llama 3.1', family: 'Meta' },
  // { id: 'gemma3', label: 'Gemma 3', family: 'Google' }
];
