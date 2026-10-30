import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApprovedRoots } from '../fileexplorer/ApprovedRoots.js';
import { ExplorerPathGuard } from '../fileexplorer/ExplorerPaths.js';
import { DriveService } from '../fileexplorer/DriveService.js';
import { ExplorerOps, nameMatcher } from '../fileexplorer/ExplorerOps.js';
import { ExplorerToolService } from '../fileexplorer/ExplorerToolService.js';
import { executionContext } from '../ExecutionContext.js';

const SCOPE = 'renderer:user-1';
async function workspace(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-test-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}
const write = (file, content = 'x') =>
  fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, content));
function stack(base, { now } = {}) {
  const roots = new ApprovedRoots({ now });
  roots.add(SCOPE, base);
  const guard = new ExplorerPathGuard({ roots });
  return { roots, guard, ops: new ExplorerOps({ guard }) };
}

// ---------------------------------------------------------------- approved roots
test('approved roots: scoped, expiring, revocable, persisted atomically', async (t) => {
  const base = await workspace(t);
  let clock = 1_000_000;
  const file = path.join(base, 'roots.json');
  const roots = new ApprovedRoots({ file, now: () => clock });
  roots.add('a', path.join(base, 'one'), { ttlMs: 120_000 });
  assert.equal(roots.find('a', path.join(base, 'one', 'deep', 'x.txt')), path.join(base, 'one'));
  assert.equal(roots.find('a', path.join(base, 'onetwo')), null, 'prefix match must not count');
  assert.equal(roots.find('b', path.join(base, 'one')), null, 'another scope has no access');
  assert.equal(
    new ApprovedRoots({ file, now: () => clock }).list('a').length,
    1,
    'reloaded from disk',
  );
  clock += 121_000;
  assert.equal(roots.find('a', path.join(base, 'one')), null, 'expired');
  roots.add('a', path.join(base, 'two'));
  assert.equal(roots.revoke('a', path.join(base, 'two')), 1);
  assert.equal(roots.list('a').length, 0);
  assert.throws(() => roots.add('', base), { code: 'AUTH_CONTEXT_REQUIRED' });
});

test('approved roots limit and corrupt file fail closed', async (t) => {
  const base = await workspace(t);
  await fs.writeFile(path.join(base, 'bad.json'), '{not json');
  assert.deepEqual(new ApprovedRoots({ file: path.join(base, 'bad.json') }).list('a'), []);
  const roots = new ApprovedRoots({ maxRootsPerScope: 2 });
  roots.add('a', '/r1');
  roots.add('a', '/r2');
  assert.throws(() => roots.add('a', '/r3'), { code: 'TOO_MANY_ROOTS' });
});

// ---------------------------------------------------------------- path guard
test('windows path syntax: traversal, UNC, devices, streams, reserved names are rejected', () => {
  const guard = new ExplorerPathGuard({
    roots: new ApprovedRoots(),
    pathImpl: path.win32,
    platform: 'win32',
  });
  assert.equal(guard.canonicalize('c:\\Projects\\app'), 'C:\\Projects\\app');
  for (const bad of [
    'relative\\path',
    'C:\\a\\..\\b',
    '\\\\server\\share\\x',
    '\\\\?\\C:\\x',
    'C:\\file.txt:stream',
    'C:\\CON',
    'C:\\a\\nul.txt',
    'C:\\folder.',
    'C:\\a\\b?',
    'C:\\x\u0000y',
    '',
    `C:\\${'a'.repeat(5000)}`,
    42,
  ])
    assert.throws(
      () => guard.canonicalize(bad),
      { code: 'DISALLOWED_PATH' },
      String(bad).slice(0, 30),
    );
});

