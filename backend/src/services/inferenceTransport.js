import { config } from '../config.js';
import { getCachedHardwareProfile, inferencePlanForHardware } from './gpuProfile.js';
import { modelRuntime } from './modelRuntime.js';

const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const INFERENCE_PATH = /^\/api\/(?:chat|generate|embed|embeddings)\/?$/;

function endpointFor(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    /* handled below */
  }
  if (
    !url ||
    url.origin !== new URL(config.ollamaUrl).origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw fail(
      'Inference requests must use the configured local Ollama origin.',
      'LOCAL_MODEL_ENDPOINT_REQUIRED',
    );
  return url;
}

function requestBody(options) {
  if (options.body === undefined || options.body === null) return null;
  let body;
  try {
    body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
  } catch {
    throw fail(
      'The local inference request body must be a JSON object.',
      'INVALID_INFERENCE_REQUEST',
    );
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(body)) ||
    (body.options !== undefined &&
      (!body.options || typeof body.options !== 'object' || Array.isArray(body.options)))
  )
    throw fail(
      'The local inference request body and options must be JSON objects.',
      'INVALID_INFERENCE_REQUEST',
    );
  return body;
}

function currentHardware(explicit, runtime) {
  if (explicit) return explicit;
  const supplied = runtime?.hardware;
  // The cached accessor reads host memory and cached adapter observations; it never probes a driver synchronously.
  // A request can wait behind another inference, so never reuse its earlier free-RAM snapshot.
  return getCachedHardwareProfile(
    supplied
      ? {
          adapters: supplied.gpus,
          detectedAt: supplied.detectedAt,
          residency: (supplied.residency || []).map((model) => ({
            name: model.name,
            size: model.sizeBytes,
            size_vram: model.sizeVramBytes,
            context_length: model.contextWindow,
          })),
        }
      : {},
  );
}

function plannedBody(body, hardware, runtime, requiredContext, cpu = false) {
  const requested = body.options || {};
  const sameModel = !runtime?.model || body.model === runtime.model;
  const plan = inferencePlanForHardware(hardware, {
    contextWindow: positive(requested.num_ctx)
      ? requested.num_ctx
      : runtime?.options?.num_ctx || 8192,
    modelSizeBytes: sameModel ? runtime?.memory?.modelDiskBytes || 0 : 0,
    modelContextWindow: sameModel ? runtime?.modelContextWindow || 32768 : 32768,
    requiredContext,
    modelId: body.model,
  });
  if (cpu && sameModel && positive(runtime?.memory?.modelDiskBytes) && !plan.modelFitsEstimate)
    throw fail(
      'GPU inference failed, and this model exceeds the available CPU memory budget. Choose a smaller installed model or free system memory; no CPU retry was dispatched.',
      'MODEL_MEMORY_INSUFFICIENT',
      503,
    );
  if (!plan.fitsRequiredContext)
    throw fail(
      `${cpu ? 'GPU inference failed, and the CPU-safe' : 'The hardware-safe'} context budget is ${plan.contextWindow} tokens, but this request needs at least ${requiredContext}. Choose a smaller model or reduce the task; no prompt was truncated.`,
      'MODEL_CONTEXT_TOO_LARGE',
      413,
    );
  const tuned = { ...requested, ...plan.options };
  for (const key of ['num_batch', 'num_thread'])
    if (positive(requested[key]))
      tuned[key] = Math.max(1, Math.min(Math.floor(requested[key]), plan.options[key]));
  // Adapter detection is not proof of a working inference driver. Ollama makes the initial offload decision.
  delete tuned.num_gpu;
  delete tuned.main_gpu;
  if (cpu) tuned.num_gpu = 0;
  return { ...body, options: tuned };
}

