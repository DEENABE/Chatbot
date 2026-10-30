import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

export function cpuUsageBetween(previous, current) {
  let total = 0;
  let idle = 0;
  for (let i = 0; i < Math.min(previous.length, current.length); i++) {
    const before = previous[i]?.times;
    const after = current[i]?.times;
    if (!before || !after) continue;
    const delta = Object.keys(after).reduce((sum, key) => sum + after[key] - (before[key] || 0), 0);
    const idleDelta = after.idle - before.idle;
    if (!Number.isFinite(delta) || delta < 0 || !Number.isFinite(idleDelta) || idleDelta < 0)
      continue;
    total += delta;
    idle += idleDelta;
  }
  return total > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - idle / total)))) : null;
}

/** Only measured values are numbers. GPU residency is not GPU utilization or temperature. */
export function createStatsReader({
  system = os,
  filesystem = fs,
  hardware = () => null,
  directory = () => process.cwd(),
  memoryUsage = () => process.memoryUsage(),
} = {}) {
  let previous = system.cpus();
  return async () => {
    const current = system.cpus();
    const cpu = cpuUsageBetween(previous, current);
    previous = current;
    const totalMem = system.totalmem();
    const freeMem = system.freemem();
    const ram =
      Number.isFinite(totalMem) && totalMem > 0 && Number.isFinite(freeMem)
        ? Math.max(0, Math.min(100, Math.round((1 - freeMem / totalMem) * 100)))
        : null;
    const localDirectory = directory();
    let disk = null;
    try {
      const measured = await filesystem.statfs(localDirectory);
      if (
        Number.isFinite(measured.blocks) &&
        measured.blocks > 0 &&
        Number.isFinite(measured.bfree)
      )
        disk = Math.max(0, Math.min(100, Math.round((1 - measured.bfree / measured.blocks) * 100)));
    } catch {
      /* An unavailable sensor remains unavailable; never invent a fallback percentage. */
    }
    const profile = hardware();
    const backendMemoryBytes = memoryUsage().heapUsed;
    return {
      cpu,
      ram,
      gpu: null,
      temperature: null,
      disk,
      diskRoot: path.parse(path.resolve(localDirectory)).root,
      backendMemoryBytes: Number.isFinite(backendMemoryBytes) ? backendMemoryBytes : null,
      // Retained for older renderer builds; this is backend heap MB, not total Electron memory.
      electronMemory: Number.isFinite(backendMemoryBytes)
        ? Math.round(backendMemoryBytes / 1024 ** 2)
        : null,
      hardware: profile,
      acceleration: profile?.acceleration || {
        mode: 'unknown',
        verified: false,
        source: 'unverified',
      },
      metricStatus: {
        cpu: cpu === null ? 'unavailable' : 'measured',
        ram: ram === null ? 'unavailable' : 'measured',
        disk: disk === null ? 'unavailable' : 'measured',
        gpu: 'unavailable',
        temperature: 'unavailable',
      },
      gpuUnavailableReason:
        'GPU utilization is not measured. The detected adapters and Ollama execution mode are listed separately.',
    };
  };
}
