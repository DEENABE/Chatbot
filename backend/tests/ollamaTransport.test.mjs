import test from 'node:test';
import assert from 'node:assert/strict';
import { embed, streamGenerate, streamChat } from '../src/services/ollamaService.js';

test('generate cancellation reaches the local fetch and is not reported as connectivity failure', async () => {
  const original = globalThis.fetch,
    controller = new AbortController();
  controller.abort();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    options.signal.throwIfAborted();
  };
  try {
    await assert.rejects(
      streamGenerate({
        model: 'fixture',
        prompt: 'hi',
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test('embedding cancellation never retries the legacy API', async () => {
  const original = globalThis.fetch,
    controller = new AbortController();
  controller.abort();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    options.signal.throwIfAborted();
  };
  try {
    await assert.rejects(embed(['fixture'], { signal: controller.signal }), {
      name: 'AbortError',
    });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test('chat sends route context and keepAlive options with streaming output', async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response('{"message":{"content":"local"}}\n{"done":true}\n');
  };
  try {
    const result = await streamChat({
      model: 'fixture',
      messages: [{ role: 'user', content: 'fixture' }],
      keepAlive: '0',
      options: { num_ctx: 4096 },
    });
    assert.equal(result.text, 'local');
    assert.equal(sent.keep_alive, '0');
    assert.equal(sent.options.num_ctx, 4096);
    assert.equal(Object.hasOwn(sent, 'tools'), false);
  } finally {
    globalThis.fetch = original;
  }
});
