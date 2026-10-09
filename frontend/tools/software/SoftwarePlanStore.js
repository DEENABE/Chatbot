import fs from 'node:fs';
import path from 'node:path';
import {
  createHmac,
  timingSafeEqual,
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const failure = (code, message) => Object.assign(new Error(message), { code });
export function softwareOwner(scope) {
  const owner =
    /^renderer:([0-9a-f-]{36})-\d+$/i.exec(scope || '')?.[1] ||
    /^backend:([0-9a-f-]{36})(?:-[A-Za-z0-9-]+)?$/i.exec(scope || '')?.[1];
  if (
    !owner ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner)
  )
    throw failure('AUTH_CONTEXT_REQUIRED', 'An authenticated software session is required.');
  return owner.toLowerCase();
}

/** Persistent owned IDs and approvals use authenticated bytes, never trusted arbitrary JSON. */
export class SoftwarePlanStore {
  constructor({ directory, key, now = Date.now, maxRecords = 2000 } = {}) {
    if (!directory || !Buffer.isBuffer(key) || key.length !== 32)
      throw new Error('Protected software storage is required.');
    this.directory = path.resolve(directory);
    this.key = key;
    this.now = now;
    this.maxRecords = maxRecords;
    fs.mkdirSync(this.directory, { recursive: true });
  }
  filename(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw failure(
        'SOFTWARE_HANDLE_INVALID',
        'This software selection is invalid. Discover the software again.',
      );
    return path.join(this.directory, `${id}.json`);
  }
  put(kind, scope, data, { id = randomUUID(), expiresAt = this.now() + 24 * 60 * 60_000 } = {}) {
    const owner = softwareOwner(scope);
    if (!['discovery', 'candidate', 'plan', 'configuration', 'result', 'cache'].includes(kind))
      throw new Error('Invalid software record type.');
    const files = fs.readdirSync(this.directory).filter((name) => name.endsWith('.json'));
    if (!fs.existsSync(this.filename(id)) && files.length >= this.maxRecords)
      throw failure(
        'SOFTWARE_STORAGE_FULL',
        'Software selection storage is full. Remove an old source or retry after expired selections are cleaned up.',
      );
    const payload = JSON.stringify(
      canonical({ schemaVersion: 1, id, kind, owner, issuedAt: this.now(), expiresAt, data }),
    );
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024)
      throw failure('SOFTWARE_RECORD_TOO_LARGE', 'Software metadata exceeds its safe limit.');
    const mac = createHmac('sha256', this.key).update(payload).digest('base64url');
    const target = this.filename(id),
      temporary = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ payload, mac }), { mode: 0o600 });
    fs.renameSync(temporary, target);
    return id;
  }
  get(kind, scope, id) {
    const owner = softwareOwner(scope),
      file = this.filename(id);
    let envelope;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 6 * 1024 * 1024) throw new Error();
      envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw failure(
        'SOFTWARE_HANDLE_INVALID',
        'This software selection expired or is unavailable. Discover it again.',
      );
    }
    if (typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string')
      throw failure('SOFTWARE_RECORD_INVALID', 'Software selection integrity failed.');
    const expected = createHmac('sha256', this.key).update(envelope.payload).digest(),
      supplied = Buffer.from(envelope.mac, 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
      throw failure(
        'SOFTWARE_RECORD_INVALID',
        'Software selection integrity failed. No installer was run.',
      );
    const record = JSON.parse(envelope.payload);
    if (
      record.schemaVersion !== 1 ||
      record.id !== id ||
      record.kind !== kind ||
      record.owner !== owner ||
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= this.now()
    )
      throw failure(
        'SOFTWARE_HANDLE_INVALID',
        'This software selection does not belong to this account or has expired.',
      );
    return structuredClone(record.data);
  }
  update(kind, scope, id, data, options = {}) {
    this.get(kind, scope, id);
    return this.put(kind, scope, data, { id, ...options });
  }
  list(kind, scope) {
    const records = [];
    for (const name of fs
      .readdirSync(this.directory)
      .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))) {
      try {
        records.push({ id: name.slice(0, -5), data: this.get(kind, scope, name.slice(0, -5)) });
      } catch {
        /* Unowned, expired or invalid records confer no authority. */
      }
    }
    return records;
  }
  sealSecret(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      bytes: bytes.toString('base64'),
    };
  }
  openSecret(value) {
    if (!value) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.bytes, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
