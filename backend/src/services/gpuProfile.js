import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const CACHE_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 4000;
const CIM_QUERY =
  'Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object Name,AdapterCompatibility,AdapterRAM,VideoProcessor,PNPDeviceID | ConvertTo-Json -Compress';
const positive = (value) =>
  Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const contextOverride = (env) => {
  const value = Number(env.GPU_MAX_CONTEXT);
  return Number.isInteger(value) && value >= 2048 && value <= 32768 ? value : 32768;
};
const vendorFor = (name) =>
  /nvidia/i.test(name)
    ? 'nvidia'
    : /amd|radeon|advanced micro devices/i.test(name)
      ? 'amd'
      : /intel/i.test(name)
        ? 'intel'
        : /apple/i.test(name)
          ? 'apple'
          : 'unknown';

// Scheduling hints, not promises that a particular model's KV cache fits in VRAM.
export function contextCapForVram(vramMiB) {
  if (!positive(vramMiB)) return 4096;
  if (vramMiB <= 2048 + 256) return 2048;
  if (vramMiB <= 4096 + 512) return 4096;
  if (vramMiB <= 6144 + 512) return 8192;
  if (vramMiB <= 8192 + 512) return 16384;
  return 32768;
}

export function parseNvidiaSmi(output) {
  // Use the final comma so a GPU name containing a comma cannot be mistaken for memory.
  const line = String(output || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  const comma = line?.lastIndexOf(',') ?? -1;
  if (comma < 1) return null;
  const name = line.slice(0, comma).trim();
  const memory = line.slice(comma + 1).trim();
  if (!/^\d+(?:\.\d+)?$/.test(memory)) return null;
  const vramMiB = Number(memory);
  return name && vramMiB > 0 && vramMiB <= 1024 * 1024 ? { name, vramMiB } : null;
}

export function parseWindowsAdapters(output) {
  let values;
  try {
    values = JSON.parse(String(output || '').replace(/^\uFEFF/, ''));
  } catch {
    return [];
  }
  return (Array.isArray(values) ? values : values ? [values] : []).slice(0, 16).flatMap((value) => {
    if (!value || typeof value.Name !== 'string' || !value.Name.trim()) return [];
    const name = value.Name.replace(/[\x00-\x1f]/g, '')
      .trim()
      .slice(0, 200);
    if (/microsoft (?:basic|remote)|remote display|virtual (?:display|video)/i.test(name))
      return [];
    const vendor = vendorFor(`${name} ${String(value.AdapterCompatibility || '')}`);
    return [
      {
        name,
        vendor,
        vramMiB: Math.round(positive(value.AdapterRAM) / MiB),
        // AdapterRAM is a 32-bit field and is not reliable dedicated VRAM.
        memoryVerified: false,
        source: 'windows-cim',
        integrated: /intel.*(?:uhd|iris|hd graphics)|radeon(?:\(tm\))? graphics/i.test(name),
      },
    ];
  });
}

function runCommand(file, args, options) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        shell: false,
        ...options,
      },
      (error, stdout) => {
        resolve({ status: error ? 1 : 0, stdout: stdout || '' });
      },
    );
  });
}

let cachedAdapters = null;
let pending = null;
let loadedModels = [];

function residentModels(values) {
  return (Array.isArray(values) ? values : []).slice(0, 32).flatMap((value) => {
    const size = positive(value?.size),
      sizeVram = value?.size_vram;
    if (!size || typeof sizeVram !== 'number' || !Number.isFinite(sizeVram) || sizeVram < 0)
      return [];
    return [
      {
        name:
          typeof value.name === 'string'
            ? value.name.slice(0, 200)
            : typeof value.model === 'string'
              ? value.model.slice(0, 200)
              : '',
        sizeBytes: size,
        sizeVramBytes: Math.min(size, sizeVram),
        contextWindow: positive(value.context_length),
      },
    ];
  });
}

