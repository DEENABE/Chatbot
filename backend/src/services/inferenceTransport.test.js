import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchInference, isGpuBackendFailure } from './inferenceTransport.js';
import { getCachedHardwareProfile, inferencePlanForHardware } from './gpuProfile.js';
import { modelRuntime } from './modelRuntime.js';
import { config } from '../config.js';

const GiB = 1024 ** 3;
const endpoint = config.ollamaUrl + '/api/chat';
const request = (options = {}) => ({
  method: 'POST',
  body: JSON.stringify({
    model: 'fixture',
    messages: [{ role: 'user', content: 'test' }],
    stream: true,
    ...options,
  }),
});
function host({ ram = 16, free = 12, vram = 0, placement, gpuUsed = vram ? 3 : 0 } = {}) {
  return getCachedHardwareProfile({
    totalMemory: ram * GiB,
    freeMemory: free * GiB,
    cpus: Array.from({ length: 8 }, () => ({ model: 'Fixture CPU' })),
    parallelism: 8,
    env: {},
    adapters: vram ? [{ name: 'Fixture GPU', vramMiB: vram * 1024, memoryVerified: true }] : [],
    residency:
      placement === 'missing' ? [] : [{ name: 'fixture', size: 3 * GiB, size_vram: gpuUsed * GiB }],
  });
}

