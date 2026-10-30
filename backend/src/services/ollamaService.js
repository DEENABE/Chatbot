import { config } from '../config.js';
import { fetchInference } from './inferenceTransport.js';

// `timeoutMs: null` means no wall-clock deadline: a streamed answer is bounded by its silence watchdog instead.
async function ollamaFetch(path, options = {}) {
  const deadline =
    options.timeoutMs === null ? null : AbortSignal.timeout(options.timeoutMs || 30_000);
  const signals = [options.signal, deadline].filter(Boolean);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const { timeoutMs, ...requestOptions } = options;
  let response;
  try {
    response = await fetchInference(`${config.ollamaUrl}${path}`, {
      ...requestOptions,
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (['MODEL_CONTEXT_TOO_LARGE', 'MODEL_MEMORY_INSUFFICIENT'].includes(error.code)) throw error;
    throw new Error(
      `Cannot reach Ollama at ${config.ollamaUrl}. Is it running? (${error.message})`,
    );
  }
  if (!response.ok) {
    const detail = await response.text();
    throw Object.assign(new Error(`Ollama ${response.status}: ${detail || response.statusText}`), {
      status: response.status,
    });
  }
  return response;
}

export async function listInstalledModels() {
  const response = await ollamaFetch('/api/tags', { method: 'GET' });
  const data = await parseJson(response, 'model discovery');
  return data.models || [];
}

export async function showModel(model) {
  const response = await ollamaFetch('/api/show', {
    method: 'POST',
    body: JSON.stringify({ model }),
    timeoutMs: 8000,
  });
  return parseJson(response, 'model capability discovery');
}

// Models currently loaded in memory (RAM/VRAM).
export async function listLoadedModels({ signal, timeoutMs = 2000 } = {}) {
  try {
    const response = await ollamaFetch('/api/ps', { method: 'GET', signal, timeoutMs });
    const data = await parseJson(response, 'loaded model discovery');
    return data.models || [];
  } catch {
    return [];
  }
}

// Free a model from memory immediately (keep_alive: 0, no generation).
export async function unloadModel(model) {
  await ollamaFetch('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ model, keep_alive: 0 }),
  });
}

// Free every currently-loaded model — call this when the assistant goes idle.
export async function unloadAllModels() {
  const loaded = await listLoadedModels();
  await Promise.all(loaded.map((m) => unloadModel(m.name).catch(() => {})));
  return loaded.map((m) => m.name);
}

export async function embed(texts, { signal } = {}) {
  const input = Array.isArray(texts) ? texts : [texts];
  if (!input.length) return [];
  try {
    const response = await ollamaFetch('/api/embed', {
      method: 'POST',
      signal,
      body: JSON.stringify({ model: config.embeddingModel, input }),
    });
    const data = await parseJson(response, `embedding with ${config.embeddingModel}`);
    if (!Array.isArray(data.embeddings)) {
      throw new Error(
        `Ollama did not return embeddings. Run: ollama pull ${config.embeddingModel}`,
      );
    }
    return validateEmbeddings(data.embeddings, input.length);
  } catch (modernError) {
    if (signal?.aborted || ['AbortError', 'TimeoutError'].includes(modernError?.name))
      throw modernError;
    // Only an older server lacking /api/embed should use the legacy endpoint.
    if (![404, 405, 501].includes(modernError?.status)) throw modernError;
    const embeddings = [];
    for (const prompt of input) {
      const response = await ollamaFetch('/api/embeddings', {
        method: 'POST',
        signal,
        body: JSON.stringify({ model: config.embeddingModel, prompt }),
      });
      const data = await parseJson(response, `embedding with ${config.embeddingModel}`);
      if (!Array.isArray(data.embedding)) {
        throw new Error(
          `Ollama did not return an embedding. Run: ollama pull ${config.embeddingModel}`,
        );
      }
      embeddings.push(data.embedding);
    }
    return validateEmbeddings(embeddings, input.length);
  }
}

export function validateEmbeddings(vectors, count) {
  const dimensions = vectors?.[0]?.length;
  if (
    !Array.isArray(vectors) ||
    vectors.length !== count ||
    !dimensions ||
    vectors.some(
      (v) => !Array.isArray(v) || v.length !== dimensions || v.some((n) => !Number.isFinite(n)),
    )
  )
    throw new Error(
      'Ollama returned invalid or incomplete embeddings. The document remains available for keyword search.',
    );
  return vectors;
}

/**
 * Stops a model stream that has gone silent, never one that is merely slow. The first-output window covers model load
 * and prompt evaluation; once anything arrives, `touch()` re-arms the shorter idle window on every chunk. `signal`
 * aborts with a TimeoutError (code MODEL_STALLED) on silence, or with the caller's own reason if the caller aborts.
 */
function silenceWatchdog(parent, { firstOutputTimeoutMs, idleTimeoutMs }) {
  const controller = new AbortController();
  let timer;
  let started = false;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const waited = Math.round(ms / 1000);
      controller.abort(
        Object.assign(
          new Error(
            started
              ? `The model stopped producing output for ${waited}s and was stopped. Try again, or choose a smaller/faster model in Settings → Models.`
              : `The model did not start answering within ${waited}s and was stopped. It may still have been loading. Try again, or choose a smaller/faster model in Settings → Models.`,
          ),
          { name: 'TimeoutError', code: 'MODEL_STALLED' },
        ),
      );
    }, ms);
    timer.unref?.();
  };
  arm(firstOutputTimeoutMs);
  return {
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    touch() {
      started = true;
      arm(idleTimeoutMs);
    },
    stop: () => clearTimeout(timer),
  };
}