/** Narrow classification: an OS RAM shortage or an ordinary model/server error must never cause a retry. */
export function isGpuBackendFailure(status, detail) {
  if (!Number.isInteger(status) || status < 500 || status > 599) return false;
  const text = String(detail || '');
  if (
    /\b(?:system|host) memory\b|\binsufficient RAM\b|\bmodel requires more\b[^\n]{0,150}\bmemory\b/i.test(
      text,
    )
  )
    return false;
  const gpu =
    /\b(?:gpu|vram|cuda\w*|cublas\w*|cudnn\w*|rocm|hip|hiperror\w*|vulkan|metal|directml|libcuda\w*|ggml[_-](?:backend[_-])?(?:cuda|vulkan|hip)\w*)\b/i;
  const failure =
    /\b(?:error|failed|failure|out of memory|cannot allocate|unable to allocate|could not allocate|insufficient|unsupported|unavailable|not available|no (?:compatible|supported|capable|cuda-capable|gpu|cuda) device|no cuda-capable device)\b/i;
  const missing =
    /\b(?:driver|backend|library|libcuda\w*)\b[^\n]{0,100}\b(?:missing|not found|cannot be found|could not be (?:found|loaded)|could not load|not installed|not available)\b/i;
  return gpu.test(text) && (failure.test(text) || missing.test(text));
}

async function failureDetail(response, signal) {
  if (typeof response.clone !== 'function') return '';
  const copy = response.clone();
  if (!copy.body) return '';
  const reader = copy.body.getReader();
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  try {
    while (bytes < 16 * 1024) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      text += decoder.decode(value.subarray(0, Math.max(0, 16 * 1024 - (bytes - value.length))), {
        stream: true,
      });
    }
    return text + decoder.decode();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return '';
  } finally {
    // A cloned response tees its source. Waiting for one branch to cancel can block on the original consumer.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * One local inference attempt, with one CPU retry only after an HTTP GPU-backend failure, before any response escapes.
 * Successful streaming responses are returned untouched; aborts, transport failures and generic HTTP errors are never replayed.
 */
export async function fetchInference(
  url,
  options = {},
  { fetchImpl = globalThis.fetch, requiredContext = 0, hardware } = {},
) {
  const target = endpointFor(url);
  const body = requestBody(options);
  if (
    !body ||
    !INFERENCE_PATH.test(target.pathname) ||
    !body.model ||
    (target.pathname.replace(/\/$/, '') === '/api/generate' &&
      body.keep_alive === 0 &&
      !body.prompt)
  )
    return fetchImpl(target.href, { ...options, redirect: 'error' });
  const runtime = modelRuntime.getStore();
  const profile = currentHardware(hardware, runtime);
  // Embedding models have their own trained context; without an explicit caller limit, preserve the native default.
  const preserveEmbeddingContext =
    /\/api\/(?:embed|embeddings)\/?$/.test(target.pathname) &&
    !Object.hasOwn(body.options || {}, 'num_ctx');
  const withNativeEmbeddingContext = (planned) => {
    if (preserveEmbeddingContext) delete planned.options.num_ctx;
    return planned;
  };
  const initial = withNativeEmbeddingContext(plannedBody(body, profile, runtime, requiredContext));
  const response = await fetchImpl(target.href, {
    ...options,
    redirect: 'error',
    body: JSON.stringify(initial),
  });
  if (response.status < 500 || response.status > 599) return response;
  const detail = await failureDetail(response, options.signal);
  if (!isGpuBackendFailure(response.status, detail)) return response;
  options.signal?.throwIfAborted();
  const cpu = {
    ...profile,
    gpus: [],
    adapterDetected: false,
    detectionDisabled: true,
    acceleration: { mode: 'cpu', verified: false, source: 'runtime-fallback' },
    residency: [],
  };
  let fallback;
  try {
    fallback = withNativeEmbeddingContext(plannedBody(body, cpu, runtime, requiredContext, true));
  } finally {
    response.body?.cancel().catch(() => {});
  }
  console.warn(
    '[inference] GPU backend failed before output; retrying once with CPU-safe options.',
  );
  return fetchImpl(target.href, { ...options, redirect: 'error', body: JSON.stringify(fallback) });
}
