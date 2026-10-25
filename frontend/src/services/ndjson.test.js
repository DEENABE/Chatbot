import test from 'node:test';
import assert from 'node:assert/strict';
import { readNdjson } from './ndjson.js';

test('NDJSON preserves split UTF-8, tool calls and a final done record without a newline', async () => {
  const bytes = new TextEncoder().encode(
    '{"type":"token","text":"வணக்கம்"}\n{"type":"tool_call","id":"call"}\n{"type":"done"}',
  );
  const events = [];
  await readNdjson(
    new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
          controller.close();
        },
      }),
    ),
    (event) => events.push(event),
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ['token', 'tool_call', 'done'],
  );
  assert.equal(events[0].text, 'வணக்கம்');
});
test('malformed final records fail visibly, cancel the source and release the reader', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{bad}\n'));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    readNdjson(response, () => {}),
    /incomplete stream/,
  );
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});
test('stream cancellation interrupts a stalled read', async () => {
  const controller = new AbortController();
  const response = new Response(new ReadableStream());
  const pending = readNdjson(response, () => {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(response.body.locked, false);
});
