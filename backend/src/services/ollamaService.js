import { config } from '../config.js';

async function ollamaFetch(path, options = {}) {
  const deadline = AbortSignal.timeout(options.timeoutMs || 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const { timeoutMs, ...requestOptions } = options;
  let response;
  try {
    response = await fetch(`${config.ollamaUrl}${path}`, {
      ...requestOptions,
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(
      `Cannot reach Ollama at ${config.ollamaUrl}. Is it running? (${error.message})`,
    );
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Ollama ${response.status}: ${detail || response.statusText}`);
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
export async function listLoadedModels() {
  try {
    const response = await ollamaFetch('/api/ps', { method: 'GET' });
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
    return data.embeddings;
  } catch (modernError) {
    if (signal?.aborted || ['AbortError', 'TimeoutError'].includes(modernError?.name))
      throw modernError;
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
    return embeddings;
  }
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

  const response = await ollamaFetch('/api/chat', {
    method: 'POST',
    signal,
    timeoutMs: 600_000,
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      consume(line);
    }
  }
  consume(buffer);
  return { text: fullText, toolCalls, metrics };
}

export async function streamGenerate({
  model,
  prompt,
  images,
  signal,
  onChunk,
  keepAlive = config.ollamaKeepAlive,
  options = {},
}) {
  const response = await ollamaFetch('/api/generate', {
    method: 'POST',
    signal,
    timeoutMs: 600_000,
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
      onChunk(event.response);
    }
    if (event.error) throw new Error(event.error);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      consume(line);
    }
  }
  consume(buffer);
  return fullText;
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