export async function streamChat({
  model,
  messages,
  tools,
  signal,
  onToken,
  onToolCall,
  keepAlive = config.ollamaKeepAlive,
  options = {},
  think,
  firstOutputTimeoutMs = config.modelFirstOutputTimeoutMs,
  idleTimeoutMs = config.modelIdleTimeoutMs,
}) {
  const body = {
    model,
    messages,
    stream: true,
    keep_alive: keepAlive,
    options: { temperature: 0.25, num_ctx: 8192, ...options },
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
  }
  if (think !== undefined) body.think = think;

  const watchdog = silenceWatchdog(signal, { firstOutputTimeoutMs, idleTimeoutMs });
  try {
    return await readChatStream(body, model, watchdog, { onToken, onToolCall });
  } finally {
    watchdog.stop();
  }
}

async function readChatStream(body, model, watchdog, { onToken, onToolCall }) {
  const response = await ollamaFetch('/api/chat', {
    method: 'POST',
    signal: watchdog.signal,
    timeoutMs: null,
    body: JSON.stringify(body),
  });

  if (!response.body) {
    throw new Error('Ollama response body is empty');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let toolCalls = [];
  let metrics = {};
  let completed = false;

  const consume = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(
        `Ollama returned incomplete JSON. Update/restart Ollama and verify the '${model}' model.`,
      );
    }
    if (event.error) throw new Error(event.error);
    if (event.done === true) completed = true;
    if (event.done)
      metrics = Object.fromEntries(
        [
          'total_duration',
          'load_duration',
          'prompt_eval_count',
          'prompt_eval_duration',
          'eval_count',
          'eval_duration',
        ]
          .filter((key) => Number.isFinite(event[key]))
          .map((key) => [key, event[key]]),
      );
    const message = event.message;
    if (message) {
      if (message.content) {
        fullText += message.content;
        onToken?.(message.content);
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          toolCalls.push(call);
          onToolCall?.(call);
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      watchdog.touch();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      if (buffer.length > 1024 * 1024)
        throw new Error('Ollama returned an oversized stream record.');
      for (const line of lines) {
        consume(line);
      }
    }
    buffer += decoder.decode();
    consume(buffer);
    if (!completed)
      throw new Error(
        'Ollama stream ended before completion. The partial response was not saved as a completed answer.',
      );
    return { text: fullText, toolCalls, metrics };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function streamGenerate({
  model,
  prompt,
  images,
  signal,
  onChunk,
  keepAlive = config.ollamaKeepAlive,
  options = {},
  firstOutputTimeoutMs = config.modelFirstOutputTimeoutMs,
  idleTimeoutMs = config.modelIdleTimeoutMs,
}) {
  const watchdog = silenceWatchdog(signal, { firstOutputTimeoutMs, idleTimeoutMs });
  try {
    return await readGenerateStream(
      { model, prompt, images, keepAlive, options },
      watchdog,
      onChunk,
    );
  } finally {
    watchdog.stop();
  }
}

async function readGenerateStream(
  { model, prompt, images, keepAlive, options },
  watchdog,
  onChunk,
) {
  const response = await ollamaFetch('/api/generate', {
    method: 'POST',
    signal: watchdog.signal,
    timeoutMs: null,
    body: JSON.stringify({
      model,
      prompt,
      images,
      stream: true,
      keep_alive: keepAlive,
      options: { temperature: 0.25, num_ctx: 8192, ...options },
    }),
  });

  if (!response.body) {
    throw new Error('Ollama response body is empty');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let completed = false;

  const consume = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(
        `Ollama returned incomplete JSON. Update/restart Ollama and verify the '${model}' model.`,
      );
    }
    if (event.response) {
      fullText += event.response;
      onChunk?.(event.response);
    }
    if (event.done === true) completed = true;
    if (event.error) throw new Error(event.error);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      watchdog.touch();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      if (buffer.length > 1024 * 1024)
        throw new Error('Ollama returned an oversized stream record.');
      for (const line of lines) {
        consume(line);
      }
    }
    buffer += decoder.decode();
    consume(buffer);
    if (!completed) throw new Error('Ollama stream ended before completion.');
    return fullText;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function parseJson(response, operation) {
  const raw = await response.text();
  if (!raw.trim()) {
    throw new Error(
      `Ollama returned an empty response during ${operation}. Restart Ollama and confirm the model is installed.`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Ollama returned invalid JSON during ${operation}. Update or restart Ollama.`);
  }
}
