import fs from 'node:fs';
import path from 'node:path';

/** Single Electron writer; the worker-coordination design specifies future fencing. */
export class DurableConfirmationStore {
  constructor(directory) {
    this.file = directory ? path.join(directory, 'confirmations.json') : null;
    if (directory) fs.mkdirSync(directory, { recursive: true });
  }
  load() {
    if (!this.file) return {};
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.schemaVersion !== 1 || !saved.records || typeof saved.records !== 'object' || Array.isArray(saved.records)) throw new Error('Invalid confirmation store');
      for (const [id, record] of Object.entries(saved.records)) {
        if (!record || record.confirmationId !== id || typeof record.rootId !== 'string' || !Number.isInteger(record.generation) || record.generation < 0 || !Number.isFinite(record.expiresAt) || !['pending','consumed','cancelled','superseded'].includes(record.status) || !record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) throw new Error('Invalid durable confirmation record');
        if (!Object.hasOwn(saved.records, record.rootId) || (record.generation > 0 && !Object.hasOwn(saved.records, record.previousId)) || (record.status === 'superseded' && !Object.hasOwn(saved.records, record.replacementId))) throw new Error('Broken confirmation lineage');
      }
      return saved.records;
    } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  save(records) {
    if (!this.file) return;
    const fd = fs.openSync(this.file + '.tmp', 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, records })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(this.file + '.tmp', this.file);
  }
  update(previous, next) {
    if (!this.file) { this.save(next); return next; }
    // Exclusive cross-process lock plus compare-and-swap. A crash leaves the
    // lock closed rather than risking a second mutation with stale authority.
    const lock=this.file+'.lock';
    const fd=fs.openSync(lock,'wx',0o600);
    try {
      const current=this.load();
      for(const key of Object.keys(next)) if(JSON.stringify(previous[key])!==JSON.stringify(next[key])) {
        if(JSON.stringify(previous[key])!==JSON.stringify(current[key])) throw new Error('Approval store conflict');
        current[key]=next[key];
      }
      this.save(current);
      return current;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}
