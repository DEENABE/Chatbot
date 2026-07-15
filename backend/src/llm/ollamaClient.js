import { config } from '../config/index.js';

/**
 * Generates an embedding vector for a piece of text using the local
 * embedding model (e.g. nomic-embed-text). Used both at ingest time
 * and at query time - same model must be used for both, or the
 * vector search will be meaningless.
 */
export async function embedText(text) {
  const res = await fetch(`${config.ollamaHost}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.embedModel, prompt: text })
  });

  if (!res.ok) {
    throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.embedding;
}

/**
 * Non-streaming chat completion. Returns the full response plus
 * real token usage counts reported by Ollama.
 */
export async function chatCompletion(messages, model = config.chatModel) {
  const res = await fetch(`${config.ollamaHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false })
  });

  if (!res.ok) {
    throw new Error(`Chat request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return {
    content: data.message?.content ?? '',
    promptTokens: data.prompt_eval_count ?? 0,
    completionTokens: data.eval_count ?? 0,
    totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0)
  };
}

/**
 * Streaming chat completion. Calls onToken(text) for each incoming
 * chunk, and returns final usage counts once the stream ends.
 */
export async function chatCompletionStream(messages, onToken, model = config.chatModel) {
  const res = await fetch(`${config.ollamaHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true })
  });

  if (!res.ok || !res.body) {
    throw new Error(`Chat stream failed: ${res.status} ${await res.text()}`);
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let buffer = '';

  for await (const chunk of res.body) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line for next iteration

    for (const line of lines.filter(Boolean)) {
      const json = JSON.parse(line);
      if (json.message?.content) onToken(json.message.content);
      if (json.done) {
        promptTokens = json.prompt_eval_count ?? 0;
        completionTokens = json.eval_count ?? 0;
      }
    }
  }

  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}
