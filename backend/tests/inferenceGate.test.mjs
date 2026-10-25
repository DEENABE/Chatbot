import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceGate } from '../src/services/inferenceGate.js';
const deferred = () => {
  let resolve;
  return {
    promise: new Promise((done) => {
      resolve = done;
    }),
    resolve: (value) => resolve(value),
  };
};
test('inference admission is serial, bounded and rejects saturation', async () => {
  const gate = new InferenceGate({ maxQueued: 1 }),
    first = deferred(),
    order = [];
  const one = gate.run(async () => {
    order.push(1);
    await first.promise;
    return 1;
  });
  const two = gate.run(async () => {
    order.push(2);
    return 2;
  });
  await assert.rejects(
    gate.run(() => 3),
    { status: 429 },
  );
  assert.deepEqual(gate.status(), { active: 1, queued: 1, maxActive: 1, maxQueued: 1 });
  first.resolve();
  assert.equal(await one, 1);
  assert.equal(await two, 2);
  assert.deepEqual(order, [1, 2]);
});
test('queued cancellation removes a request without executing or releasing active work', async () => {
  const gate = new InferenceGate(),
    first = deferred(),
    controller = new AbortController();
  let ran = false;
  const active = gate.run(() => first.promise);
  const queued = gate.run(
    () => {
      ran = true;
    },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(gate.status().active, 1);
  assert.equal(gate.status().queued, 0);
  assert.equal(ran, false);
  first.resolve();
  await active;
});
test('failure releases admission and queued timeout does not execute', async () => {
  const gate = new InferenceGate({ queueTimeoutMs: 10 }),
    first = deferred();
  const active = gate.run(() => first.promise);
  await assert.rejects(
    gate.run(() => {
      throw new Error('must not execute');
    }),
    { status: 503 },
  );
  first.resolve();
  await active;
  await assert.rejects(
    gate.run(() => {
      throw new Error('fixture failure');
    }),
    /fixture failure/,
  );
  assert.equal(await gate.run(() => 'next'), 'next');
});
