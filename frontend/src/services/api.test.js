import test from 'node:test';
import assert from 'node:assert/strict';
const key = 'c'.repeat(64);
globalThis.window = {
  location: { protocol: 'file:' },
  electronAPI: {
    getApiBaseUrl: () => 'http://127.0.0.1:34567/api',
    getApiClientKey: () => key,
  },
};
const { streamChat, streamRepair, setSession } = await import('./api.js');
await setSession('fixture-session');
test('desktop chat carries its independent client key and accepts a final done event without a newline', async () => {
  const original = globalThis.fetch;
  let done = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:34567/api/chat');
    assert.equal(options.headers['X-Chanakya-Client'], key);
    assert.equal(options.headers.Authorization, 'Bearer fixture-session');
    return new Response(
      '{"type":"token","text":"ok"}\n{"type":"done","conversationId":"test","message":null}',
    );
  };
  try {
    await streamChat(
      { message: 'hello' },
      {
        onToken: () => {},
        onSources: () => {},
        onDone: () => {
          done = true;
        },
      },
    );
    assert.equal(done, true);
  } finally {
    globalThis.fetch = original;
  }
});
test('diagnostic transport rejects missing final results instead of silently succeeding', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers['X-Chanakya-Client'], key);
    return new Response('{"type":"diagnosis","payload":{}}\n');
  };
  try {
    await assert.rejects(
      streamRepair({ goal: 'fix wifi' }, { onEvent: () => {} }),
      /before a final result/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
