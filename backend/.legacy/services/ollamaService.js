import { config } from '../config.js';

async function ollamaFetch(path, options = {}) {
  let response;
  try {
    response = await fetch(`${config.ollamaUrl}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
  } catch (error) {
    throw new Error(`Cannot reach Ollama at ${config.ollamaUrl}. Is it running? (${error.message})`);
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

export async function embed(texts) {
  const input = Array.isArray(texts) ? texts : [texts];
  try {
    const response = await ollamaFetch('/api/embed', {
      method: 'POST',
      body: JSON.stringify({ model: config.embeddingModel, input })
    });
    const data = await parseJson(response, `embedding with ${config.embeddingModel}`);
    if (!Array.isArray(data.embeddings)) {
      throw new Error(`Ollama did not return embeddings. Run: ollama pull ${config.embeddingModel}`);
    }
    return data.embeddings;
  } catch (modernError) {
    const embeddings = [];
    for (const prompt of input) {
      const response = await ollamaFetch('/api/embeddings', {
        method: 'POST',
        body: JSON.stringify({ model: config.embeddingModel, prompt })
      });
      const data = await parseJson(response, `embedding with ${config.embeddingModel}`);
      if (!Array.isArray(data.embedding)) {
        throw new Error(`Ollama did not return an embedding. Run: ollama pull ${config.embeddingModel}`);
      }
      embeddings.push(data.embedding);
    }
    return embeddings;
  }
}

export async function streamGenerate({ model, prompt, images, signal, onChunk }) {
  const response = await ollamaFetch('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ model, prompt, images, stream: true, options: { temperature: 0.25, num_ctx: 8192 } })
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
      throw new Error(`Ollama returned incomplete JSON. Update/restart Ollama and verify the '${model}' model.`);
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
    throw new Error(`Ollama returned an empty response during ${operation}. Restart Ollama and confirm the model is installed.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Ollama returned invalid JSON during ${operation}. Update or restart Ollama.`);
  }
}