test('protected locations are classified', () => {
  const guard = new ExplorerPathGuard({
    roots: new ApprovedRoots(),
    pathImpl: path.win32,
    platform: 'win32',
  });
  for (const p of [
    'C:\\Windows\\System32',
    'C:\\Program Files\\App',
    'C:\\ProgramData\\x',
    'C:\\$Recycle.Bin\\s',
  ])
    assert.equal(guard.classify(p), 'system', p);
  for (const p of [
    'C:\\Users\\a\\.ssh\\id_rsa',
    'D:\\proj\\.env',
    'D:\\proj\\.env.local',
    'D:\\k\\cert.pfx',
    'D:\\secrets\\a.txt',
  ])
    assert.equal(guard.classify(p), 'sensitive', p);
  assert.equal(guard.classify('D:\\Projects\\app\\readme.md'), null);
});

test('resolve: only approved roots, per scope, never through links', async (t) => {
  const base = await workspace(t);
  const inside = path.join(base, 'ok');
  const outside = path.join(base, 'outside');
  await write(path.join(inside, 'a.txt'));
  await write(path.join(outside, 'secret.txt'));
  const roots = new ApprovedRoots();
  roots.add(SCOPE, inside);
  const guard = new ExplorerPathGuard({ roots });
  assert.equal(
    (await guard.resolve(SCOPE, path.join(inside, 'a.txt'))).path,
    path.join(inside, 'a.txt'),
  );
  await assert.rejects(guard.resolve(SCOPE, outside), { code: 'ROOT_NOT_APPROVED' });
  await assert.rejects(guard.resolve('renderer:other', inside), { code: 'ROOT_NOT_APPROVED' });
  await assert.rejects(guard.resolve(SCOPE, path.join(inside, '..', 'outside')), {
    code: 'DISALLOWED_PATH',
  });
  await assert.rejects(guard.resolve(SCOPE, 'a.txt'), { code: 'DISALLOWED_PATH' });
  await fs.symlink(outside, path.join(inside, 'escape'), 'dir');
  await assert.rejects(guard.resolve(SCOPE, path.join(inside, 'escape', 'secret.txt')), {
    code: 'LINK_NOT_FOLLOWED',
  });
  await assert.rejects(guard.resolve(SCOPE, path.join(inside, 'missing.txt')), {
    code: 'NOT_FOUND',
  });
  await write(path.join(inside, '.ssh', 'id_rsa'));
  await assert.rejects(guard.resolve(SCOPE, path.join(inside, '.ssh', 'id_rsa')), {
    code: 'PROTECTED_PATH',
  });
});

test('an approved root that is itself a link is refused', async (t) => {
  const base = await workspace(t);
  await write(path.join(base, 'real', 'f.txt'));
  await fs.symlink(path.join(base, 'real'), path.join(base, 'alias'), 'dir');
  const { guard, roots } = stack(base);
  roots.add(SCOPE, path.join(base, 'alias'));
  await assert.rejects(guard.resolve(SCOPE, path.join(base, 'alias', 'f.txt')), {
    code: 'LINK_NOT_FOLLOWED',
  });
});

// ---------------------------------------------------------------- drives
const cim = (value) => async () => ({ stdout: JSON.stringify(value) });

test('drive discovery parses volumes dynamically and never hard-codes letters', async () => {
  const calls = [];
  const service = new DriveService({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    fsImpl: {
      access: async (root) => {
        if (root === 'F:\\') throw Object.assign(new Error('x'), { code: 'ENOENT' });
      },
    },
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: JSON.stringify([
          {
            DeviceID: 'G:',
            VolumeName: 'Backup',
            FileSystem: 'exFAT',
            Size: '2000000000000',
            FreeSpace: '500000000000',
            DriveType: 2,
          },
          {
            DeviceID: 'C:',
            VolumeName: 'OS',
            FileSystem: 'NTFS',
            Size: 512000000000,
            FreeSpace: 100000000000,
            DriveType: 3,
          },
          {
            DeviceID: 'F:',
            VolumeName: null,
            FileSystem: null,
            Size: null,
            FreeSpace: null,
            DriveType: 5,
          },
          { DeviceID: 'nonsense' },
        ]),
      };
    },
  });
  const { drives, source } = await service.list();
  assert.equal(source, 'windows-cim');
  assert.deepEqual(
    drives.map((d) => d.letter),
    ['C', 'F', 'G'],
  );
  assert.equal(drives[0].type, 'fixed');
  assert.equal(drives[2].type, 'removable');
  assert.equal(drives[2].total, '1.82 TB');
  assert.equal(drives[1].accessible, false, 'disconnected media is reported, not thrown');
  assert.equal(drives[1].totalBytes, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.ok(Array.isArray(calls[0].args) && calls[0].args.every((a) => typeof a === 'string'));
  assert.match(calls[0].file, /powershell\.exe$/i);
});

