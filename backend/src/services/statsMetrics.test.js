import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuUsageBetween, createStatsReader } from './statsMetrics.js';

test('CPU sampling uses actual deltas and treats missing/reset counters as unavailable', () => {
  assert.equal(
    cpuUsageBetween([{ times: { idle: 100, user: 100 } }], [{ times: { idle: 130, user: 170 } }]),
    70,
  );
  assert.equal(cpuUsageBetween([], []), null);
  assert.equal(
    cpuUsageBetween([{ times: { idle: 100, user: 100 } }], [{ times: { idle: 1, user: 1 } }]),
    null,
  );
});

const reader = (filesystem) => {
  let calls = 0;
  return createStatsReader({
    system: {
      cpus: () => [{ times: calls++ ? { idle: 130, user: 170 } : { idle: 100, user: 100 } }],
      totalmem: () => 8 * 1024 ** 3,
      freemem: () => 2 * 1024 ** 3,
    },
    filesystem,
    hardware: () => ({
      adapterDetected: true,
      gpus: [{ name: 'Fixture GPU', vramMiB: 6144 }],
      acceleration: { mode: 'mixed', verified: true, source: 'ollama' },
    }),
    directory: () => process.cwd(),
    memoryUsage: () => ({ heapUsed: 20 * 1024 ** 2 }),
  });
};
test('stats report actual memory/disk values and never invent GPU load from an adapter or residency', async () => {
  const result = await reader({ statfs: async () => ({ blocks: 100, bfree: 30 }) })();
  assert.equal(result.cpu, 70);
  assert.equal(result.ram, 75);
  assert.equal(result.disk, 70);
  assert.equal(result.backendMemoryBytes, 20 * 1024 ** 2);
  assert.equal(result.electronMemory, 20);
  assert.equal(result.gpu, null);
  assert.equal(result.temperature, null);
  assert.equal(result.acceleration.mode, 'mixed');
  assert.equal(result.metricStatus.gpu, 'unavailable');
});
test('failed disk probes return unavailable instead of a fabricated default', async () => {
  const result = await reader({
    statfs: async () => {
      throw new Error('Sensor unavailable');
    },
  })();
  assert.equal(result.disk, null);
  assert.equal(result.metricStatus.disk, 'unavailable');
});
