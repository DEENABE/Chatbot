import fs from 'node:fs/promises';
import path from 'node:path';
import { explorerError, humanSize, throwIfAborted } from './errors.js';

const MAX_PAGE = 500;
const MAX_SORT_ENTRIES = 20000;
const STAT_CONCURRENCY = 16;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

const ext = (name) => {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
};
const kind = (entry) =>
  entry.isSymbolicLink()
    ? 'link'
    : entry.isDirectory()
      ? 'directory'
      : entry.isFile()
        ? 'file'
        : 'other';

/** Map in bounded batches so a huge directory cannot open thousands of handles at once. */
async function mapLimited(items, limit, fn, signal) {
  const out = new Array(items.length);
  for (let index = 0; index < items.length; index += limit) {
    throwIfAborted(signal);
    const batch = items.slice(index, index + limit);
    const results = await Promise.all(batch.map((item, offset) => fn(item, index + offset)));
    results.forEach((value, offset) => (out[index + offset] = value));
  }
  return out;
}

/** Name filter: plain text is a substring match; * and ? are wildcards (bounded, no backtracking). */
export function nameMatcher(pattern) {
  if (pattern === undefined || pattern === '') return () => true;
  if (typeof pattern !== 'string' || pattern.length > 128)
    throw explorerError('INVALID_PATTERN', 'The name pattern must be 1-128 characters.');
  if (!/[*?]/.test(pattern)) {
    const needle = pattern.toLowerCase();
    return (name) => name.toLowerCase().includes(needle);
  }
  if ((pattern.match(/\*/g) || []).length > 4)
    throw explorerError('INVALID_PATTERN', 'Use at most 4 wildcards.');
  const source = pattern
    .toLowerCase()
    .split('')
    .map((c) => (c === '*' ? '[^]*' : c === '?' ? '[^]' : c.replace(/[.+^${}()|[\]\\/-]/g, '\\$&')))
    .join('');
  const regex = new RegExp(`^${source}$`);
  return (name) => regex.test(name.toLowerCase());
}