test('drive discovery accepts a single-object result and survives probe timeouts', async () => {
  const service = new DriveService({
    platform: 'win32',
    probeTimeoutMs: 20,
    fsImpl: { access: () => new Promise(() => {}) },
    run: cim({ DeviceID: 'Z:', DriveType: 4, Size: 1, FreeSpace: 1 }),
  });
  const { drives } = await service.list();
  assert.equal(drives.length, 1);
  assert.equal(drives[0].type, 'network');
  assert.deepEqual([drives[0].accessible, drives[0].error], [false, 'NOT_RESPONDING']);
});

test('drive discovery falls back to probing letters when the system query fails', async () => {
  const service = new DriveService({
    platform: 'win32',
    fsImpl: {
      access: async (root) => {
        if (!/^[CE]:/.test(root)) throw Object.assign(new Error(), { code: 'ENOENT' });
      },
    },
    run: async () => {
      throw new Error('powershell missing');
    },
  });
  const { drives, source, warnings } = await service.list();
  assert.equal(source, 'probe');
  assert.deepEqual(
    drives.map((d) => d.letter),
    ['C', 'E'],
  );
  assert.match(warnings[0], /probed/);
});

// ---------------------------------------------------------------- listing
test('listing is direct-children only, paginated, counted and sortable', async (t) => {
  const base = await workspace(t);
  for (let i = 0; i < 250; i++)
    await fs.writeFile(path.join(base, `f${String(i).padStart(3, '0')}.txt`), 'x'.repeat(i));
  await fs.mkdir(path.join(base, 'sub'));
  await write(path.join(base, 'sub', 'nested.txt'));
  const { ops } = stack(base);
  const first = await ops.listDirectory({ path: base }, { limit: 100 });
  assert.equal(first.scope, 'direct-children');
  assert.equal(first.total, 251);
  assert.equal(first.returned, 100);
  assert.equal(first.nextOffset, 100);
  assert.deepEqual(first.counts, { files: 250, directories: 1, links: 0, other: 0 });
  assert.ok(!first.entries.some((e) => e.name === 'nested.txt'));
  const last = await ops.listDirectory({ path: base }, { offset: 200, limit: 100 });
  assert.equal(last.returned, 51);
  assert.equal(last.nextOffset, null);
  const big = await ops.listDirectory({ path: base }, { sortBy: 'size', order: 'desc', limit: 3 });
  assert.deepEqual(
    big.entries.map((e) => e.sizeBytes),
    [249, 248, 247],
  );
  const e = first.entries[0];
  assert.match(e.created, /^\d{4}-\d\d-\d\dT/);
  assert.match(e.modified, /^\d{4}-\d\d-\d\dT/);
  assert.equal(e.extension, 'txt');
  await assert.rejects(ops.listDirectory({ path: base }, { limit: 0 }), {
    code: 'INVALID_ARGUMENT',
  });
  await assert.rejects(ops.listDirectory({ path: path.join(base, 'nope') }), { code: 'NOT_FOUND' });
});

