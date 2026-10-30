import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DocIntelError } from './errors.js';
import { safeFileName } from './formats.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Read-only copies of uploaded documents, owner-scoped and keyed by document
 * id. Uploads are deleted after indexing, so conversions (e.g. DOCX → PDF via
 * LibreOffice), edits-to-a-copy and re-parsing with real sheet row numbers
 * need the original bytes. Files are written atomically and made read-only;
 * nothing in the agent ever writes to an original — edits produce new files.
 *
 * Retention: chat attachments 7 days, knowledge-base uploads 30 days, and a
 * copy is removed as soon as its document is deleted.
 */
export class OriginalStore {
  constructor(directory, { keep = { attachment: 7 * DAY, knowledge: 30 * DAY } } = {}) {
    this.directory = directory;
    this.keep = keep;
  }

  dir(documentId) {
    if (!UUID.test(String(documentId))) throw new DocIntelError('BAD_ID', 'Invalid document id.');
    return path.join(this.directory, String(documentId).toLowerCase());
  }

  async keepCopy(userId, documentId, sourcePath, { name, mime, purpose = 'attachment' } = {}) {
    const dir = this.dir(documentId);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `data.${randomUUID()}.tmp`);
    await fs.copyFile(sourcePath, tmp);
    await fs.chmod(tmp, 0o444).catch(() => {});
    await fs.rename(tmp, path.join(dir, 'data'));
    const meta = {
      documentId,
      userId,
      name: safeFileName(name),
      mime: mime || null,
      purpose,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
    this.cleanup().catch(() => {});
    return meta;
  }

  /** { path, name, mime, purpose } or null when missing / owned by someone else. */
  async get(userId, documentId) {
    let dir;
    try {
      dir = this.dir(documentId);
    } catch {
      return null;
    }
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
      if (meta.userId !== userId) return null;
      const file = path.join(dir, 'data');
      await fs.access(file);
      return { ...meta, path: file };
    } catch {
      return null;
    }
  }

  async remove(userId, documentId) {
    const found = await this.get(userId, documentId);
    if (!found) return false;
    const dir = this.dir(documentId);
    await fs.chmod(path.join(dir, 'data'), 0o644).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  }

  async cleanup(now = Date.now()) {
    let entries = [];
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const e of entries) {
      if (!e.isDirectory() || !UUID.test(e.name)) continue;
      const dir = path.join(this.directory, e.name);
      try {
        const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
        const keep = this.keep[meta.purpose] ?? this.keep.attachment;
        if (now - Date.parse(meta.createdAt) > keep) {
          await fs.chmod(path.join(dir, 'data'), 0o644).catch(() => {});
          await fs.rm(dir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* unreadable entry: leave it for manual cleanup */
      }
    }
    return removed;
  }
}

/**
 * Recent exact-operation results kept in memory so the UI can page through
 * large results without recomputing or re-asking the model. Owner-scoped,
 * expires after 2 hours, at most 200 results per process.
 */
export class ResultStore {
  constructor({ ttlMs = 2 * 60 * 60 * 1000, max = 200 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.items = new Map();
  }

  put(userId, result) {
    const id = randomUUID();
    this.items.set(id, { userId, result, at: Date.now() });
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value);
    return id;
  }

  get(userId, id) {
    const item = this.items.get(id);
    if (!item || item.userId !== userId) return null;
    if (Date.now() - item.at > this.ttlMs) {
      this.items.delete(id);
      return null;
    }
    return item.result;
  }
}

/**
 * Long-running document jobs (conversion, generation, summaries) with
 * progress, cancellation and owner checks. Jobs live in memory; finished jobs
 * are kept for 1 hour.
 */
export class JobRegistry {
  constructor({ keepMs = 60 * 60 * 1000, maxActivePerUser = 3 } = {}) {
    this.jobs = new Map();
    this.keepMs = keepMs;
    this.maxActivePerUser = maxActivePerUser;
  }

  start(userId, kind, run) {
    this.prune();
    const active = [...this.jobs.values()].filter(
      (j) => j.userId === userId && j.status === 'running',
    ).length;
    if (active >= this.maxActivePerUser)
      throw new DocIntelError(
        'BUSY',
        'Too many document jobs are running. Wait for one to finish.',
        { status: 429 },
      );
    const id = randomUUID();
    const controller = new AbortController();
    const job = {
      id,
      userId,
      kind,
      status: 'running',
      progress: { percent: 0, message: 'Starting' },
      createdAt: Date.now(),
      controller,
      result: null,
      error: null,
    };
    this.jobs.set(id, job);
    const progress = (percent, message) => {
      if (job.status === 'running')
        job.progress = { percent: Math.max(0, Math.min(100, Math.round(percent))), message };
    };
    Promise.resolve()
      .then(() => run({ signal: controller.signal, progress }))
      .then((result) => {
        if (job.status !== 'running') return;
        job.status = 'done';
        job.result = result;
        job.progress = { percent: 100, message: 'Done' };
      })
      .catch((error) => {
        if (job.status !== 'running') return;
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error =
          error instanceof DocIntelError
            ? { code: error.code, message: error.message }
            : { code: 'INTERNAL', message: 'The job failed unexpectedly.' };
        if (!(error instanceof DocIntelError) && !controller.signal.aborted)
          console.error('[docintel] job failed:', error);
      })
      .finally(() => (job.finishedAt = Date.now()));
    return job;
  }

  get(userId, id) {
    const job = this.jobs.get(id);
    return job && job.userId === userId ? job : null;
  }

  cancel(userId, id) {
    const job = this.get(userId, id);
    if (!job) return null;
    if (job.status === 'running') {
      job.controller.abort(
        new DocIntelError('CANCELLED', 'Cancelled by the user.', { status: 499 }),
      );
      job.status = 'cancelled';
      job.error = { code: 'CANCELLED', message: 'Cancelled by the user.' };
      job.finishedAt = Date.now();
    }
    return job;
  }

  view(job) {
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      result: job.result,
      error: job.error,
      createdAt: new Date(job.createdAt).toISOString(),
    };
  }

  prune(now = Date.now()) {
    for (const [id, j] of this.jobs)
      if (j.finishedAt && now - j.finishedAt > this.keepMs) this.jobs.delete(id);
  }
}
