import fs from 'node:fs';
import path from 'node:path';
import { explorerError } from './errors.js';

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

export const isInside = (root, target, { caseInsensitive, pathImpl = path } = {}) => {
  const fold = (value) => (caseInsensitive ? value.toLowerCase() : value);
  const base = fold(root).replace(/[\\/]+$/, '');
  const candidate = fold(target);
  return (
    candidate === base || candidate.startsWith(base + pathImpl.sep) || fold(root) === candidate
  );
};

/**
 * Per-user (execution scope) approved scan roots. A root is only ever added by backend code
 * that has just consumed a server-issued approval; the model and renderer cannot add one.
 * Entries expire and are persisted atomically with owner-only permissions.
 */
export class ApprovedRoots {
  #data = new Map();
  constructor({
    file = null,
    now = Date.now,
    caseInsensitive = process.platform === 'win32',
    pathImpl = path,
    maxRootsPerScope = 32,
  } = {}) {
    Object.assign(this, { file, now, caseInsensitive, pathImpl, maxRootsPerScope });
    this.#load();
  }
  #load() {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [scope, list] of Object.entries(parsed || {}))
        if (Array.isArray(list))
          this.#data.set(
            scope,
            list.filter(
              (item) =>
                typeof item?.root === 'string' &&
                Number.isFinite(item.expiresAt) &&
                Number.isFinite(item.approvedAt),
            ),
          );
    } catch {
      /* first run or unreadable file: start with no approvals (fail closed) */
    }
  }
  #save() {
    if (!this.file) return;
    fs.mkdirSync(this.pathImpl.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.#data)), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  #live(scope) {
    const current = (this.#data.get(scope) || []).filter((item) => item.expiresAt > this.now());
    if (current.length !== (this.#data.get(scope) || []).length) {
      this.#data.set(scope, current);
      this.#save();
    }
    return current;
  }
  list(scope) {
    return this.#live(scope).map((item) => ({ ...item }));
  }
  /** Returns the approved root that contains `target`, or null. */
  find(scope, target) {
    const options = { caseInsensitive: this.caseInsensitive, pathImpl: this.pathImpl };
    return this.#live(scope).find((item) => isInside(item.root, target, options))?.root ?? null;
  }
  add(scope, root, { ttlMs = DEFAULT_TTL_MS } = {}) {
    if (typeof scope !== 'string' || !scope) throw explorerError('AUTH_CONTEXT_REQUIRED');
    const live = this.#live(scope);
    if (live.length >= this.maxRootsPerScope && !live.some((item) => item.root === root))
      throw explorerError('TOO_MANY_ROOTS', 'Revoke an approved location before adding another.');
    const ttl = Math.min(Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS), MAX_TTL_MS);
    const entry = { root, approvedAt: this.now(), expiresAt: this.now() + ttl };
    this.#data.set(scope, [...live.filter((item) => item.root !== root), entry]);
    this.#save();
    return { ...entry };
  }
  revoke(scope, root) {
    const before = this.#live(scope);
    const after = before.filter((item) => item.root !== root);
    this.#data.set(scope, after);
    this.#save();
    return before.length - after.length;
  }
}
