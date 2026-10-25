import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.APP_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-reliability-'));
const { streamChat } = await import('./ollamaService.js');
const { modelRuntime } = await import('./modelRuntime.js');
const { getCachedHardwareProfile } = await import('./gpuProfile.js');
const { nextDesktopTool } = await import('../ai/desktopChat.js');
const testHardware = getCachedHardwareProfile({
  totalMemory: 64 * 1024 ** 3,
  freeMemory: 32 * 1024 ** 3,
  adapters: [{ name: 'Test GPU', vramMiB: 8192, memoryVerified: true }],
  env: {},
  residency: [],
});

test('default stream deadlines allow delayed local output and preserve a final unterminated record', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    await new Promise((resolve) => setTimeout(resolve, 30));
    options.signal.throwIfAborted();
    return new Response('{"message":{"content":"ok"}}\n{"done":true}');
  };
  try {
    assert.equal((await streamChat({ model: 'fixture', messages: [] })).text, 'ok');
  } finally {
    globalThis.fetch = original;
  }
});
test('an interrupted model stream is never reported as a completed response', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"message":{"content":"partial"}}\n');
  try {
    await assert.rejects(streamChat({ model: 'fixture', messages: [] }), /ended before completion/);
  } finally {
    globalThis.fetch = original;
  }
});
test('desktop decisions honor reasoning preference while retaining fixed tool validation', async () => {
  for (const thinking of [true, false]) {
    let sent;
    const result = await modelRuntime.run(
      {
        model: 'fixture',
        capabilities: ['completion', 'tools', 'thinking'],
        thinking,
        options: { num_ctx: 8192 },
        hardware: testHardware,
      },
      () =>
        nextDesktopTool({
          prompt: '{}',
          snapshot: {},
          fetchImpl: async (_url, options) => {
            assert.equal(options.redirect, 'error');
            sent = JSON.parse(options.body);
            return Response.json({
              message: {
                tool_calls: [
                  { function: { name: 'desktop_action', arguments: { action: 'observe' } } },
                ],
              },
            });
          },
        }),
    );
    assert.equal(sent.think, thinking);
    assert.equal(sent.options.num_predict, thinking ? 2048 : 512);
    assert.deepEqual(result, { kind: 'observe', primitive: true });
  }
});
