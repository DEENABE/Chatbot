import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const helper = fileURLToPath(new URL('./WindowsWorkspaceGuard.cs', import.meta.url));
const helperSource = readFileSync(helper);
const helperDigest = createHash('sha256').update(helperSource).digest('hex');
const applicationRoots = [fileURLToPath(new URL('../../', import.meta.url)), fileURLToPath(new URL('../../../frontend/', import.meta.url))];
const MAX_BYTES = 1024 * 1024;
const forbidden = /^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.codex|\.agents|\.chanakya-.*|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|vault(?:\..*)?|id_rsa|id_ed25519)$|\.(?:pem|key|pfx|p12|kdbx)$/i;
export const workspaceError = (code, message) => Object.assign(new Error(message), {
  code,
  status: ['WORKSPACE_PATH_DENIED', 'PROTECTED_FILE'].includes(code) ? 403 : code === 'FILE_NOT_FOUND' ? 404 : ['FILE_CONFLICT', 'ISOLATION_UNAVAILABLE', 'FILE_VERSION_REQUIRED', 'CHECKPOINT_CONFLICT'].includes(code) ? 409 : 400,
});
export const fileVersion = (content) => createHash('sha256').update(content).digest('hex');

// Validate independently at both boundaries; repository text never supplies roots or authority.
export function relativeWorkspacePath(value, { allowEmpty = false } = {}) {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    (!value && !allowEmpty) ||
    /^[\\/]/.test(value) ||
    /[\x00-\x1f:<>"|?*]/.test(value)
  )
    throw workspaceError('WORKSPACE_PATH_DENIED', 'Use a relative path inside the authorized workspace.');
  const normalized = value.replace(/\\/g, '/');
  if (!normalized && allowEmpty) return '';
  for (const part of normalized.split('/')) {
    if (
      !part ||
      ['.', '..'].includes(part) ||
      /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
      throw workspaceError('WORKSPACE_PATH_DENIED', 'Path traversal and Windows path aliases are blocked.');
    if (forbidden.test(part))
      throw workspaceError('PROTECTED_FILE', 'Credential and application-control files are protected.');
  }
  return normalized;
}
function text(bytes) {
  if (bytes.includes(0)) throw workspaceError('BINARY_FILE', 'This tool reads and edits UTF-8 text files.');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw workspaceError('BINARY_FILE', 'This file does not contain valid UTF-8 source text.');
  }
}
export function sourceDiff(name, before, after) {
  const oldLines = String(before ?? '').split(/\r?\n/), newLines = String(after ?? '').split(/\r?\n/);
  if (before === after) return '';
  let first = 0;
  while (first < Math.min(oldLines.length, newLines.length) && oldLines[first] === newLines[first]) first++;
  let suffix = 0;
  while (suffix < Math.min(oldLines.length, newLines.length) - first && oldLines.at(-suffix - 1) === newLines.at(-suffix - 1)) suffix++;
  const start = Math.max(0, first - 3), endOld = Math.min(oldLines.length, oldLines.length - suffix + 3), endNew = Math.min(newLines.length, newLines.length - suffix + 3);
  const lines = [
    `--- ${before === null ? '/dev/null' : `a/${name}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${name}`}`,
    `@@ -${start + 1},${endOld - start} +${start + 1},${endNew - start} @@`,
    ...oldLines.slice(start, first).map((line) => ` ${line}`),
    ...oldLines.slice(first, oldLines.length - suffix).map((line) => `-${line}`),
    ...newLines.slice(first, newLines.length - suffix).map((line) => `+${line}`),
    ...oldLines.slice(oldLines.length - suffix, endOld).map((line) => ` ${line}`),
  ];
  const diff = lines.join('\n');
  return diff.length > 65536 ? `${diff.slice(0, 65536)}\n[Diff preview truncated]` : diff;
}

