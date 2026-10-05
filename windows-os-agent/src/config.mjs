import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function number(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
export function configuration() {
  const token = process.env.AGENT_TOKEN;
  if (!token || token.length < 32 || token.startsWith('replace-')) throw new Error('Set AGENT_TOKEN to a random secret of at least 32 characters. Run npm run token.');
  const url = new URL(process.env.OLLAMA_URL || 'http://127.0.0.1:11434');
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('OLLAMA_URL must be a loopback HTTP origin');
  return { token, port: number('PORT', 47831, 1024, 65535), ollamaUrl: url.origin, model: process.env.OLLAMA_MODEL || 'qwen3.5:9b', think: process.env.OLLAMA_THINK === 'true', autoLow: process.env.AUTO_APPLY_LOW_RISK !== 'false', uia: process.env.ENABLE_UIA === 'true', maxSteps: number('MAX_STEPS', 12, 1, 30), ollamaTimeout: number('OLLAMA_TIMEOUT_MS', 120000, 1000, 300000), toolTimeout: number('TOOL_TIMEOUT_MS', 30000, 1000, 300000) };
}