export function accelerationForResidency(models) {
  const values = residentModels(models);
  if (!values.length) return { mode: 'unknown', verified: false, source: 'unverified' };
  const size = values.reduce((total, value) => total + value.sizeBytes, 0);
  const gpu = values.reduce((total, value) => total + value.sizeVramBytes, 0);
  return {
    mode: gpu === 0 ? 'cpu' : gpu >= size ? 'gpu' : 'mixed',
    verified: true,
    source: 'ollama',
  };
}

/** Update observed placement only. Never launches inference or changes Ollama. */
export function observeResidency(models) {
  loadedModels = Array.isArray(models) ? models : [];
  return getCachedHardwareProfile();
}

function buildProfile({
  adapters = cachedAdapters?.gpus || [],
  detectedAt = cachedAdapters?.detectedAt || null,
  platform = process.platform,
  totalMemory = os.totalmem(),
  freeMemory = os.freemem(),
  cpus = os.cpus(),
  parallelism = os.availableParallelism?.() || cpus.length || 1,
  arch = process.arch,
  env = process.env,
  residency = loadedModels,
} = {}) {
  const totalBytes = positive(totalMemory);
  const freeBytes = Math.min(totalBytes, positive(freeMemory));
  const resident = residentModels(residency);
  const reclaimableRam = resident.reduce(
    (sum, item) => sum + item.sizeBytes - item.sizeVramBytes,
    0,
  );
  const headroom = Math.max(512 * MiB, totalBytes * 0.12);
  const usableModelBytes = Math.max(
    0,
    Math.min(totalBytes * 0.75, freeBytes + reclaimableRam - headroom),
  );
  const disabled = String(env.GPU_PROFILE || '').toLowerCase() === 'off';
  const gpus = disabled ? [] : adapters.map((gpu) => ({ ...gpu }));
  const profile = {
    schemaVersion: 1,
    platform,
    detectedAt,
    cpu: {
      logicalCores: Math.max(1, cpus.length),
      parallelism: Math.max(1, Math.floor(positive(parallelism) || 1)),
      arch,
      model: String(cpus[0]?.model || 'Unknown CPU').slice(0, 200),
    },
    memory: { totalBytes, freeBytes, usableModelBytes },
    gpus,
    adapterDetected: gpus.length > 0,
    acceleration: accelerationForResidency(residency),
    residency: resident,
    contextOverride: contextOverride(env),
    detectionDisabled: disabled,
    // An adapter inventory alone never claims Ollama GPU inference is available.
    detectionSource: detectedAt ? 'local-hardware' : 'not-probed',
  };
  profile.maxContext = inferencePlanForHardware(profile, { contextWindow: 32768 }).maxContext;
  return profile;
}

/** Current-memory snapshot. Safe before discovery and never starts a subprocess. */
export function getCachedHardwareProfile(options = {}) {
  return buildProfile(options);
}

async function detectAdapters({ run, env, platform }) {
  if (String(env.GPU_PROFILE || '').toLowerCase() === 'off') return [];
  const nvidia = Promise.resolve()
    .then(() =>
      run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        shell: false,
      }),
    )
    .then((result) => {
      if (result?.status !== 0) return [];
      return String(result.stdout || '')
        .split(/\r?\n/)
        .flatMap((line) => {
          const parsed = parseNvidiaSmi(line);
          return parsed
            ? [
                {
                  ...parsed,
                  vendor: 'nvidia',
                  source: 'nvidia-smi',
                  integrated: false,
                  memoryVerified: true,
                },
              ]
            : [];
        });
    })
    .catch(() => []);
  const windows =
    platform === 'win32'
      ? Promise.resolve()
          .then(() =>
            run(
              path.join(
                env.SystemRoot || 'C:\\Windows',
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'powershell.exe',
              ),
              ['-NoProfile', '-NonInteractive', '-Command', CIM_QUERY],
              {
                encoding: 'utf8',
                timeout: PROBE_TIMEOUT_MS,
                maxBuffer: 64 * 1024,
                windowsHide: true,
                shell: false,
              },
            ),
          )
          .then((result) => (result?.status === 0 ? parseWindowsAdapters(result.stdout) : []))
          .catch(() => [])
      : Promise.resolve([]);
  const [verified, inventory] = await Promise.all([nvidia, windows]);
  const known = new Set(verified.map((gpu) => gpu.name.toLowerCase()));
  return [...verified, ...inventory.filter((gpu) => !known.has(gpu.name.toLowerCase()))].slice(
    0,
    16,
  );
}

