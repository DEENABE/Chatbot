import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A real loopback server stands in for Ollama so aborting a streamed body is exercised for real.
let server;
let streamChat;
let behaviour = async () => {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  server = http.createServer(async (request, response) => {
    request.resume();
    await behaviour(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
  ({ streamChat } = await import('../src/services/ollamaService.js'));
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const token = (text) => JSON.stringify({ message: { content: text } }) + '\n';
const ask = (extra = {}) =>
  streamChat({
    model: 'fixture',
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  });

test('a slow model that keeps producing tokens is never stopped, however long it takes overall', async () => {
  behaviour = async (response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (let i = 0; i < 8; i++) {
      response.write(token(`t${i} `));
      await sleep(100);
    }
    response.end(JSON.stringify({ done: true }) + '\n');
  };
  const seen = [];
  const started = Date.now();
  // 8 tokens take ~800ms in total, far beyond the 300ms idle window, but no gap is longer than ~100ms.
  const result = await ask({
    idleTimeoutMs: 300,
    firstOutputTimeoutMs: 300,
    onToken: (text) => seen.push(text),
  });
  assert.ok(Date.now() - started > 700);
  assert.equal(seen.length, 8);
  assert.equal(result.text, 't0 t1 t2 t3 t4 t5 t6 t7 ');
});

test('a model that waits long before its first token (load + prompt evaluation) is allowed that time', async () => {
  behaviour = async (response) => {
    await sleep(400);
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(token('late'));
    response.end(JSON.stringify({ done: true }) + '\n');
  };
  // The idle window (150ms) is shorter than the wait; only the first-output window (2s) applies before output.
  const result = await ask({ idleTimeoutMs: 150, firstOutputTimeoutMs: 2000 });
  assert.equal(result.text, 'late');
});

test('silence before the first token stops the request with a clear message', async () => {
  behaviour = async (response) => {
    await sleep(2000);
    response.destroy();
  };
  await assert.rejects(ask({ idleTimeoutMs: 200, firstOutputTimeoutMs: 200 }), (error) => {
    assert.equal(error.name, 'TimeoutError');
    assert.equal(error.code, 'MODEL_STALLED');
    assert.match(error.message, /did not start answering/);
    return true;
  });
});

test('a stall in the middle of an answer stops it, keeping what was already streamed', async () => {
  behaviour = async (response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(token('partial '));
    await sleep(2000);
    response.destroy();
  };
  const seen = [];
  await assert.rejects(
    ask({ idleTimeoutMs: 200, firstOutputTimeoutMs: 5000, onToken: (text) => seen.push(text) }),
    (error) => {
      assert.equal(error.code, 'MODEL_STALLED');
      assert.match(error.message, /stopped producing output/);
      return true;
    },
  );
  assert.deepEqual(seen, ['partial ']);
});

test('the user stopping the answer is an abort, not a timeout', async () => {
  behaviour = async (response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(token('a'));
    await sleep(2000);
    response.destroy();
  };
  const controller = new AbortController();
  const pending = ask({
    signal: controller.signal,
    idleTimeoutMs: 5000,
    firstOutputTimeoutMs: 5000,
    onToken: () => controller.abort(),
  });
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.notEqual(error.code, 'MODEL_STALLED');
    return true;
  });
});
