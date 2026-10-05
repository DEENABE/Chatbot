import { mkdirSync, existsSync, readFileSync, statSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';

// One service instance per data directory. Every record is flushed before its side effect starts.
// An incomplete record makes startup fail closed; operators must inspect/recover the journal.
export class Journal {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'journal.jsonl');
    this.requests = new Map();
    this.uncertain = new Map();
    if (existsSync(this.file)) {
      if (statSync(this.file).size > 128 * 1024 * 1024) throw new Error('Journal exceeds 128 MiB; archive it through an operator-reviewed retention procedure.');
      const data = readFileSync(this.file, 'utf8');
      if (data && !data.endsWith('\n')) throw new Error('Journal has an incomplete record. Inspect it before recovery; do not silently retry writes.');
      for (const line of data.split('\n').filter(Boolean)) {
        let event;
        try { event = JSON.parse(line); } catch { throw new Error('Journal contains invalid JSON. Operator recovery is required.'); }
        if (event.version !== 1 || typeof event.event !== 'string') throw new Error('Unsupported journal record');
        this.reduce(event);
      }
    }
  }
  reduce(event) {
    if (event.event === 'request_started') this.requests.set(event.requestId, { status: 'started', bodyHash: event.bodyHash, time: event.time });
    if (event.event === 'request_finished') this.requests.set(event.requestId, { ...this.requests.get(event.requestId), status: event.status, time: event.time });
    if (event.event === 'execute_started') this.uncertain.set(event.executionId, event);
    if (event.event === 'execute_finished') {
      if (event.outcomeUnknown) this.uncertain.set(event.executionId, event);
      else this.uncertain.delete(event.executionId);
    }
    if (event.event === 'operator_recovery') this.uncertain.delete(event.executionId);
  }
  append(event) {
    const record = { ...event, version: 1, time: new Date().toISOString() };
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    if ((existsSync(this.file) ? statSync(this.file).size : 0) + bytes.length > 128 * 1024 * 1024) throw new Error('Journal capacity reached; operator retention review required before further operations.');
    const fd = openSync(this.file, 'a', 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!written) throw new Error('Journal write made no progress');
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    this.reduce(record);
  }
  claimRequest(requestId, bodyHash) {
    if (this.requests.has(requestId)) return false;
    if (this.requests.size >= 100000) throw new Error('Persistent request ledger is full; operator retention review required');
    this.append({ event: 'request_started', requestId, bodyHash });
    return true;
  }
  get writesBlocked() { return this.uncertain.size > 0; }
}
