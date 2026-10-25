import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModelRoute, resolveGeneralModel } from './modelRouter.js';
import { getCachedHardwareProfile } from './gpuProfile.js';
const GiB = 1024 ** 3;
const small = {
  id: 'small:3b',
  family: 'qwen',
  size: 2 * GiB,
  contextWindow: 32768,
  capabilities: ['completion', 'tools'],
};
const large = {
  id: 'large:9b',
  family: 'phi',
  size: 6 * GiB,
  contextWindow: 32768,
  capabilities: ['completion', 'tools'],
};
const models = [large, small];
function hardware(total = 8, free = 6, gpus = [], residency = []) {
  return getCachedHardwareProfile({
    totalMemory: total * GiB,
    freeMemory: free * GiB,
    adapters: gpus,
    residency,
    env: {},
    platform: 'win32',
    parallelism: 4,
    cpus: Array.from({ length: 4 }, () => ({ model: 'Fixture CPU' })),
  });
}
const gpu = (vramMiB) => ({
  name: 'Fixture GPU',
  vendor: 'nvidia',
  vramMiB,
  memoryVerified: true,
  integrated: false,
});
test('CPU-only 8 GB laptop picks a smaller capable local model and a CPU-safe context', () => {
  const route = selectModelRoute({
    models,
    hardware: hardware(),
    computerRequest: {},
    agentId: 'windows-repair',
    preferences: { contextWindow: 32768 },
  });
  assert.equal(route.model, small.id);
  assert.equal(route.options.num_ctx, 2048);
  assert.equal(route.options.num_gpu, undefined);
  assert.equal(route.selection, 'auto-hardware');
});
test('the same saved model preference adapts on a smaller laptop rather than forcing an oversized model', () => {
  const route = selectModelRoute({
    models,
    hardware: hardware(),
    computerRequest: {},
    preferences: { windowsModel: large.id, contextWindow: 32768 },
  });
  assert.equal(route.model, small.id);
  assert.equal(route.fallback, true);
  assert.match(route.reason, /available memory estimate/);
});
test('a 6 GB GPU prefers an estimated GPU-fitting model over a larger family recommendation', () => {
  const route = selectModelRoute({
    models,
    hardware: hardware(24, 16, [gpu(6144)]),
    computerRequest: {},
    agentId: 'windows-repair',
  });
  assert.equal(route.model, small.id);
  assert.equal(route.options.num_ctx, 8192);
  assert.equal(route.inference.accelerationVerified, false);
});
test('a larger GPU can choose the recommended larger model within that host resource budget', () => {
  const route = selectModelRoute({
    models,
    hardware: hardware(24, 16, [gpu(12288)]),
    computerRequest: {},
    agentId: 'windows-repair',
    preferences: { contextWindow: 32768 },
  });
  assert.equal(route.model, large.id);
  assert.equal(route.options.num_ctx, 32768);
});
test('unverified Intel/AMD adapters do not make CPU-safe laptops prefer an oversized model', () => {
  const route = selectModelRoute({
    models,
    hardware: hardware(16, 10, [
      { name: 'Intel Graphics', vendor: 'intel', vramMiB: 16384, memoryVerified: false },
    ]),
    agentId: 'windows-repair',
  });
  assert.equal(route.model, small.id);
  assert.equal(route.options.num_ctx, 4096);
});
test('no fitting installed tool model produces an actionable capacity error and no inference', () => {
  assert.throws(
    () => selectModelRoute({ models: [large], hardware: hardware(), computerRequest: {} }),
    (error) => error.status === 503 && /smaller local model/.test(error.message),
  );
});
test('translation background model selection also adapts an oversized configured tag', async () => {
  assert.equal(
    await resolveGeneralModel({
      configured: large.id,
      discover: async () => models,
      hardware: hardware(),
    }),
    small.id,
  );
});