// The fixed PowerShell bootstrap compiles only the application-owned native helper.
// stdin carries data; no project command, interpolation, profile or network call is used.
const bootstrap = String.raw`$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CHANAKYA_CODING_GUARD_SOURCE))) -ReferencedAssemblies @('System.Web.Extensions.dll');[ChanakyaCoding.WindowsWorkspaceGuard]::Run([Console]::In.ReadToEnd())`;
async function validateHelper() {
  const stat = await fs.lstat(helper);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw workspaceError('ISOLATION_UNAVAILABLE', 'The native workspace helper has an unsafe identity.');
  const digest = fileVersion(await fs.readFile(helper));
  if (digest !== helperDigest)
    throw workspaceError('HELPER_INTEGRITY_FAILED', 'The native workspace helper changed while the backend was running.');
}
export async function windowsWorkspaceOperation(request, { signal, timeoutMs = 30000 } = {}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32')
    throw workspaceError('ISOLATION_UNAVAILABLE', 'Guarded filesystem operations require the Windows native helper.');
  await validateHelper();
  const windows = process.env.SystemRoot;
  if (!windows || !path.win32.isAbsolute(windows))
    throw workspaceError('ISOLATION_UNAVAILABLE', 'The trusted Windows runtime path is unavailable.');
  const executable = path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    let out = '', err = '', bytes = 0, stopped, finished = false;
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', bootstrap], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        SystemRoot: windows,
        WINDIR: windows,
        TEMP: process.env.TEMP || path.win32.join(windows, 'Temp'),
        TMP: process.env.TMP || path.win32.join(windows, 'Temp'),
        PSModulePath: path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        CHANAKYA_CODING_GUARD_SOURCE: helperSource.toString('base64'),
      },
    });
    const stop = (failure) => { stopped = failure; child.kill(); };
    const abort = () => stop(signal.reason || workspaceError('CANCELLED', 'The workspace operation was cancelled.'));
    const timer = setTimeout(() => stop(workspaceError('WORKSPACE_TIMEOUT', 'The guarded workspace operation timed out.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (failure, value) => {
      if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      failure ? reject(failure) : resolve(value);
    };
    for (const [stream, stderr] of [[child.stdout, false], [child.stderr, true]])
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4 * MAX_BYTES) { stop(workspaceError('OUTPUT_LIMIT', 'The workspace result exceeded its output limit.')); return; }
        if (stderr) err += chunk.toString('utf8'); else out += chunk.toString('utf8');
      });
    child.once('error', (failure) => finish(failure));
    child.once('close', (code) => {
      if (stopped) return finish(stopped);
      if (code !== 0) return finish(workspaceError('ISOLATION_UNAVAILABLE', `The fixed native workspace helper could not run: ${err.slice(0, 800) || `exit ${code}`}`));
      try {
        const result = JSON.parse(out.replace(/^\uFEFF/, '').trim());
        if (result.success !== true) return finish(workspaceError(result.error?.code || 'WORKSPACE_IO_FAILED', result.error?.message || 'The native operation failed.'));
        finish(null, result.data);
      } catch { finish(workspaceError('INVALID_HELPER_RESULT', 'The native workspace helper returned invalid evidence.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request), 'utf8');
    if (signal?.aborted) abort();
  });
}

export class WorkspaceFiles {
  constructor({ root, checkpointDirectory, protectedRoots = [], signal, guard = windowsWorkspaceOperation, onMutation } = {}) {
    if (typeof root !== 'string' || !root || !path.isAbsolute(root))
      throw workspaceError('WORKSPACE_REQUIRED', 'An explicitly authorized workspace root is required.');
    Object.assign(this, { root, checkpointDirectory, signal, guard, onMutation });
    this.protectedRoots = [...applicationRoots, ...protectedRoots, ...(checkpointDirectory ? [checkpointDirectory] : [])].map((value) => path.resolve(value));
    this.rootBinding = fileVersion(process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root));
    this.originals = new Map();
    this.changes = new Map();
  }
  async operate(operation, params = {}, { signal = this.signal } = {}) {
    signal?.throwIfAborted();
    const target = path.resolve(this.root, params.path || '');
    if (this.protectedRoots.some((protectedRoot) => {
      const relative = path.relative(protectedRoot, target);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    })) throw workspaceError('PROTECTED_FILE', 'This application\'s runtime, approval and checkpoint storage cannot be accessed through coding tools.');
    return this.guard({ ...params, root: this.root, protectedRoots: this.protectedRoots, operation }, { signal });
  }
  inspect(params = {}) { return this.operate('inspect', {}, params); }
  list({ path: name = '', recursive = false, maxEntries = 1000 } = {}, options) {
    return this.operate('list', { path: relativeWorkspacePath(name, { allowEmpty: true }), recursive, maxEntries: Math.min(5000, Math.max(1, maxEntries)) }, options);
  }
  async read({ path: name, startLine, endLine }, options) {
    name = relativeWorkspacePath(name);
    const result = await this.operate('read', { path: name }, options);
    const content = text(Buffer.from(result.contentBase64, 'base64'));
    if (!this.originals.has(name)) this.originals.set(name, content);
    if (startLine !== undefined || endLine !== undefined) {
      const start = startLine ?? 1, end = endLine ?? start + 199;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 2000)
        throw workspaceError('INVALID_LINE_RANGE', 'Read a line range of at most 2001 lines.');
      const lines = content.split(/\r?\n/);
      return { path: name, content: lines.slice(start - 1, end).join('\n'), version: result.version, size: result.size, startLine: start, endLine: Math.min(end, lines.length), totalLines: lines.length, truncated: start > 1 || end < lines.length };
    }
    return { path: name, content, version: result.version, size: result.size };
  }
  async mkdir({ path: name }, options) {
    name = relativeWorkspacePath(name);
    const result = await this.operate('mkdir', { path: name }, options);
    for (const checkpoint of await this.loadCheckpoints()) {
      checkpoint.directories = [...new Set([...checkpoint.directories, ...(result.createdDirectories || [])])];
      await this.saveCheckpoint(checkpoint);
    }
    return result;
  }
  async write({ path: name, content, expectedVersion }, options) {
    name = relativeWorkspacePath(name);
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES || content.includes('\0'))
      throw workspaceError('INVALID_CONTENT', 'Provide UTF-8 source text up to 1 MiB.');
    if (expectedVersion !== 'new' && !/^[a-f0-9]{64}$/.test(expectedVersion || ''))
      throw workspaceError('FILE_VERSION_REQUIRED', 'Read the current file version before replacing it, or use new for a new file.');
    const prior = expectedVersion === 'new' ? null : await this.read({ path: name }, options);
    if (prior && prior.version !== expectedVersion) throw workspaceError('FILE_CONFLICT', 'The file changed after inspection.');
    await this.journalMutation({ path: name, before: prior?.content ?? null, beforeVersion: expectedVersion, version: fileVersion(content) });
    const result = await this.operate('write', { path: name, content, expectedVersion }, options);
    const before = result.beforeContentBase64 === null ? null : text(Buffer.from(result.beforeContentBase64, 'base64'));
    if (!this.originals.has(name)) this.originals.set(name, before);
    this.changes.set(name, { before: this.originals.get(name), after: content, version: result.version });
    await this.onMutation?.({ path: name, before, after: content, beforeVersion: result.beforeVersion, version: result.version });
    await this.commitMutation(name, result.version);
    return { path: name, beforeVersion: result.beforeVersion, version: result.version, diff: sourceDiff(name, before, content), changed: result.changed, size: result.size };
  }
  async patch({ path: name, search, replace, expectedVersion, preview = false }, options) {
    if (typeof search !== 'string' || !search || typeof replace !== 'string')
      throw workspaceError('INVALID_PATCH', 'An exact nonempty search and replacement text are required.');
    const file = await this.read({ path: name }, options);
    if (file.version !== expectedVersion) throw workspaceError('FILE_CONFLICT', 'The file changed after inspection.');
    const first = file.content.indexOf(search);
    if (first < 0 || file.content.indexOf(search, first + search.length) >= 0)
      throw workspaceError('PATCH_NOT_UNIQUE', 'The patch search must match exactly one location.');
    const content = file.content.slice(0, first) + replace + file.content.slice(first + search.length);
    if (preview) return { path: file.path, beforeVersion: file.version, version: fileVersion(content), diff: sourceDiff(file.path, file.content, content), preview: true, changed: false };
    return this.write({ path: file.path, content, expectedVersion }, options);
  }
  async remove({ path: name, expectedVersion }, options) {
    name = relativeWorkspacePath(name);
    if (!/^[a-f0-9]{64}$/.test(expectedVersion || '')) throw workspaceError('FILE_VERSION_REQUIRED', 'Deletion requires the inspected file version.');
    const prior = await this.read({ path: name }, options);
    if (prior.version !== expectedVersion) throw workspaceError('FILE_CONFLICT', 'The file changed after inspection.');
    await this.journalMutation({ path: name, before: prior.content, beforeVersion: expectedVersion, version: 'new' });
    const result = await this.operate('remove', { path: name, expectedVersion }, options);
    const before = text(Buffer.from(result.beforeContentBase64, 'base64'));
    if (!this.originals.has(name)) this.originals.set(name, before);
    this.changes.set(name, { before: this.originals.get(name), after: null, version: 'new' });
    await this.onMutation?.({ path: name, before, after: null, beforeVersion: expectedVersion, version: 'new' });
    await this.commitMutation(name, 'new');
    return { path: name, beforeVersion: expectedVersion, version: 'new', diff: sourceDiff(name, before, null), deleted: true, changed: true };
  }
  async search({ query, path: directory = '', maxResults = 50, caseSensitive = false } = {}, options) {
    if (typeof query !== 'string' || !query || query.length > 200) throw workspaceError('INVALID_SEARCH', 'Search text must contain 1 to 200 characters.');
    const scan = await this.list({ path: directory, recursive: true, maxEntries: 5000 }, options), results = [];
    let bytes = 0, files = 0, truncated = scan.truncated;
    const errors = [...scan.errors];
    for (const entry of scan.entries.filter((item) => item.type === 'file')) {
      options?.signal?.throwIfAborted(); this.signal?.throwIfAborted();
      if (++files > 200 || bytes + entry.size > 4 * MAX_BYTES || results.length >= Math.min(100, maxResults)) { truncated = true; break; }
      try {
        const file = await this.read({ path: entry.path }, options); bytes += file.size;
        const needle = caseSensitive ? query : query.toLowerCase();
        for (const [index, line] of file.content.split(/\r?\n/).entries()) {
          if ((caseSensitive ? line : line.toLowerCase()).includes(needle)) results.push({ path: file.path, line: index + 1, text: line.slice(0, 400), version: file.version });
          if (results.length >= Math.min(100, maxResults)) { truncated = true; break; }
        }
      } catch (failure) { if (options?.signal?.aborted || this.signal?.aborted) throw failure; errors.push({ path: entry.path, code: failure.code, message: failure.message }); }
    }
    return { results, errors, truncated, inspectedFiles: files, bytes };
  }
  async symbols({ path: name }, options) {
    const file = await this.read({ path: name }, options), symbols = [];
    for (const [index, line] of file.content.split(/\r?\n/).entries()) {
      const match = line.match(/^\s*(?:(?:export|public|private|protected|static|async|abstract|final)\s+)*(class|interface|function|def|struct|enum|trait|fn|func)\s+([\p{L}_][\p{L}\p{N}_]*)/u);
      if (match) symbols.push({ name: match[2], kind: match[1], line: index + 1 });
      if (symbols.length >= 200) break;
    }
    return { path: file.path, version: file.version, symbols, method: 'text_declaration_scan' };
  }
  diff({ path: name } = {}) {
    if (name) name = relativeWorkspacePath(name);
    return { files: [...this.changes].filter(([key]) => !name || key === name).map(([key, value]) => ({ path: key, version: value.version, diff: sourceDiff(key, value.before, value.after) })) };
  }
  async checkpointStorage() {
    if (!this.checkpointDirectory) return null;
    if (!path.isAbsolute(this.checkpointDirectory)) throw workspaceError('CHECKPOINT_STORAGE_INVALID', 'Checkpoint storage must be application-owned.');
    await fs.mkdir(this.checkpointDirectory, { recursive: true, mode: 0o700 });
    let current = path.parse(this.checkpointDirectory).root;
    for (const part of path.resolve(this.checkpointDirectory).slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink()) throw workspaceError('CHECKPOINT_STORAGE_INVALID', 'Checkpoint storage cannot pass through a link.');
    }
    return this.checkpointDirectory;
  }
  async loadCheckpoints() {
    const directory = await this.checkpointStorage();
    if (!directory) return [];
    const names = (await fs.readdir(directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
    const checkpoints = [];
    for (const name of names.slice(0, 30)) {
      const file = path.join(directory, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * MAX_BYTES)
        throw workspaceError('CHECKPOINT_STORAGE_INVALID', 'A checkpoint has an unsafe identity or exceeded its size limit.');
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value.rootBinding !== this.rootBinding) continue;
      if (value.schemaVersion !== 1 || `${value.checkpointId}.json` !== name || !value.files || typeof value.files !== 'object' || !Array.isArray(value.directories))
        throw workspaceError('CHECKPOINT_STORAGE_INVALID', 'The checkpoint manifest is invalid.');
      for (const [name, record] of Object.entries(value.files)) {
        relativeWorkspacePath(name);
        if ((record.before !== null && typeof record.before !== 'string') || (record.beforeVersion !== 'new' && fileVersion(record.before ?? '') !== record.beforeVersion) || (record.expectedVersion !== 'new' && !/^[a-f0-9]{64}$/.test(record.expectedVersion)))
          throw workspaceError('CHECKPOINT_STORAGE_INVALID', 'The checkpoint contents failed validation.');
      }
      value.directories.forEach((name) => relativeWorkspacePath(name));
      checkpoints.push(value);
    }
    return checkpoints.filter((value) => value.status === 'active');
  }
  async saveCheckpoint(value) {
    const directory = await this.checkpointStorage();
    if (!directory) return;
    const contents = JSON.stringify(value);
    if (Buffer.byteLength(contents) > 8 * MAX_BYTES || Object.keys(value.files).length > 200)
      throw workspaceError('CHECKPOINT_LIMIT', 'The coding checkpoint limit is 200 changed files and 8 MiB.');
    const file = path.join(directory, `${value.checkpointId}.json`), temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, file); } catch (failure) { await fs.rm(temporary, { force: true }); throw failure; }
  }
  async checkpoint({ label = 'Before coding changes' } = {}) {
    if (!this.checkpointDirectory) throw workspaceError('CHECKPOINT_STORAGE_UNAVAILABLE', 'Protected checkpoint storage is unavailable.');
    await this.inspect();
    const known = await this.loadCheckpoints();
    if (known.length >= 20) throw workspaceError('CHECKPOINT_LIMIT', 'At most 20 active workspace checkpoints are supported.');
    const value = { schemaVersion: 1, checkpointId: randomUUID(), rootBinding: this.rootBinding, createdAt: new Date().toISOString(), label: String(label).slice(0, 120), status: 'active', files: {}, directories: [] };
    await this.saveCheckpoint(value);
    return { checkpointId: value.checkpointId, createdAt: value.createdAt, label: value.label, kind: 'agent_change_journal', message: 'Files changed through the coding agent are backed up before each mutation. External edits are preserved.' };
  }
  async checkpoints() {
    return { checkpoints: (await this.loadCheckpoints()).map(({ checkpointId, createdAt, label, files, directories }) => ({ checkpointId, createdAt, label, changedFiles: Object.keys(files).length, createdDirectories: directories.length, kind: 'agent_change_journal' })) };
  }
  async journalMutation({ path: name, before, beforeVersion, version }) {
    for (const checkpoint of await this.loadCheckpoints()) {
      const previous = checkpoint.files[name];
      if (previous && previous.expectedVersion !== beforeVersion && !(previous.pending && previous.pending.beforeVersion === beforeVersion))
        throw workspaceError('CHECKPOINT_CONFLICT', 'This file was edited outside the coding agent after the checkpoint. Create a fresh checkpoint before changing it.');
      checkpoint.files[name] = { ...(previous || { before, beforeVersion }), expectedVersion: version, pending: { beforeVersion, intendedVersion: version } };
      await this.saveCheckpoint(checkpoint);
    }
  }
  async commitMutation(name, version) {
    for (const checkpoint of await this.loadCheckpoints()) {
      if (checkpoint.files[name]) { checkpoint.files[name].expectedVersion = version; delete checkpoint.files[name].pending; await this.saveCheckpoint(checkpoint); }
    }
  }
  async restore({ checkpointId, preview = false } = {}, options) {
    if (!/^[a-f0-9-]{36}$/.test(checkpointId || '')) throw workspaceError('CHECKPOINT_NOT_FOUND', 'Choose an owned workspace checkpoint.');
    const checkpoint = (await this.loadCheckpoints()).find((value) => value.checkpointId === checkpointId);
    if (!checkpoint) throw workspaceError('CHECKPOINT_NOT_FOUND', 'This checkpoint does not belong to the authorized workspace.');
    const actions = [];
    for (const [name, record] of Object.entries(checkpoint.files)) {
      let current = null;
      try { current = await this.read({ path: name }, options); } catch (failure) { if (failure.code !== 'FILE_NOT_FOUND') throw failure; }
      const version = current?.version ?? 'new';
      if (version !== record.expectedVersion && (!record.pending || version !== record.pending.beforeVersion))
        throw workspaceError('CHECKPOINT_CONFLICT', `Rollback would overwrite an external edit to ${name}. No files were restored.`);
      actions.push({ path: name, before: current?.content ?? null, after: record.before, expectedVersion: version, diff: sourceDiff(name, current?.content ?? null, record.before) });
    }
    if (preview) return { checkpointId, preview: true, changed: false, files: actions.map(({ path, diff }) => ({ path, diff })) };
    const restored = [];
    // All versions are checked before the first change and checked again natively per mutation.
    for (const action of actions) {
      if (action.before === action.after) continue;
      if (action.after === null) await this.operate('remove', { path: action.path, expectedVersion: action.expectedVersion }, options);
      else await this.operate('write', { path: action.path, content: action.after, expectedVersion: action.expectedVersion }, options);
      restored.push({ path: action.path, version: action.after === null ? 'new' : fileVersion(action.after), diff: action.diff });
    }
    const retainedDirectories = [];
    for (const name of [...checkpoint.directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
      try { await this.operate('remove-empty-directory', { path: name }, options); }
      catch (failure) { if (failure.code !== 'FILE_NOT_FOUND') retainedDirectories.push({ path: name, reason: failure.message }); }
    }
    checkpoint.status = 'restored'; checkpoint.restoredAt = new Date().toISOString(); await this.saveCheckpoint(checkpoint);
    this.originals.clear(); this.changes.clear();
    return { checkpointId, restored: true, changed: restored.length > 0, files: restored, retainedDirectories };
  }
}
