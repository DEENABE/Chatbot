import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Generated files the user downloads from a chat message. Owner-scoped, kept 7 days. */

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f-]{36}$/;

export function safeOutputName(name, fallback = 'output.txt') {
  const cleaned = String(name || '')
    .split(/[\\/]/)
    .at(-1)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 150);
  return cleaned || fallback;
}

export class OutputStore {
  constructor(directory) {
    this.directory = directory;
  }

  async save(userId, name, data, mime) {
    const id = randomUUID();
    const dir = path.join(this.directory, id);
    await fs.mkdir(dir, { recursive: true });
    const fileName = safeOutputName(name);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    await fs.writeFile(path.join(dir, 'data'), buffer);
    await fs.writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({ id, userId, name: fileName, mime, size: buffer.length, createdAt: new Date().toISOString() }),
    );
    this.cleanup().catch(() => {});
    return { id, name: fileName, size: buffer.length, mime };
  }

  async get(userId, id) {
    if (!ID.test(String(id))) return null;
    const dir = path.join(this.directory, id);
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
      if (meta.userId !== userId) return null;
      return { ...meta, path: path.join(dir, 'data') };
    } catch {
      return null;
    }
  }

  async cleanup(now = Date.now()) {
    let entries = [];
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !ID.test(e.name)) continue;
      const dir = path.join(this.directory, e.name);
      try {
        const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
        if (now - Date.parse(meta.createdAt) > KEEP_MS) await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

const fmtSize = (n) =>
  n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Markdown link the chat UI turns into an authenticated download button. */
export const outputLink = (output) =>
  `[${output.name.replace(/[[\]]/g, '')} (${fmtSize(output.size)})](#chanakya-output=${output.id})`;
