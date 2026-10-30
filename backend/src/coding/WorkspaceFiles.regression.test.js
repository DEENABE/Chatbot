import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceFiles, fileVersion, workspaceError } from './WorkspaceFiles.js';

async function fixture(t, native = false) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-files-fix-'));
  const root = path.join(temporary, 'project');
  await fs.mkdir(root);
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const guard = async (request) => {
    const target = path.join(root, request.path || '');
    if (request.operation === 'inspect') return { available: true };
    if (request.operation === 'list') {
      if (!(await fs.stat(target)).isDirectory())
        throw workspaceError('INVALID_FILE_TYPE', 'Not a directory');
      const entries = [];
      const walk = async (directory) => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const absolute = path.join(directory, entry.name);
          entries.push({
            path: path.relative(root, absolute).replaceAll(path.sep, '/'),
            type: entry.isDirectory() ? 'directory' : 'file',
            size: entry.isDirectory() ? 0 : (await fs.stat(absolute)).size,
          });
          if (entry.isDirectory() && request.recursive) await walk(absolute);
        }
      };
      await walk(target);
      return { entries, errors: [], truncated: false };
    }
    if (request.operation === 'read') {
      try {
        const bytes = await fs.readFile(target);
        return {
          contentBase64: bytes.toString('base64'),
          version: fileVersion(bytes),
          size: bytes.length,
        };
      } catch (error) {
        if (error.code === 'ENOENT') throw workspaceError('FILE_NOT_FOUND', 'File missing');
        throw error;
      }
    }
    if (request.operation === 'write' || request.operation === 'remove') {
      let before = null;
      try {
        before = await fs.readFile(target);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const version = before ? fileVersion(before) : 'new';
      if (version !== request.expectedVersion)
        throw workspaceError('FILE_CONFLICT', 'Version changed');
      if (request.operation === 'remove') await fs.unlink(target);
      else await fs.writeFile(target, request.content);
      return {
        changed: true,
        path: request.path,
        beforeContentBase64: before?.toString('base64') ?? null,
        beforeVersion: version,
        version: request.operation === 'remove' ? 'new' : fileVersion(request.content),
        size: request.content?.length || 0,
      };
    }
    throw new Error(`Unsupported fixture operation ${request.operation}`);
  };
  return {
    root,
    files: new WorkspaceFiles({
      root: await fs.realpath(root),
      checkpointDirectory: path.join(temporary, 'checkpoints'),
      ...(native ? {} : { guard }),
    }),
  };
}

test('a search accepts an individual Python file and still supports recursive directory search', async (t) => {
  const { root, files } = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/calculator.py'), 'def add(a, b):\n    return a + b\n');
  const result = await files.search({ path: 'src/calculator.py', query: 'add' });
  assert.equal(result.results[0].path, 'src/calculator.py');
  assert.equal(result.results[0].line, 1);
  assert.equal(result.inspectedFiles, 1);
  assert.equal((await files.search({ path: 'src', query: 'return' })).results.length, 1);
});

test('a fresh checkpoint permits edits after an external change while old restore remains blocked', async (t) => {
  const { root, files } = await fixture(t);
  const first = await files.checkpoint();
  await files.write({ path: 'calculator.py', content: 'agent v1', expectedVersion: 'new' });
  await fs.writeFile(path.join(root, 'calculator.py'), 'external edit');
  const fresh = await files.checkpoint();
  const observed = await files.read({ path: 'calculator.py' });
  await files.write({
    path: 'calculator.py',
    content: 'agent v2',
    expectedVersion: observed.version,
  });
  await assert.rejects(files.previewRestore({ checkpointId: first.checkpointId }), {
    code: 'CHECKPOINT_CONFLICT',
  });
  await files.restore({ checkpointId: fresh.checkpointId });
  assert.equal(await fs.readFile(path.join(root, 'calculator.py'), 'utf8'), 'external edit');
});

test('observed external changes rotate a baseline automatically; stale file versions never overwrite them', async (t) => {
  const { root, files } = await fixture(t);
  const original = await files.checkpoint();
  const first = await files.write({
    path: 'calculator.py',
    content: 'one',
    expectedVersion: 'new',
  });
  await fs.writeFile(path.join(root, 'calculator.py'), 'external');
  await assert.rejects(
    files.write({
      path: 'calculator.py',
      content: 'stale overwrite',
      expectedVersion: first.version,
    }),
    { code: 'FILE_CONFLICT' },
  );
  assert.equal(await fs.readFile(path.join(root, 'calculator.py'), 'utf8'), 'external');
  const current = await files.read({ path: 'calculator.py' });
  await files.write({
    path: 'calculator.py',
    content: 'updated',
    expectedVersion: current.version,
  });
  assert.notEqual(files.currentCheckpointId, original.checkpointId);
  await assert.rejects(files.previewRestore({ checkpointId: original.checkpointId }), {
    code: 'CHECKPOINT_CONFLICT',
  });
  await files.restore({ checkpointId: files.currentCheckpointId });
  assert.equal(await fs.readFile(path.join(root, 'calculator.py'), 'utf8'), 'external');
});

test('approved package-manager changes stay in checkpoint history and do not block the next edit', async (t) => {
  const { root, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"original"}');
  const checkpoint = await files.checkpoint();
  const receipts = await files.prepareManagedChanges(['package.json']);
  await fs.writeFile(
    path.join(root, 'package.json'),
    '{"name":"original","dependencies":{"is-number":"7.0.0"}}',
  );
  const changes = await files.finishManagedChanges(receipts);
  assert.equal(changes.length, 1);
  await files.write({
    path: 'package.json',
    content: '{"name":"updated"}',
    expectedVersion: changes[0].version,
  });
  await files.restore({ checkpointId: checkpoint.checkpointId });
  assert.equal(await fs.readFile(path.join(root, 'package.json'), 'utf8'), '{"name":"original"}');
});

test('checkpoint retention archives old baselines without blocking new tasks', async (t) => {
  const { files } = await fixture(t);
  for (let i = 0; i < 22; i++) await files.checkpoint({ label: `Task ${i}` });
  const result = await files.checkpoints();
  assert.equal(result.checkpoints.length, 22);
  assert.equal(result.checkpoints.filter((item) => item.status === 'active').length, 20);
});

test(
  'native Windows file search and external-edit checkpoint recovery work together',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { root, files } = await fixture(t, true);
    const old = await files.checkpoint();
    await files.write({
      path: 'calculator.py',
      content: 'def add(a, b): return a + b\n',
      expectedVersion: 'new',
    });
    assert.equal((await files.search({ path: 'calculator.py', query: 'add' })).results.length, 1);
    await fs.writeFile(
      path.join(root, 'calculator.py'),
      '# external\ndef add(a, b): return a + b\n',
    );
    const version = (await files.read({ path: 'calculator.py' })).version;
    await files.checkpoint();
    await files.write({
      path: 'calculator.py',
      content: '# preserved update\ndef add(a, b): return a + b\n',
      expectedVersion: version,
    });
    await assert.rejects(files.previewRestore({ checkpointId: old.checkpointId }), {
      code: 'CHECKPOINT_CONFLICT',
    });
    assert.match(await fs.readFile(path.join(root, 'calculator.py'), 'utf8'), /preserved update/);
  },
);
