import os from 'node:os';
import { createHash } from 'node:crypto';
import { publicText, safeText, memoryError } from './validation.js';
const TTL = { STATIC: 30 * 86400000, SEMI_STATIC: 3600000, DYNAMIC: 5000 };
const allowed = new Set([
  'os.platform',
  'os.version',
  'os.build',
  'machine.hostname',
  'hardware.cpu',
  'hardware.ram',
  'hardware.free_ram',
  'app.runtime',
  'capability.version',
  'ollama.models',
]);
export const localMachineId = () =>
  createHash('sha256')
    .update(os.hostname() + '|' + os.platform() + '|' + os.arch())
    .digest('hex')
    .slice(0, 32);
export class SystemMemoryService {
  constructor(repository, { machineId = localMachineId(), probe } = {}) {
    this.r = repository;
    this.machineId = machineId;
    this.probe =
      probe ||
      (() => [
        ['os.platform', os.platform(), 'STATIC'],
        ['os.version', os.version(), 'SEMI_STATIC'],
        ['os.build', os.release(), 'SEMI_STATIC'],
        ['machine.hostname', os.hostname(), 'SEMI_STATIC'],
        ['hardware.cpu', os.cpus()[0]?.model || 'Unknown', 'STATIC'],
        ['hardware.ram', String(os.totalmem()), 'SEMI_STATIC'],
        ['hardware.free_ram', String(os.freemem()), 'DYNAMIC'],
        ['app.runtime', process.version, 'SEMI_STATIC'],
        [
          'capability.version',
          'windows.printSpooler.start.v1; safe read and launch contracts',
          'SEMI_STATIC',
        ],
      ]);
  }
  setSystemMemory(key, value, classification = 'SEMI_STATIC', { source = 'system_probe' } = {}) {
    if (
      !allowed.has(key) ||
      !TTL[classification] ||
      !['system_probe', 'ollama_local'].includes(source)
    )
      throw memoryError();
    const clean = safeText(value, 2000),
      now = this.r.now();
    this.r.db
      .prepare(
        'INSERT INTO system_memories VALUES(?,?,?,?,?,?,?) ON CONFLICT(machine_id,key) DO UPDATE SET value=excluded.value,classification=excluded.classification,source=excluded.source,last_verified_at=excluded.last_verified_at,expires_at=excluded.expires_at',
      )
      .run(this.machineId, key, clean, classification, source, now, now + TTL[classification]);
  }
  getSystemMemory({ includeStale = false } = {}) {
    return this.r.db
      .prepare('SELECT * FROM system_memories WHERE machine_id=? ORDER BY key')
      .all(this.machineId)
      .map((r) => ({
        memoryType: 'system',
        key: r.key,
        value: r.value,
        classification: r.classification,
        source: r.source,
        lastVerifiedAt: r.last_verified_at,
        expiresAt: r.expires_at,
        fresh: r.expires_at > this.r.now() && r.last_verified_at <= this.r.now(),
        authority: 'cached_context_not_execution_evidence',
      }))
      .filter((r) => includeStale || r.fresh);
  }
  async refreshSystemMemory() {
    for (const [key, value, classification] of await this.probe())
      if (publicText(value)) this.setSystemMemory(key, value, classification);
    return this.getSystemMemory();
  }
  invalidateSystemMemory(key) {
    if (!allowed.has(key)) throw memoryError();
    this.r.db
      .prepare('UPDATE system_memories SET expires_at=0 WHERE machine_id=? AND key=?')
      .run(this.machineId, key);
  }
  getSystemSnapshot() {
    return {
      machineId: this.machineId,
      entries: this.getSystemMemory({ includeStale: true }),
      cached: true,
      requiresFreshDiagnosisForActions: true,
    };
  }
}