test('links are listed as links and never followed; permission errors become skipped items', async (t) => {
  const base = await workspace(t);
  await write(path.join(base, 'real.txt'));
  await fs.symlink(path.join(base, 'real.txt'), path.join(base, 'ln.txt'));
  const { ops, guard } = stack(base);
  const listing = await ops.listDirectory({ path: base });
  assert.equal(listing.entries.find((e) => e.name === 'ln.txt').type, 'link');
  assert.equal(listing.counts.links, 1);
  const flaky = new ExplorerOps({
    guard,
    fsImpl: {
      ...fs,
      lstat: async (p) => {
        if (p.endsWith('real.txt')) throw Object.assign(new Error(), { code: 'EACCES' });
        return fs.lstat(p);
      },
    },
  });
  const result = await flaky.listDirectory({ path: base });
  assert.deepEqual(result.skipped, [{ name: 'real.txt', error: 'EACCES' }]);
  const denied = new ExplorerOps({
    guard,
    fsImpl: {
      ...fs,
      readdir: async () => {
        throw Object.assign(new Error(), { code: 'EACCES' });
      },
    },
  });
  await assert.rejects(denied.listDirectory({ path: base }), { code: 'ACCESS_DENIED' });
});

test('file and folder metadata', async (t) => {
  const base = await workspace(t);
  await write(path.join(base, 'a.PDF'), 'hello');
  await write(path.join(base, 'dir', 'x.txt'));
  const { ops } = stack(base);
  const file = await ops.getFileMetadata({ path: path.join(base, 'a.PDF') });
  assert.deepEqual(
    [file.type, file.extension, file.sizeBytes, file.size],
    ['file', 'pdf', 5, '5 B'],
  );
  const dir = await ops.getFileMetadata({ path: path.join(base, 'dir') });
  assert.equal(dir.type, 'directory');
  assert.equal(dir.counts.files, 1);
  await assert.rejects(ops.getFileMetadata({ path: path.join(base, 'zzz') }), {
    code: 'NOT_FOUND',
  });
});

// ---------------------------------------------------------------- recursive size
test('folder size is recursive, exact, per-child, and does not follow links or enter protected trees', async (t) => {
  const base = await workspace(t);
  const outside = await workspace(t);
  const project = path.join(base, 'projects');
  await write(path.join(project, 'a', 'one.bin'), 'x'.repeat(1000));
  await write(path.join(project, 'a', 'deep', 'two.bin'), 'x'.repeat(500));
  await write(path.join(project, 'b', 'three.bin'), 'x'.repeat(200));
  await write(path.join(project, 'root.txt'), 'x'.repeat(10));
  await write(path.join(project, '.ssh', 'id_rsa'), 'x'.repeat(9999));
  await write(path.join(outside, 'huge.bin'), 'x'.repeat(50000));
  await fs.symlink(outside, path.join(project, 'jump'), 'dir');
  const { ops } = stack(base);
  const result = await ops.calculateFolderSize({ path: project }, { breakdown: true });
  assert.equal(result.scope, 'recursive');
  assert.equal(result.complete, true);
  assert.equal(result.totalBytes, 1710);
  assert.equal(result.files, 4);
  assert.equal(result.linksSkipped, 1);
  assert.ok(result.skipped.some((s) => s.error === 'PROTECTED_PATH'));
  assert.ok(result.skipped.some((s) => s.error === 'LINK_NOT_FOLLOWED'));
  assert.deepEqual(
    result.largestChildren.map((c) => [c.name, c.bytes]),
    [
      ['a', 1500],
      ['b', 200],
      ['(files in this folder)', 10],
    ],
  );
});

