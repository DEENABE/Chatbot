/** Decode every record, including a final record without a newline, and always release the stream. */
export async function readNdjson(response, onEvent, { signal } = {}) {
  if (!response.body) throw new Error('The local server returned an empty response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(
        'The local server returned an incomplete stream. Restart the backend and try again.',
      );
    }
    onEvent(event);
  };
  const abort = () => {
    reader.cancel(signal.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      if (buffer.length > 4 * 1024 * 1024)
        throw new Error('The response stream exceeded the record size limit.');
      for (const line of lines) consume(line);
    }
    consume(buffer + decoder.decode());
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