/** Filesystem operations over already-authorised paths. Callers resolve paths through ExplorerPathGuard first. */
export class ExplorerOps {
  constructor({ guard, fsImpl = fs, pathImpl = path } = {}) {
    Object.assign(this, { guard, fsImpl, pathImpl });
  }
  #info(directory, name, stat, kindOverride) {
    const full = this.pathImpl.join(directory, name);
    const type = kindOverride || kind(stat);
    return {
      name,
      path: full,
      type,
      extension: type === 'file' ? ext(name) : '',
      sizeBytes: type === 'file' ? stat.size : null,
      size: type === 'file' ? humanSize(stat.size) : null,
      created: stat.birthtime?.toISOString?.() ?? null,
      modified: stat.mtime?.toISOString?.() ?? null,
      protected: this.guard.isProtected(full) || undefined,
    };
  }
  async #stat(directory, dirent) {
    try {
      const stat = await this.fsImpl.lstat(this.pathImpl.join(directory, dirent.name));
      return { entry: this.#info(directory, dirent.name, stat, kind(dirent)) };
    } catch (error) {
      return { skipped: { name: dirent.name, error: error.code || 'STAT_FAILED' } };
    }
  }

  async listDirectory(
    { path: directory },
    { offset = 0, limit = 100, sortBy = 'name', order = 'asc', signal } = {},
  ) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1)
      throw explorerError('INVALID_ARGUMENT', 'offset must be >= 0 and limit >= 1.');
    limit = Math.min(limit, MAX_PAGE);
    throwIfAborted(signal);
    let dirents;
    try {
      dirents = await this.fsImpl.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, directory);
    }
    const counts = { files: 0, directories: 0, links: 0, other: 0 };
    for (const dirent of dirents) {
      const type = kind(dirent);
      counts[
        type === 'file'
          ? 'files'
          : type === 'directory'
            ? 'directories'
            : type === 'link'
              ? 'links'
              : 'other'
      ]++;
    }
    const direction = order === 'desc' ? -1 : 1;
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    let sortNote;
    let page;
    const skipped = [];
    if (sortBy === 'name') {
      const sorted = [...dirents].sort((a, b) => direction * byName(a, b));
      page = sorted.slice(offset, offset + limit);
      const stats = await mapLimited(
        page,
        STAT_CONCURRENCY,
        (d) => this.#stat(directory, d),
        signal,
      );
      page = stats.flatMap((s) => (s.entry ? [s.entry] : (skipped.push(s.skipped), [])));
    } else if (['size', 'modified'].includes(sortBy)) {
      let pool = dirents;
      if (pool.length > MAX_SORT_ENTRIES) {
        pool = pool.slice(0, MAX_SORT_ENTRIES);
        sortNote = `Sorted only the first ${MAX_SORT_ENTRIES} of ${dirents.length} entries.`;
      }
      const stats = await mapLimited(
        pool,
        STAT_CONCURRENCY,
        (d) => this.#stat(directory, d),
        signal,
      );
      const all = stats.flatMap((s) => (s.entry ? [s.entry] : (skipped.push(s.skipped), [])));
      all.sort((a, b) =>
        sortBy === 'size'
          ? direction * ((a.sizeBytes ?? -1) - (b.sizeBytes ?? -1)) || byName(a, b)
          : direction * String(a.modified).localeCompare(String(b.modified)) || byName(a, b),
      );
      page = all.slice(offset, offset + limit);
    } else throw explorerError('INVALID_ARGUMENT', 'sortBy must be name, size or modified.');
    const total = dirents.length;
    return {
      path: directory,
      scope: 'direct-children',
      total,
      offset,
      limit,
      returned: page.length,
      nextOffset: offset + limit < total ? offset + limit : null,
      counts,
      entries: page,
      skipped,
      ...(sortNote ? { note: sortNote } : {}),
    };
  }

  async getFileMetadata({ path: target }, { signal } = {}) {
    throwIfAborted(signal);
    let stat;
    try {
      stat = await this.fsImpl.lstat(target);
    } catch (error) {
      throw mapFsError(error, target);
    }
    const base = this.#info(this.pathImpl.dirname(target), this.pathImpl.basename(target), stat);
    if (base.type !== 'directory') return base;
    let counts = null;
    try {
      const dirents = await this.fsImpl.readdir(target, { withFileTypes: true });
      counts = { files: 0, directories: 0, links: 0, other: 0, scope: 'direct-children' };
      for (const dirent of dirents) {
        const type = kind(dirent);
        counts[
          type === 'file'
            ? 'files'
            : type === 'directory'
              ? 'directories'
              : type === 'link'
                ? 'links'
                : 'other'
        ]++;
      }
    } catch (error) {
      counts = { error: error.code || 'UNREADABLE' };
    }
    return { ...base, counts };
  }

  /**
   * Recursive size. Never follows links, skips protected trees, and stops cleanly at a cap, a
   * deadline or cancellation, reporting exactly why the total may be incomplete.
   */
  async calculateFolderSize(
    { path: root },
    {
      breakdown = false,
      maxEntries = 200000,
      maxDepth = 64,
      deadlineMs = 60000,
      signal,
      onProgress,
      now = Date.now,
    } = {},
  ) {
    const started = now();
    const totals = { files: 0, directories: 0, bytes: 0, links: 0 };
    const buckets = new Map();
    const skipped = [];
    let visited = 0;
    let stoppedBy = null;
    const stack = [{ dir: root, depth: 0, bucket: null }];
    const note = (name, error) => skipped.length < 100 && skipped.push({ path: name, error });
    while (stack.length && !stoppedBy) {
      const { dir, depth, bucket } = stack.pop();
      if (signal?.aborted) {
        stoppedBy = 'cancelled';
        break;
      }
      if (now() - started > deadlineMs) {
        stoppedBy = 'timeout';
        break;
      }
      let dirents;
      try {
        dirents = await this.fsImpl.readdir(dir, { withFileTypes: true });
      } catch (error) {
        note(dir, error.code || 'UNREADABLE');
        continue;
      }
      totals.directories++;
      const stats = await mapLimited(
        dirents,
        STAT_CONCURRENCY,
        async (dirent) => {
          const full = this.pathImpl.join(dir, dirent.name);
          const type = kind(dirent);
          if (type === 'directory') return { full, type, dirent };
          if (type !== 'file') return { full, type };
          try {
            return { full, type, size: (await this.fsImpl.lstat(full)).size };
          } catch (error) {
            return { full, type, error: error.code || 'STAT_FAILED' };
          }
        },
        signal,
      );
      for (const item of stats) {
        if (++visited > maxEntries) {
          stoppedBy = 'maxEntries';
          break;
        }
        const childBucket = depth === 0 ? (item.dirent?.name ?? item.full) : bucket;
        if (item.type === 'link') {
          totals.links++;
          note(item.full, 'LINK_NOT_FOLLOWED');
        } else if (item.type === 'directory') {
          if (this.guard.isProtected(item.full)) note(item.full, 'PROTECTED_PATH');
          else if (depth + 1 > maxDepth) note(item.full, 'MAX_DEPTH');
          else stack.push({ dir: item.full, depth: depth + 1, bucket: childBucket });
        } else if (item.type === 'file') {
          if (item.error) note(item.full, item.error);
          else {
            totals.files++;
            totals.bytes += item.size;
            if (breakdown) {
              const key = depth === 0 ? '(files in this folder)' : childBucket;
              const entry = buckets.get(key) || { name: key, bytes: 0, files: 0 };
              entry.bytes += item.size;
              entry.files++;
              buckets.set(key, entry);
            }
          }
        }
      }
      if (visited % 500 < dirents.length) onProgress?.({ visited, bytes: totals.bytes });
      if (stack.length % 8 === 0) await yieldToLoop();
    }
    const result = {
      path: root,
      scope: 'recursive',
      complete: stoppedBy === null,
      ...(stoppedBy ? { stoppedBy } : {}),
      totalBytes: totals.bytes,
      total: humanSize(totals.bytes),
      files: totals.files,
      directories: totals.directories,
      linksSkipped: totals.links,
      elapsedMs: now() - started,
      skipped,
    };
    if (breakdown)
      result.largestChildren = [...buckets.values()]
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 50)
        .map((entry) => ({ ...entry, size: humanSize(entry.bytes) }));
    return result;
  }

  /** Breadth-first search across one or more already-approved roots. */
  async searchFiles(
    { roots },
    {
      query,
      extensions,
      type = 'file',
      minSizeBytes,
      maxSizeBytes,
      modifiedAfter,
      sortBy = 'none',
      maxResults = 100,
      maxVisited = 200000,
      deadlineMs = 60000,
      maxDepth = 32,
      signal,
      now = Date.now,
    } = {},
  ) {
    const match = nameMatcher(query);
    const wanted = Array.isArray(extensions)
      ? new Set(extensions.map((e) => String(e).replace(/^\./, '').toLowerCase()))
      : null;
    const after = modifiedAfter ? Date.parse(modifiedAfter) : null;
    if (modifiedAfter && !Number.isFinite(after))
      throw explorerError('INVALID_ARGUMENT', 'modifiedAfter must be an ISO date.');
    maxResults = Math.min(Math.max(1, maxResults), 1000);
    const started = now();
    const results = [];
    const skipped = [];
    let visited = 0;
    let stoppedBy = null;
    const queue = roots.map((dir) => ({ dir, depth: 0 }));
    const keep = (entry) => {
      results.push(entry);
      if (sortBy === 'size' && results.length > maxResults * 2) {
        results.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
        results.length = maxResults;
      }
    };
    for (let head = 0; head < queue.length && !stoppedBy; head++) {
      const { dir, depth } = queue[head];
      if (signal?.aborted) stoppedBy = 'cancelled';
      else if (now() - started > deadlineMs) stoppedBy = 'timeout';
      if (stoppedBy) break;
      let dirents;
      try {
        dirents = await this.fsImpl.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (skipped.length < 100) skipped.push({ path: dir, error: error.code || 'UNREADABLE' });
        continue;
      }
      const candidates = [];
      for (const dirent of dirents) {
        if (++visited > maxVisited) {
          stoppedBy = 'maxVisited';
          break;
        }
        const full = this.pathImpl.join(dir, dirent.name);
        const itemType = kind(dirent);
        if (itemType === 'link') continue;
        if (this.guard.isProtected(full)) continue;
        if (itemType === 'directory' && depth + 1 <= maxDepth)
          queue.push({ dir: full, depth: depth + 1 });
        if (type !== 'any' && itemType !== type) continue;
        if (!match(dirent.name)) continue;
        if (wanted && !wanted.has(ext(dirent.name))) continue;
        candidates.push({ dirent, full, itemType });
      }
      await mapLimited(
        candidates,
        STAT_CONCURRENCY,
        async ({ dirent, full, itemType }) => {
          let stat;
          try {
            stat = await this.fsImpl.lstat(full);
          } catch (error) {
            if (skipped.length < 100)
              skipped.push({ path: full, error: error.code || 'STAT_FAILED' });
            return;
          }
          if (itemType === 'file') {
            if (minSizeBytes !== undefined && stat.size < minSizeBytes) return;
            if (maxSizeBytes !== undefined && stat.size > maxSizeBytes) return;
          }
          if (after !== null && !(stat.mtimeMs >= after)) return;
          if (sortBy === 'none' && results.length >= maxResults) return;
          keep(this.#info(dir, dirent.name, stat, itemType));
        },
        signal,
      );
      if (sortBy === 'none' && results.length >= maxResults) {
        stoppedBy = 'maxResults';
      }
      await yieldToLoop();
    }
    if (sortBy === 'size') results.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    const truncated = results.length > maxResults;
    if (truncated) results.length = maxResults;
    return {
      scope: 'recursive',
      roots,
      matches: results.length,
      complete: stoppedBy === null,
      ...(stoppedBy ? { stoppedBy } : {}),
      visited,
      elapsedMs: now() - started,
      results,
      skipped,
    };
  }

  async getDirectoryTree({ path: root }, { maxDepth = 3, maxEntries = 500, signal } = {}) {
    maxDepth = Math.min(Math.max(1, maxDepth), 8);
    maxEntries = Math.min(Math.max(1, maxEntries), 2000);
    let count = 0;
    let truncated = false;
    const skipped = [];
    const build = async (dir, depth) => {
      throwIfAborted(signal);
      let dirents;
      try {
        dirents = await this.fsImpl.readdir(dir, { withFileTypes: true });
      } catch (error) {
        skipped.push({ path: dir, error: error.code || 'UNREADABLE' });
        return [];
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      const children = [];
      for (const dirent of dirents) {
        if (count >= maxEntries) {
          truncated = true;
          break;
        }
        count++;
        const type = kind(dirent);
        const full = this.pathImpl.join(dir, dirent.name);
        const node = { name: dirent.name, type };
        if (this.guard.isProtected(full)) node.protected = true;
        else if (type === 'directory' && depth < maxDepth)
          node.children = await build(full, depth + 1);
        else if (type === 'directory') node.hasMore = true;
        children.push(node);
      }
      return children;
    };
    const tree = {
      name: this.pathImpl.basename(root) || root,
      type: 'directory',
      children: await build(root, 1),
    };
    return { path: root, scope: 'tree', maxDepth, entries: count, truncated, tree, skipped };
  }

  /** Bounded text read. The returned text is untrusted data, never instructions. */
  async readFile({ path: target }, { offset = 0, maxBytes = 65536, signal } = {}) {
    maxBytes = Math.min(Math.max(1, maxBytes), 262144);
    if (!Number.isInteger(offset) || offset < 0)
      throw explorerError('INVALID_ARGUMENT', 'offset must be a non-negative integer.');
    throwIfAborted(signal);
    let before;
    try {
      before = await this.fsImpl.lstat(target);
    } catch (error) {
      throw mapFsError(error, target);
    }
    if (!before.isFile()) throw explorerError('NOT_A_FILE', 'Only regular files can be read.');
    let handle;
    try {
      handle = await this.fsImpl.open(target, 'r');
      const opened = await handle.stat();
      // The handle must be the same regular file that was checked (best effort on Windows).
      if (!opened.isFile() || (opened.ino && before.ino && opened.ino !== before.ino))
        throw explorerError('FILE_CHANGED', 'The file changed while it was being opened.');
      const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(0, opened.size - offset)));
      const { bytesRead } = buffer.length
        ? await handle.read(buffer, 0, buffer.length, offset)
        : { bytesRead: 0 };
      const slice = buffer.subarray(0, bytesRead);
      if (slice.includes(0))
        throw explorerError('BINARY_FILE', 'This looks like a binary file; only text can be read.');
      const end = offset + bytesRead;
      return {
        path: target,
        totalBytes: opened.size,
        offset,
        bytesRead,
        truncated: end < opened.size,
        nextOffset: end < opened.size ? end : null,
        encoding: 'utf8',
        untrusted: true,
        content: slice.toString('utf8'),
      };
    } catch (error) {
      throw error.code && /^[A-Z_]+$/.test(error.code) && !error.errno
        ? error
        : mapFsError(error, target);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}

export function mapFsError(error, target) {
  if (error?.code === 'ENOENT') return explorerError('NOT_FOUND', `"${target}" does not exist.`);
  if (error?.code === 'EACCES' || error?.code === 'EPERM')
    return explorerError('ACCESS_DENIED', `Windows denied access to "${target}".`);
  if (error?.code === 'ENOTDIR')
    return explorerError('NOT_A_DIRECTORY', `"${target}" is not a folder.`);
  if (error?.code === 'EBUSY') return explorerError('BUSY', `"${target}" is in use.`);
  return error?.code && /^[A-Z_]+$/.test(error.code) && !error.errno
    ? error
    : explorerError('FS_ERROR', error?.message || 'Filesystem error');
}