test('folder size stops cleanly on entry cap, deadline and cancellation', async (t) => {
  const base = await workspace(t);
  for (let d = 0; d < 5; d++)
    for (let f = 0; f < 20; f++) await write(path.join(base, `d${d}`, `f${f}`), 'x');
  const { ops } = stack(base);
  const capped = await ops.calculateFolderSize({ path: base }, { maxEntries: 30 });
  assert.deepEqual([capped.complete, capped.stoppedBy], [false, 'maxEntries']);
  let t0 = 0;
  const slow = await ops.calculateFolderSize(
    { path: base },
    { deadlineMs: 10, now: () => (t0 += 20) },
  );
  assert.deepEqual([slow.complete, slow.stoppedBy], [false, 'timeout']);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await ops.calculateFolderSize({ path: base }, { signal: controller.signal });
  assert.deepEqual([cancelled.complete, cancelled.stoppedBy], [false, 'cancelled']);
  await assert.rejects(ops.listDirectory({ path: base }, { signal: controller.signal }), {
    code: 'CANCELLED',
  });
});

// ---------------------------------------------------------------- search
test('search spans several approved roots with extension, size and name filters', async (t) => {
  const one = await workspace(t);
  const two = await workspace(t);
  await write(path.join(one, 'docs', 'Report.PDF'), 'x'.repeat(100));
  await write(path.join(one, 'docs', 'notes.txt'), 'x');
  await write(path.join(two, 'deep', 'er', 'invoice.pdf'), 'x'.repeat(5000));
  await write(path.join(two, 'video.mkv'), 'x'.repeat(9000));
  await write(path.join(two, '.ssh', 'leak.pdf'), 'x'.repeat(99999));
  const roots = new ApprovedRoots();
  roots.add(SCOPE, one);
  roots.add(SCOPE, two);
  const ops = new ExplorerOps({ guard: new ExplorerPathGuard({ roots }) });
  const pdfs = await ops.searchFiles({ roots: [one, two] }, { extensions: ['.pdf'] });
  assert.deepEqual(pdfs.results.map((r) => r.name).sort(), ['Report.PDF', 'invoice.pdf']);
  assert.equal(pdfs.complete, true);
  const large = await ops.searchFiles(
    { roots: [one, two] },
    { minSizeBytes: 4000, sortBy: 'size' },
  );
  assert.deepEqual(
    large.results.map((r) => r.name),
    ['video.mkv', 'invoice.pdf'],
  );
  const wild = await ops.searchFiles({ roots: [one, two] }, { query: 'inv*ce.?df' });
  assert.deepEqual(
    wild.results.map((r) => r.name),
    ['invoice.pdf'],
  );
  const limited = await ops.searchFiles({ roots: [one, two] }, { type: 'any', maxResults: 2 });
  assert.equal(limited.results.length, 2);
  assert.equal(limited.stoppedBy, 'maxResults');
  const dirs = await ops.searchFiles({ roots: [one, two] }, { type: 'directory', query: 'deep' });
  assert.deepEqual(
    dirs.results.map((r) => r.name),
    ['deep'],
  );
});

test('search honours visit caps, cancellation and rejects bad patterns', async (t) => {
  const base = await workspace(t);
  for (let i = 0; i < 40; i++) await write(path.join(base, `f${i}.txt`));
  const { ops } = stack(base);
  const capped = await ops.searchFiles({ roots: [base] }, { query: 'f', maxVisited: 10 });
  assert.equal(capped.stoppedBy, 'maxVisited');
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await ops.searchFiles({ roots: [base] }, { signal: controller.signal })).stoppedBy,
    'cancelled',
  );
  assert.throws(() => nameMatcher('*a*b*c*d*e'), { code: 'INVALID_PATTERN' });
  assert.throws(() => nameMatcher('x'.repeat(200)), { code: 'INVALID_PATTERN' });
  assert.equal(nameMatcher('a.c')('abc'), false, 'dot is literal');
  assert.equal(nameMatcher('*.TXT')('x.txt'), true);
  await assert.rejects(ops.searchFiles({ roots: [base] }, { modifiedAfter: 'not a date' }), {
    code: 'INVALID_ARGUMENT',
  });
});

