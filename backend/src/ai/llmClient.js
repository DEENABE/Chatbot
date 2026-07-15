/**
 * @module ai/llmClient
 * @description Thin wrapper around the local Ollama server for structured
 * (JSON) completions. Used by the planning/classification layer of the
 * enterprise repair engine.
 */

import { config } from '../config.js';

export const DEFAULT_MODEL = process.env.AGENT_MODEL || 'qwen3';

/**
 * Ask the model for a single JSON object.
 *
 * @param {Object} args
 * @param {string} args.system - System prompt.
 * @param {string} args.prompt - User prompt.
 * @param {string} [args.model]
 * @param {number} [args.temperature]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<Object>} Parsed JSON object (best-effort).
 */
export async function completeJSON({ system, prompt, model = DEFAULT_MODEL, temperature = 0.1, signal }) {
  let response;
  try {
    response = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        system,
        prompt,
        format: 'json',
        stream: false,
        keep_alive: config.ollamaKeepAlive,
        options: { temperature, num_ctx: 8192 }
      })
    });
  } catch (error) {
    throw new Error(`Cannot reach Ollama at ${config.ollamaUrl}. Is it running? (${error.message})`);
  }

  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 404) {
      throw new Error(`Model '${model}' not found. Run: ollama pull ${model}`);
    }
    throw new Error(`Ollama ${response.status}: ${detail || response.statusText}`);
  }

  const data = await response.json();
  const raw = (data.response || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Model returned non-JSON output: ${raw.slice(0, 200)}`);
  }
}