function awaitOrAbort(operation, signal) {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Async cached host inventory. No admin prompt, downloads, restarts or persistent settings. */
export async function getHardwareProfile({
  refresh = false,
  signal,
  run = runCommand,
  env = process.env,
  platform = process.platform,
  residency,
  now = Date.now,
  ...host
} = {}) {
  signal?.throwIfAborted();
  const injected =
    run !== runCommand ||
    env !== process.env ||
    platform !== process.platform ||
    Object.keys(host).length > 0;
  let inventory;
  if (injected)
    inventory = await awaitOrAbort(
      detectAdapters({ run, env, platform }).then((gpus) => ({
        gpus,
        detectedAt: new Date(now()).toISOString(),
      })),
      signal,
    );
  else {
    if (refresh || !cachedAdapters || now() >= cachedAdapters.expiresAt) {
      pending ||= detectAdapters({ run, env, platform })
        .then((gpus) => {
          cachedAdapters = {
            gpus,
            detectedAt: new Date(now()).toISOString(),
            expiresAt: now() + CACHE_MS,
          };
          return cachedAdapters;
        })
        .finally(() => {
          pending = null;
        });
      inventory = await awaitOrAbort(pending, signal);
    } else inventory = cachedAdapters;
  }
  let currentResidency = loadedModels;
  if (residency !== undefined) {
    try {
      currentResidency =
        typeof residency === 'function'
          ? await awaitOrAbort(Promise.resolve().then(residency), signal)
          : residency;
    } catch (error) {
      signal?.throwIfAborted();
      currentResidency = [];
    }
    if (!injected) loadedModels = Array.isArray(currentResidency) ? currentResidency : [];
  }
  return buildProfile({
    ...host,
    env,
    platform,
    adapters: inventory.gpus,
    detectedAt: inventory.detectedAt,
    residency: currentResidency,
  });
}

/** Conservative heuristics; Ollama still selects CPU/GPU offload for this host. */
export function inferencePlanForHardware(
  profile,
  {
    contextWindow = 8192,
    modelSizeBytes = 0,
    modelContextWindow = 32768,
    requiredContext = 0,
    modelId,
  } = {},
) {
  const total = positive(profile?.memory?.totalBytes);
  const usable = positive(profile?.memory?.usableModelBytes);
  const cpu = profile?.cpu || {};
  const gpus = Array.isArray(profile?.gpus) ? profile.gpus : [];
  const selectedResidency =
    typeof modelId === 'string'
      ? profile?.residency?.find(
          (value) => value.name === modelId || value.name === `${modelId}:latest`,
        )
      : null;
  const acceleration =
    profile?.detectionDisabled && profile?.acceleration?.mode === 'cpu'
      ? profile.acceleration
      : selectedResidency
        ? accelerationForResidency([
            { size: selectedResidency.sizeBytes, size_vram: selectedResidency.sizeVramBytes },
          ])
        : typeof modelId === 'string'
          ? { mode: 'unknown', verified: false }
          : profile?.acceleration || { mode: 'unknown', verified: false };
  const vramBytes = Math.max(
    0,
    ...gpus.filter((gpu) => gpu.memoryVerified === true).map((gpu) => positive(gpu.vramMiB) * MiB),
  );
  const cpuModelBudgetBytes = Math.floor(usable / 1.35);
  // Actual GPU allocations are a proven lower bound when an OS probe is unavailable (for example AMD/Intel).
  // This is allocated memory, not a fabricated total VRAM capacity or a promise that a larger model will fit.
  const observedGpuBytes = Math.max(
    0,
    ...(Array.isArray(profile?.residency) ? profile.residency : []).map((value) =>
      positive(value.sizeVramBytes),
    ),
  );
  const gpuModelBudgetBytes = Math.floor(Math.max(vramBytes * 0.75, observedGpuBytes));
  let cpuCap =
    total <= 8.5 * GiB ? 2048 : total <= 16.5 * GiB ? 4096 : total <= 32.5 * GiB ? 8192 : 16384;
  if (usable < 2 * GiB) cpuCap = Math.min(cpuCap, 2048);
  else if (usable < 4 * GiB) cpuCap = Math.min(cpuCap, 4096);
  const estimate = positive(modelSizeBytes);
  const expectedGpu =
    acceleration.mode !== 'cpu' &&
    !profile?.detectionDisabled &&
    vramBytes > 0 &&
    (!estimate || estimate <= gpuModelBudgetBytes);
  const observedGpu = acceleration.verified && ['gpu', 'mixed'].includes(acceleration.mode);
  let maxContext = expectedGpu ? contextCapForVram(vramBytes / MiB) : cpuCap;
  if (observedGpu && !vramBytes) {
    maxContext = Math.max(cpuCap, 4096);
    if (positive(selectedResidency?.contextWindow))
      maxContext = Math.min(maxContext, selectedResidency.contextWindow);
  }
  maxContext = Math.min(maxContext, positive(profile?.contextOverride) || 32768);
  const requested = Math.max(512, Math.floor(positive(contextWindow) || 8192));
  const supported = Math.max(512, Math.floor(positive(modelContextWindow) || 32768));
  const chosen = Math.min(requested, supported, maxContext);
  const modelBudgetBytes = Math.max(cpuModelBudgetBytes, gpuModelBudgetBytes);
  return {
    options: {
      num_ctx: chosen,
      num_batch: expectedGpu || observedGpu ? 256 : 128,
      num_thread: Math.max(
        1,
        Math.min(
          16,
          Math.floor((positive(cpu.parallelism) || positive(cpu.logicalCores) || 1) * 0.75),
        ),
      ),
    },
    contextWindow: chosen,
    maxContext,
    mode: acceleration.mode,
    accelerationVerified: acceleration.verified === true,
    adapterDetected: profile?.adapterDetected === true,
    modelBudgetBytes,
    cpuModelBudgetBytes,
    gpuModelBudgetBytes,
    modelFitsEstimate: !estimate || estimate <= modelBudgetBytes,
    fitsRequiredContext: !positive(requiredContext) || requiredContext <= chosen,
    reason:
      acceleration.mode === 'cpu'
        ? 'Ollama reports CPU execution; context and batching follow available system memory.'
        : observedGpu
          ? 'Ollama reports GPU or mixed execution; memory limits remain host-specific.'
          : expectedGpu
            ? 'A GPU was detected; context is a conservative memory estimate and Ollama decides actual offload.'
            : 'CPU-safe context and batching are selected from current RAM; Ollama may use a supported GPU automatically.',
  };
}

/** Legacy shape, now nonblocking. Call getHardwareProfile() to warm discovery first. */
export function getGpuProfile(options = {}) {
  const hardware = getCachedHardwareProfile(options);
  const best = [...hardware.gpus].sort((a, b) => b.vramMiB - a.vramMiB)[0];
  return {
    name: best?.name || null,
    vramMiB: best?.vramMiB || 0,
    detected: hardware.adapterDetected,
    maxContext: hardware.maxContext,
    acceleration: hardware.acceleration,
  };
}
export const gpuContextCap = (requested) => Math.min(requested, getGpuProfile().maxContext);
