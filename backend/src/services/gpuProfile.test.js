import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextCapForVram,
  parseNvidiaSmi,
  parseWindowsAdapters,
  getHardwareProfile,
  getCachedHardwareProfile,
  getGpuProfile,
  inferencePlanForHardware,
  accelerationForResidency,
  observeResidency,
} from './gpuProfile.js';
const GiB = 1024 ** 3;
const host = {
  totalMemory: 16 * GiB,
  freeMemory: 10 * GiB,
  cpus: Array.from({ length: 8 }, () => ({ model: 'Fixture CPU' })),
  parallelism: 8,
};
const noGpu = async () => ({ status: 1, stdout: '' });
const nvidia = async (file) => ({
  status: file === 'nvidia-smi' ? 0 : 1,
  stdout: file === 'nvidia-smi' ? 'RTX 3050, 6144\n' : '',
});

test('VRAM context hints cover small and large cards and never grant unlimited no-GPU context', () => {
  assert.equal(contextCapForVram(2048), 2048);
  assert.equal(contextCapForVram(4096), 4096);
  assert.equal(contextCapForVram(6144), 8192);
  assert.equal(contextCapForVram(8192), 16384);
  assert.equal(contextCapForVram(12288), 32768);
  assert.equal(contextCapForVram(0), 4096);
});

test('parses nvidia-smi csv output', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3050 6GB Laptop GPU, 6144\n'), {
    name: 'NVIDIA GeForce RTX 3050 6GB Laptop GPU',
    vramMiB: 6144,
  });
  assert.equal(parseNvidiaSmi(''), null);
  assert.equal(parseNvidiaSmi('GPU, N/A'), null);
  assert.equal(parseNvidiaSmi('GPU, -1'), null);
  assert.equal(parseNvidiaSmi('GPU, 6144garbage'), null);
  assert.deepEqual(parseNvidiaSmi('NVIDIA, Fixture GPU, 6144'), {
    name: 'NVIDIA, Fixture GPU',
    vramMiB: 6144,
  });
});

test('detects NVIDIA asynchronously but never claims adapter presence proves GPU inference', async () => {
  const profile = await getHardwareProfile({
    run: nvidia,
    env: {},
    platform: 'win32',
    ...host,
    residency: [],
  });
  assert.equal(profile.adapterDetected, true);
  assert.equal(profile.gpus[0].vramMiB, 6144);
  assert.deepEqual(profile.acceleration, {
    mode: 'unknown',
    verified: false,
    source: 'unverified',
  });
  const plan = inferencePlanForHardware(profile, { contextWindow: 32768, modelSizeBytes: 3 * GiB });
  assert.equal(plan.options.num_ctx, 8192);
  assert.equal(plan.options.num_gpu, undefined);
  assert.equal(plan.options.num_thread, 6);
  assert.equal(plan.mode, 'unknown');
});

test('missing drivers, AMD and Intel inventory use a safe CPU plan instead of assuming CUDA support', async () => {
  const adapters = JSON.stringify([
    { Name: 'AMD Radeon RX 7800 XT', AdapterRAM: 4 * GiB },
    { Name: 'Intel Iris Xe Graphics', AdapterRAM: GiB },
  ]);
  const run = async (file, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 4000);
    return { status: file === 'nvidia-smi' ? 1 : 0, stdout: file === 'nvidia-smi' ? '' : adapters };
  };
  const profile = await getHardwareProfile({
    run,
    env: {},
    platform: 'win32',
    ...host,
    residency: [],
  });
  assert.deepEqual(
    profile.gpus.map((gpu) => gpu.vendor),
    ['amd', 'intel'],
  );
  assert.equal(profile.gpus[1].integrated, true);
  assert.equal(profile.gpus[0].memoryVerified, false);
  assert.equal(inferencePlanForHardware(profile, { contextWindow: 32768 }).options.num_ctx, 4096);
  assert.equal(profile.acceleration.verified, false);
  assert.deepEqual(parseWindowsAdapters('{bad'), []);
  assert.deepEqual(parseWindowsAdapters('{"Name":"Microsoft Basic Display Adapter"}'), []);
});

test('automatic CPU context and model budget scale with actual RAM and leave OS headroom', async () => {
  for (const [total, free, expected] of [
    [8, 5, 2048],
    [16, 10, 4096],
    [32, 20, 8192],
    [64, 40, 16384],
  ]) {
    const profile = await getHardwareProfile({
      run: noGpu,
      env: {},
      platform: 'linux',
      ...host,
      totalMemory: total * GiB,
      freeMemory: free * GiB,
      residency: [],
    });
    const plan = inferencePlanForHardware(profile, { contextWindow: 32768 });
    assert.equal(plan.options.num_ctx, expected);
    assert.equal(plan.options.num_batch, 128);
    assert.ok(plan.modelBudgetBytes < free * GiB);
    assert.equal(plan.options.num_gpu, undefined);
  }
});

test('a heavy model on a small GPU and observed CPU placement keep CPU-safe context', async () => {
  const profile = await getHardwareProfile({
    run: nvidia,
    env: {},
    platform: 'win32',
    ...host,
    residency: [],
  });
  assert.equal(
    inferencePlanForHardware(profile, { contextWindow: 32768, modelSizeBytes: 8 * GiB }).options
      .num_ctx,
    4096,
  );
  const cpu = await getHardwareProfile({
    run: nvidia,
    env: {},
    platform: 'win32',
    ...host,
    residency: [{ name: 'fixture', size: 3 * GiB, size_vram: 0 }],
  });
  const plan = inferencePlanForHardware(cpu, {
    contextWindow: 32768,
    modelSizeBytes: 3 * GiB,
    modelId: 'fixture',
  });
  assert.equal(plan.mode, 'cpu');
  assert.equal(plan.options.num_ctx, 4096);
});

