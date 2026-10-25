/**
 * @module ai/llmClient
 * @description Thin wrapper around the local Ollama server for structured
 * (JSON) completions. Used by the planning/classification layer of the
 * enterprise repair engine.
 */

import { config } from '../config.js';
import { memoryManager, memoryScope } from '../memory/runtime.js';
import { MEMORY_GUIDANCE } from '../memory/MemoryRetriever.js';
import { modelRuntime, routedModelOr } from '../services/modelRuntime.js';
import { fetchInference } from '../services/inferenceTransport.js';

// No built-in tag: planner/classifier calls follow the model this request was routed to. AGENT_MODEL may pin one.
export const DEFAULT_MODEL = process.env.AGENT_MODEL || '';

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
export async function completeJSON({
  system,
  prompt,
  // A call that names no model follows the model this request was routed to.
  model = routedModelOr(DEFAULT_MODEL),
  temperature = 0.1,
  signal,
  think,
  numCtx = 8192,
  numPredict,
  keepAlive = config.ollamaKeepAlive,
}) {
  model = model || routedModelOr(DEFAULT_MODEL);
  if (!model)
    throw new Error(
      'No local model is selected. Install a model in Ollama and choose it in Settings → Models.',
    );
  const timeout = AbortSignal.timeout(240_000);
  signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const scope = memoryScope.getStore();
  const routing = modelRuntime.getStore();
  const reasoning =
    think ?? (routing?.capabilities?.includes('thinking') ? routing.thinking !== false : undefined);
  if (scope?.userId) {
    const memory = memoryManager.retriever.retrieve({
      ...scope,
      message: prompt,
    });
    system += '\n' + MEMORY_GUIDANCE;
    prompt = memory.text + '\n\nCURRENT REQUEST AND RUNTIME EVIDENCE\n' + prompt;
  }
  let response;
  try {
    response = await fetchInference(`${config.ollamaUrl}/api/generate`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        system,
        prompt,
        format: 'json',
        stream: false,
        keep_alive: modelRuntime.getStore()?.keepAlive ?? keepAlive,
        // Callers that only need a decision can switch reasoning off: same answers here, far lower latency on CPU.
        ...(reasoning === undefined ? {} : { think: reasoning }),
        options: {
          temperature,
          num_ctx: Math.min(numCtx, modelRuntime.getStore()?.options?.num_ctx ?? numCtx),
          ...(numPredict === undefined ? {} : { num_predict: numPredict }),
        },
      }),
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (['MODEL_CONTEXT_TOO_LARGE', 'MODEL_MEMORY_INSUFFICIENT'].includes(error.code)) throw error;
    throw new Error(
      `Cannot reach Ollama at ${config.ollamaUrl}. Is it running? (${error.message})`,
    );
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