test('CPU-only hosts get bounded context/batching/threads without requiring GPU or forcing offload', async () => {
  let sent;
  const response = new Response('{"done":true}');
  const result = await fetchInference(
    endpoint,
    request({
      options: { num_ctx: 32768, num_batch: 4096, num_thread: 128, num_gpu: 99, main_gpu: 1 },
    }),
    {
      hardware: host({ ram: 8, free: 6 }),
      fetchImpl: async (_url, options) => {
        sent = JSON.parse(options.body);
        return response;
      },
    },
  );
  assert.equal(result, response);
  assert.equal(response.bodyUsed, false);
  assert.equal(sent.options.num_ctx, 2048);
  assert.equal(sent.options.num_batch, 128);
  assert.ok(sent.options.num_thread <= 8);
  assert.equal(Object.hasOwn(sent.options, 'num_gpu'), false);
  assert.equal(Object.hasOwn(sent.options, 'main_gpu'), false);
});
test('GPU and mixed hardware use the common resource plan while preserving headers, signals and body semantics', async () => {
  for (const hardware of [host({ vram: 8 }), host({ vram: 8, gpuUsed: 1 })]) {
    const controller = new AbortController();
    const headers = new Headers({
      Authorization: 'Bearer fixture',
      'Content-Type': 'application/json',
    });
    const body = {
      model: 'fixture',
      messages: [],
      options: { num_ctx: 8192, temperature: 0.7, num_batch: 32, num_thread: 2, num_predict: 1536 },
      keep_alive: '5m',
      think: true,
      tools: [],
    };
    let sent;
    await fetchInference(
      endpoint,
      { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) },
      {
        hardware,
        fetchImpl: async (url, options) => {
          assert.equal(url, endpoint);
          assert.equal(options.headers, headers);
          assert.equal(options.signal, controller.signal);
          assert.equal(options.redirect, 'error');
          sent = JSON.parse(options.body);
          return new Response('stream body');
        },
      },
    );
    assert.deepEqual(sent, body);
  }
});
test('missing drivers trigger one CPU retry before a response escapes', async () => {
  const calls = [];
  const expected = new Response('{"message":{"content":"cpu"},"done":true}');
  const result = await fetchInference(endpoint, request({ options: { num_ctx: 8192 } }), {
    hardware: host({ vram: 8, placement: 'missing' }),
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return calls.length === 1
        ? Response.json({ error: 'CUDA driver library cannot be found' }, { status: 503 })
        : expected;
    },
  });
  assert.equal(result, expected);
  assert.equal(expected.bodyUsed, false);
  assert.equal(calls.length, 2);
  assert.equal(Object.hasOwn(calls[0].options, 'num_gpu'), false);
  assert.equal(calls[1].options.num_gpu, 0);
  assert.equal(calls[1].options.num_ctx, 4096);
});
test('CUDA allocation errors retry only once, even if the fallback also fails', async () => {
  let calls = 0;
  const result = await fetchInference(endpoint, request(), {
    hardware: host({ vram: 8 }),
    fetchImpl: async () => {
      calls++;
      return Response.json(
        { error: 'ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory' },
        { status: 500 },
      );
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 500);
  assert.match((await result.json()).error, /cudaMalloc/);
});
test('generic low system RAM, ordinary 5xx, missing models and auth failures are never retried or consumed', async () => {
  for (const [status, detail] of [
    [500, 'model requires more system memory than is available'],
    [500, 'GPU model requires more system memory than is available'],
    [500, 'model runner crashed'],
    [404, 'CUDA model not found'],
    [401, 'GPU authentication error'],
    [429, 'CUDA queue unavailable'],
  ]) {
    let calls = 0;
    const expected = Response.json({ error: detail }, { status });
    const result = await fetchInference(endpoint, request(), {
      hardware: host({ vram: 8 }),
      fetchImpl: async () => {
        calls++;
        return expected;
      },
    });
    assert.equal(calls, 1);
    assert.equal(result, expected);
    assert.equal(result.bodyUsed, false);
    assert.equal((await result.json()).error, detail);
  }
});
test('network failures and caller aborts are propagated without a second request', async () => {
  const original = new Error('network unavailable');
  let calls = 0;
  await assert.rejects(
    fetchInference(endpoint, request(), {
      hardware: host(),
      fetchImpl: async () => {
        calls++;
        throw original;
      },
    }),
    (error) => error === original,
  );
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  calls = 0;
  await assert.rejects(
    fetchInference(
      endpoint,
      { ...request(), signal: controller.signal },
      {
        hardware: host(),
        fetchImpl: async (_url, options) => {
          calls++;
          options.signal.throwIfAborted();
        },
      },
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});
test('aborting after a GPU error prevents CPU replay', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    fetchInference(
      endpoint,
      { ...request(), signal: controller.signal },
      {
        hardware: host({ vram: 8 }),
        fetchImpl: async () => {
          calls++;
          controller.abort();
          return Response.json({ error: 'CUDA allocation error' }, { status: 500 });
        },
      },
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});
test('CPU retry refuses a coding/desktop prompt larger than the CPU-safe context without truncation', async () => {
  let calls = 0;
  await assert.rejects(
    fetchInference(endpoint, request({ options: { num_ctx: 8192 } }), {
      hardware: host({ ram: 8, free: 6, vram: 8 }),
      requiredContext: 6000,
      fetchImpl: async () => {
        calls++;
        return Response.json({ error: 'CUDA out of memory' }, { status: 500 });
      },
    }),
    (error) =>
      error.code === 'MODEL_CONTEXT_TOO_LARGE' &&
      /CPU-safe/.test(error.message) &&
      /no prompt was truncated/.test(error.message),
  );
  assert.equal(calls, 1);
});
test('initial hardware context overflow is rejected before dispatch', async () => {
  let calls = 0;
  await assert.rejects(
    fetchInference(endpoint, request(), {
      hardware: host({ ram: 8, free: 6 }),
      requiredContext: 4000,
      fetchImpl: async () => {
        calls++;
        assert.fail('must not send a truncated prompt');
      },
    }),
    { code: 'MODEL_CONTEXT_TOO_LARGE' },
  );
  assert.equal(calls, 0);
});
test('queued request defaults re-read current RAM while preserving its adapter/residency observations', async () => {
  let sent;
  const stale = host({ ram: 8, free: 6 });
  stale.memory.freeBytes = 1;
  stale.memory.usableModelBytes = 1;
  const current = getCachedHardwareProfile({
    adapters: stale.gpus,
    residency: stale.residency.map((value) => ({
      name: value.name,
      size: value.sizeBytes,
      size_vram: value.sizeVramBytes,
    })),
  });
  const expected = inferencePlanForHardware(current, {
    contextWindow: 8192,
    modelSizeBytes: GiB,
    modelId: 'fixture',
  });
  await modelRuntime.run(
    {
      model: 'fixture',
      hardware: stale,
      memory: { modelDiskBytes: GiB },
      options: { num_ctx: 8192 },
    },
    () =>
      fetchInference(endpoint, request(), {
        fetchImpl: async (_url, options) => {
          sent = JSON.parse(options.body);
          return new Response('ok');
        },
      }),
  );
  assert.equal(sent.options.num_ctx, expected.contextWindow);
  assert.equal(sent.options.num_batch, 128);
});
test('GPU retry refuses a known model larger than the CPU memory budget', async () => {
  let calls = 0;
  await modelRuntime.run({ model: 'fixture', memory: { modelDiskBytes: 7 * GiB } }, async () => {
    await assert.rejects(
      fetchInference(endpoint, request(), {
        hardware: host({ ram: 8, free: 4, vram: 16 }),
        fetchImpl: async () => {
          calls++;
          return Response.json({ error: 'CUDA allocation failed' }, { status: 500 });
        },
      }),
      { code: 'MODEL_MEMORY_INSUFFICIENT' },
    );
  });
  assert.equal(calls, 1);
});
test('strict configured origin rejects alternate local ports, remote URLs, credentials and query redirects', async () => {
  let calls = 0;
  for (const url of [
    'https://remote.example/api/chat',
    'http://127.0.0.1:1/api/chat',
    config.ollamaUrl.replace('://', '://user:secret@') + '/api/chat',
    endpoint + '?next=https://remote.example',
  ])
    await assert.rejects(
      fetchInference(url, request(), {
        fetchImpl: async () => {
          calls++;
        },
      }),
      { code: 'LOCAL_MODEL_ENDPOINT_REQUIRED' },
    );
  assert.equal(calls, 0);
});
test('metadata and unload operations retain their original request body while blocking redirects', async () => {
  for (const [url, options] of [
    [config.ollamaUrl + '/api/tags', { method: 'GET' }],
    [
      config.ollamaUrl + '/api/generate',
      { method: 'POST', body: JSON.stringify({ model: 'fixture', keep_alive: 0 }) },
    ],
  ]) {
    await fetchInference(url, options, {
      fetchImpl: async (_url, sent) => {
        assert.equal(sent.body, options.body);
        assert.equal(sent.redirect, 'error');
        return new Response('ok');
      },
    });
  }
});
test('GPU failure classification covers supported backends and excludes ordinary host-memory errors', () => {
  for (const detail of [
    'CUDA error: no CUDA-capable device is detected',
    'ROCm HIP error: unable to allocate device buffer',
    'Vulkan backend initialization failed',
    'GPU backend unavailable',
    'libcuda.so not found',
  ])
    assert.equal(isGpuBackendFailure(500, detail), true, detail);
  for (const detail of [
    'out of memory',
    'model requires more system memory',
    'cannot connect to Ollama',
    'CUDA model uses insufficient host memory',
  ])
    assert.equal(isGpuBackendFailure(500, detail), false, detail);
});

test('embedding requests preserve the embedding model native context while tuning hardware scheduling', async () => {
  for (const path of ['/api/embed', '/api/embeddings']) {
    await fetchInference(
      config.ollamaUrl + path,
      { method: 'POST', body: JSON.stringify({ model: 'fixture-embed', input: ['one'] }) },
      {
        hardware: host({ ram: 8, free: 6 }),
        fetchImpl: async (_url, options) => {
          const body = JSON.parse(options.body);
          assert.equal(Object.hasOwn(body.options, 'num_ctx'), false);
          assert.equal(Object.hasOwn(body.options, 'num_gpu'), false);
          assert.ok(body.options.num_thread >= 1);
          return Response.json({ embeddings: [[0.1, 0.2]] });
        },
      },
    );
  }
});
