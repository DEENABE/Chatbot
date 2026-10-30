import test from 'node:test';
import assert from 'node:assert/strict';
import { CodingToolEngine } from './CodingToolEngine.js';

const V = (c) => c.repeat(64);
const repository = {
  approvals: [],
  executionPolicy: () => ({ commands: false, downloads: false }),
  writeAllowed: () => true,
  audit() {},
  approval(_u, _w, pending) {
    this.approvals.push(pending);
    return `approval-${this.approvals.length}`;
  },
};
const context = (files) => ({
  userId: 'u',
  workspaceId: 'w',
  taskId: 't',
  root: process.platform === 'win32' ? 'C:\\proj' : '/proj',
  binding: 'b',
  currentBinding: 'b',
  files,
});

function fakeFiles(initial = {}) {
  const store = new Map(Object.entries(initial));
  const dirs = new Set(['']);
  for (const p of store.keys()) dirs.add(p.split('/').slice(0, -1).join('/'));
  const calls = [];
  return {
    store,
    dirs,
    calls,
    async read({ path }) {
      calls.push(['read', path]);
      if (!store.has(path))
        throw Object.assign(new Error('missing'), { code: 'FILE_NOT_FOUND', status: 404 });
      return { path, content: store.get(path).content, version: store.get(path).version };
    },
    async mkdir({ path }) {
      calls.push(['mkdir', path]);
      const created = [];
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (!dirs.has(d)) {
          dirs.add(d);
          created.push(d);
        }
      }
      return { path, createdDirectories: created, changed: created.length > 0 };
    },
    async write({ path, content, expectedVersion }) {
      calls.push(['write', path]);
      const parent = path.split('/').slice(0, -1).join('/');
      if (!dirs.has(parent))
        throw Object.assign(new Error('The workspace file or directory was not found.'), {
          code: 'FILE_NOT_FOUND',
          status: 404,
        });
      if (expectedVersion === 'new' && store.has(path))
        throw Object.assign(new Error('exists'), { code: 'FILE_CONFLICT', status: 409 });
      store.set(path, { content, version: V(String(store.size + 1)) });
      return { path, version: store.get(path).version, changed: true };
    },
  };
}

test('new file in a missing folder creates the folder and is written', async () => {
  const files = fakeFiles();
  const engine = new CodingToolEngine({ repository });
  const r = await engine.execute(
    {
      tool: 'fs.write',
      params: { path: 'src/components/App.jsx', content: 'x\n', expectedVersion: 'new' },
    },
    context(files),
  );
  assert.equal(r.success, true, JSON.stringify(r.error));
  assert.ok(files.store.has('src/components/App.jsx'));
  assert.deepEqual(r.data.createdDirectories, ['src', 'src/components']);
  assert.deepEqual(
    files.calls.filter((c) => c[0] !== 'read'),
    [
      ['write', 'src/components/App.jsx'],
      ['mkdir', 'src/components'],
      ['write', 'src/components/App.jsx'],
    ],
  );
});

test('replacing an existing file never auto-creates folders', async () => {
  const files = fakeFiles();
  const engine = new CodingToolEngine({ repository });
  const r = await engine.execute(
    { tool: 'fs.write', params: { path: 'lib/a.js', content: 'x\n', expectedVersion: V('a') } },
    context(files),
  );
  assert.equal(r.success, false);
  assert.ok(!files.calls.some((c) => c[0] === 'mkdir'));
});

test('rewriting identical config content is a no-op without an approval prompt', async () => {
  const pkg = '{\n  "name": "app"\n}\n';
  const files = fakeFiles({ 'package.json': { content: pkg, version: V('1') } });
  repository.approvals.length = 0;
  const engine = new CodingToolEngine({ repository });
  const same = await engine.execute(
    { tool: 'fs.write', params: { path: 'package.json', content: pkg, expectedVersion: V('1') } },
    context(files),
  );
  // A no-op is success (the task keeps going), never an error that can end the run.
  assert.equal(same.success, true);
  assert.equal(same.data.unchanged, true);
  assert.equal(same.data.changed, undefined);
  assert.match(same.data.message, /Do not write it again/);
  assert.equal(repository.approvals.length, 0);
  // a real change to a config file still asks for approval
  const changed = await engine.execute(
    {
      tool: 'fs.write',
      params: { path: 'package.json', content: pkg.replace('app', 'web'), expectedVersion: V('1') },
    },
    context(files),
  );
  assert.equal(changed.needsConfirmation, true);
  assert.equal(repository.approvals.length, 1);
});

test('Vite projects reject src/index.html and say where it belongs', async () => {
  const files = fakeFiles({
    'package.json': { content: '{"devDependencies":{"vite":"^5.0.0"}}', version: V('1') },
  });
  const engine = new CodingToolEngine({ repository });
  const r = await engine.execute(
    {
      tool: 'fs.write',
      params: { path: 'src/index.html', content: '<html></html>', expectedVersion: 'new' },
    },
    context(files),
  );
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'WRONG_LOCATION');
  assert.match(r.error.message, /project ROOT/);
  assert.ok(!files.store.has('src/index.html'));
  const ok = await engine.execute(
    {
      tool: 'fs.write',
      params: { path: 'index.html', content: '<html></html>', expectedVersion: 'new' },
    },
    context(files),
  );
  assert.equal(ok.success, true);
});

test('src/index.html is allowed in a project that does not use Vite', async () => {
  const files = fakeFiles({ 'package.json': { content: '{"name":"plain"}', version: V('1') } });
  files.dirs.add('src');
  const engine = new CodingToolEngine({ repository });
  const r = await engine.execute(
    {
      tool: 'fs.write',
      params: { path: 'src/index.html', content: '<p>x</p>', expectedVersion: 'new' },
    },
    context(files),
  );
  assert.equal(r.success, true, JSON.stringify(r.error));
});

test('writing an existing file as new reports FILE_EXISTS with the way forward', async () => {
  const files = fakeFiles({ 'src/main.jsx': { content: 'old', version: V('1') } });
  const engine = new CodingToolEngine({ repository });
  const r = await engine.execute(
    { tool: 'fs.write', params: { path: 'src/main.jsx', content: 'new', expectedVersion: 'new' } },
    context(files),
  );
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'FILE_EXISTS');
  assert.match(r.error.message, /fs\.read it/);
  assert.equal(files.store.get('src/main.jsx').content, 'old');
});

test('an existing config file written as new fails before asking for approval', async () => {
  const files = fakeFiles({ 'package.json': { content: '{}', version: V('2') } });
  const engine = new CodingToolEngine({ repository });
  const before = repository.approvals.length;
  const r = await engine.execute(
    {
      tool: 'fs.write',
      params: { path: 'package.json', content: '{"scripts":{}}', expectedVersion: 'new' },
    },
    context(files),
  );
  assert.equal(r.success, false);
  assert.equal(r.needsConfirmation, undefined);
  assert.equal(repository.approvals.length, before, 'no approval is requested for a doomed write');
  assert.equal(r.error.code, 'FILE_EXISTS');
  assert.ok(r.error.message.includes(V('2')), 'the message carries the version to use');
});