// ---------------------------------------------------------------- tree and read
test('directory tree is depth and size bounded and marks protected entries', async (t) => {
  const base = await workspace(t);
  await write(path.join(base, 'a', 'b', 'c', 'd.txt'));
  await write(path.join(base, '.ssh', 'k'));
  const { ops } = stack(base);
  const shallow = await ops.getDirectoryTree({ path: base }, { maxDepth: 2 });
  const a = shallow.tree.children.find((n) => n.name === 'a');
  assert.equal(a.children[0].name, 'b');
  assert.equal(a.children[0].hasMore, true);
  const ssh = shallow.tree.children.find((n) => n.name === '.ssh');
  assert.equal(ssh.protected, true);
  assert.equal(ssh.children, undefined);
  const tiny = await ops.getDirectoryTree({ path: base }, { maxEntries: 1 });
  assert.equal(tiny.truncated, true);
});

test('reading is bounded, offset-aware, text-only and marked untrusted', async (t) => {
  const base = await workspace(t);
  await fs.writeFile(path.join(base, 't.txt'), 'abcdefghij');
  await fs.writeFile(path.join(base, 'b.bin'), Buffer.from([1, 2, 0, 3]));
  await write(path.join(base, 'sub', 'x'));
  const { ops } = stack(base);
  const part = await ops.readFile({ path: path.join(base, 't.txt') }, { maxBytes: 4 });
  assert.deepEqual(
    [part.content, part.truncated, part.nextOffset, part.untrusted],
    ['abcd', true, 4, true],
  );
  const rest = await ops.readFile({ path: path.join(base, 't.txt') }, { offset: 4, maxBytes: 100 });
  assert.deepEqual([rest.content, rest.truncated, rest.nextOffset], ['efghij', false, null]);
  await assert.rejects(ops.readFile({ path: path.join(base, 'b.bin') }), { code: 'BINARY_FILE' });
  await assert.rejects(ops.readFile({ path: path.join(base, 'sub') }), { code: 'NOT_A_FILE' });
  await assert.rejects(ops.readFile({ path: path.join(base, 'nope') }), { code: 'NOT_FOUND' });
  await assert.rejects(ops.readFile({ path: path.join(base, 't.txt') }, { offset: -1 }), {
    code: 'INVALID_ARGUMENT',
  });
});

// ---------------------------------------------------------------- tool service + approvals
function fakeGate() {
  const requests = [];
  return {
    requests,
    request: (metadata) => (
      requests.push(metadata),
      { confirmationId: `c${requests.length}`, expiresAt: Date.now() + 60_000 }
    ),
  };
}
const as = (scope, fn) => executionContext.run({ authenticated: true, scope, taskId: 't' }, fn);

test('tool service: default read-only, approval required, approval binds to the requesting scope', async (t) => {
  const base = await workspace(t);
  await write(path.join(base, 'p', 'a.txt'), 'hi');
  const gate = fakeGate();
  const service = new ExplorerToolService(gate);
  const list = (scope, dir) => as(scope, () => service.execute('listDirectory', { path: dir }));
  await assert.rejects(list(SCOPE, base), { code: 'ROOT_NOT_APPROVED' });
  await assert.rejects(service.execute('listDirectory', { path: base }), {
    code: 'AUTH_CONTEXT_REQUIRED',
  });
  // Requesting approval only asks; it grants nothing.
  const asked = await as(SCOPE, () => service.execute('approveRoot', { path: base }));
  assert.equal(asked.needsConfirmation, true);
  assert.equal(gate.requests[0].tool, 'explorer');
  assert.equal(gate.requests[0].action, 'approveRoot');
  assert.ok(gate.requests[0].message.includes(base));
  await assert.rejects(list(SCOPE, base), { code: 'ROOT_NOT_APPROVED' }, 'asking is not approving');
  // The router calls executeConfirmed only after the gate validates a server-issued token.
  const done = await as(SCOPE, () => service.executeConfirmed('approveRoot', { path: base }));
  assert.equal(done.data.approved, true);
  assert.equal((await list(SCOPE, path.join(base, 'p'))).data.entries[0].name, 'a.txt');
  await assert.rejects(list('renderer:someone-else', base), { code: 'ROOT_NOT_APPROVED' });
  const read = await as(SCOPE, () =>
    service.execute('readFile', { path: path.join(base, 'p', 'a.txt') }),
  );
  assert.equal(read.data.content, 'hi');
  const search = await as(SCOPE, () => service.execute('searchFiles', { query: 'a.' }));
  assert.equal(search.data.results.length, 1);
  assert.equal(
    (await as(SCOPE, () => service.execute('revokeRoot', { path: base }))).data.revoked,
    1,
  );
  await assert.rejects(list(SCOPE, base), { code: 'ROOT_NOT_APPROVED' });
  await assert.rejects(
    as(SCOPE, () => service.execute('searchFiles', {})),
    { code: 'ROOT_NOT_APPROVED' },
  );
});