test('Ollama residency distinguishes CPU, GPU, mixed and missing evidence accurately', () => {
  const model = { name: 'fixture', size: 4 * GiB };
  assert.deepEqual(accelerationForResidency([]), {
    mode: 'unknown',
    verified: false,
    source: 'unverified',
  });
  assert.equal(accelerationForResidency([{ ...model, size_vram: 0 }]).mode, 'cpu');
  assert.equal(accelerationForResidency([{ ...model, size_vram: 4 * GiB }]).mode, 'gpu');
  assert.equal(accelerationForResidency([{ ...model, size_vram: 2 * GiB }]).mode, 'mixed');
  assert.equal(accelerationForResidency([{ ...model, size_vram: null }]).verified, false);
  assert.equal(accelerationForResidency([{ ...model }]).verified, false);
});

test('actual GPU residency provides a budget when adapter VRAM cannot be probed', async () => {
  const profile = await getHardwareProfile({
    run: noGpu,
    env: {},
    platform: 'linux',
    ...host,
    totalMemory: 8 * GiB,
    freeMemory: 2 * GiB,
    residency: [
      { name: 'gpu-loaded:latest', size: 5 * GiB, size_vram: 5 * GiB, context_length: 4096 },
    ],
  });
  const plan = inferencePlanForHardware(profile, {
    modelId: 'gpu-loaded',
    modelSizeBytes: 4.5 * GiB,
    contextWindow: 8192,
  });
  assert.equal(profile.adapterDetected, false);
  assert.equal(plan.mode, 'gpu');
  assert.equal(plan.accelerationVerified, true);
  assert.equal(plan.gpuModelBudgetBytes, 5 * GiB);
  assert.equal(plan.modelFitsEstimate, true);
  assert.equal(plan.contextWindow, 4096);
});

test('GPU_PROFILE=off and manual context cap only reduce host limits, never force huge CPU context', async () => {
  let calls = 0;
  const run = async () => {
    calls++;
    return { status: 0, stdout: 'RTX 3050, 6144' };
  };
  const disabled = await getHardwareProfile({
    run,
    env: { GPU_PROFILE: 'off' },
    platform: 'win32',
    ...host,
    residency: [],
  });
  assert.equal(calls, 0);
  assert.equal(disabled.maxContext, 4096);
  const profile = await getHardwareProfile({
    run,
    env: { GPU_MAX_CONTEXT: '2048' },
    platform: 'linux',
    ...host,
    residency: [],
  });
  assert.equal(profile.maxContext, 2048);
  const larger = await getHardwareProfile({
    run: noGpu,
    env: { GPU_MAX_CONTEXT: '32768' },
    platform: 'linux',
    ...host,
    residency: [],
  });
  assert.equal(larger.maxContext, 4096);
});

test('CPU fallback has no GPU assumptions and required context cannot silently disappear', async () => {
  const profile = await getHardwareProfile({
    run: nvidia,
    env: {},
    platform: 'linux',
    ...host,
    residency: [],
  });
  const fallback = {
    ...profile,
    gpus: [],
    adapterDetected: false,
    detectionDisabled: true,
    acceleration: { mode: 'cpu', verified: true, source: 'runtime-fallback' },
    residency: [],
  };
  const plan = inferencePlanForHardware(fallback, {
    contextWindow: 8192,
    modelSizeBytes: 3 * GiB,
    requiredContext: 6000,
    modelId: 'fixture',
  });
  assert.equal(plan.options.num_ctx, 4096);
  assert.equal(plan.mode, 'cpu');
  assert.equal(plan.fitsRequiredContext, false);
});

test('resident model RAM can be reclaimed without treating weight disk size as VRAM', async () => {
  const profile = await getHardwareProfile({
    run: noGpu,
    env: {},
    platform: 'linux',
    ...host,
    freeMemory: 2 * GiB,
    residency: [{ name: 'loaded', size: 5 * GiB, size_vram: GiB }],
  });
  assert.ok(profile.memory.usableModelBytes > 4 * GiB);
  assert.equal(
    inferencePlanForHardware(profile, { modelSizeBytes: 100 * GiB }).modelFitsEstimate,
    false,
  );
});

test('cached compatibility snapshots never spawn a helper and residency updates do not probe', () => {
  const profile = getCachedHardwareProfile({
    ...host,
    adapters: [],
    residency: [],
    env: {},
    run: () => assert.fail('must not probe'),
  });
  assert.equal(profile.maxContext, 4096);
  assert.equal(getGpuProfile({ ...host, adapters: [], residency: [], env: {} }).detected, false);
  assert.equal(
    observeResidency([{ name: 'fixture', size: GiB, size_vram: 0 }]).acceleration.mode,
    'cpu',
  );
  observeResidency([]);
});

test('hardware discovery cancellation returns promptly without changing the default profile', async () => {
  const controller = new AbortController();
  const pending = getHardwareProfile({
    run: async () => new Promise((resolve) => setTimeout(() => resolve({ status: 1 }), 50)),
    env: {},
    platform: 'linux',
    signal: controller.signal,
    ...host,
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