test('tool service rejects bad approvals before the user is ever asked', async (t) => {
  const base = await workspace(t);
  await write(path.join(base, '.ssh', 'k'));
  await write(path.join(base, 'file.txt'));
  const gate = fakeGate();
  const service = new ExplorerToolService(gate);
  const ask = (params) => as(SCOPE, () => service.execute('approveRoot', params));
  await assert.rejects(ask({ path: path.join(base, '.ssh') }), { code: 'PROTECTED_PATH' });
  await assert.rejects(ask({ path: path.join(base, 'file.txt') }), { code: 'NOT_A_DIRECTORY' });
  await assert.rejects(ask({ path: path.join(base, 'ghost') }), { code: 'NOT_FOUND' });
  await assert.rejects(ask({ path: 'relative' }), { code: 'DISALLOWED_PATH' });
  await assert.rejects(ask({ path: base, hours: 999 }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(ask({ path: base, extra: 1 }), { code: 'VALIDATION_ERROR' });
  assert.equal(gate.requests.length, 0, 'no confirmation was issued for any invalid request');
});

test('tool service validates malformed model arguments', async (t) => {
  const base = await workspace(t);
  const service = new ExplorerToolService(fakeGate());
  service.roots.add(SCOPE, base);
  for (const [action, params] of [
    ['listDirectory', { path: base, limit: 100000 }],
    ['listDirectory', { path: base, sortBy: 'colour' }],
    ['listDirectory', { path: base, offset: -5 }],
    ['listDirectory', { path: 7 }],
    ['listDirectory', {}],
    ['readFile', { path: base, maxBytes: 1e9 }],
    ['getDirectoryTree', { path: base, maxDepth: 99 }],
    ['searchFiles', { paths: 'not-an-array' }],
    ['searchFiles', { type: 'everything' }],
    ['nonexistent', {}],
  ])
    await assert.rejects(
      as(SCOPE, () => service.execute(action, params)),
      (error) => ['VALIDATION_ERROR', 'ACTION_NOT_FOUND'].includes(error.code),
      `${action} ${JSON.stringify(params)}`,
    );
});

test('an approved root supports tree, size and listing end to end', async (t) => {
  const base = await workspace(t);
  await write(path.join(base, 'x', 'y.txt'));
  const service = new ExplorerToolService(fakeGate());
  await as(SCOPE, () => service.executeConfirmed('approveRoot', { path: base, hours: 1 }));
  const roots = await as(SCOPE, () => service.execute('listApprovedRoots', {}));
  assert.equal(roots.data.roots.length, 1);
  const tree = await as(SCOPE, () => service.execute('getDirectoryTree', { path: base }));
  assert.equal(tree.data.tree.children[0].name, 'x');
  const size = await as(SCOPE, () =>
    service.execute('calculateFolderSize', { path: base, breakdown: true }),
  );
  assert.equal(size.data.totalBytes, 1);
});
