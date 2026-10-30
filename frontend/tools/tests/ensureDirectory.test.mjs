import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDirectory } from '../ensureDirectory.js';

const fake = () => {
  const calls = [];
  return {
    calls,
    mkdir: async (...a) => calls.push(['mkdir', ...a]),
    stat: async (...a) => calls.push(['stat', ...a]),
  };
};

test('a drive root is checked, never created (Windows mkdir E:\\ is EPERM)', async () => {
  const files = fake();
  await ensureDirectory('E:\\', { files, flavour: path.win32 });
  assert.deepEqual(files.calls, [['stat', 'E:\\']]);
});

test('a UNC share root is treated as a root', async () => {
  const files = fake();
  await ensureDirectory('\\\\server\\share\\', { files, flavour: path.win32 });
  assert.deepEqual(files.calls, [['stat', '\\\\server\\share\\']]);
});

test('a missing drive reports ENOENT instead of a permission error', async () => {
  const files = {
    stat: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    mkdir: async () => assert.fail('mkdir must not run on a root'),
  };
  await assert.rejects(ensureDirectory('Q:\\', { files, flavour: path.win32 }), {
    code: 'ENOENT',
  });
});

test('a normal folder is created recursively', async () => {
  const files = fake();
  await ensureDirectory('E:\\notes\\2026', { files, flavour: path.win32 });
  assert.deepEqual(files.calls, [['mkdir', 'E:\\notes\\2026', { recursive: true }]]);
});

test('real filesystem: a real drive root no longer throws, nested folders are created', async () => {
  const root = path.parse(os.tmpdir()).root;
  await ensureDirectory(path.dirname(path.join(root, 'sample.txt')));
  const nested = await fs.mkdtemp(path.join(os.tmpdir(), 'ensure-'));
  await ensureDirectory(path.join(nested, 'a', 'b'));
  assert.ok((await fs.stat(path.join(nested, 'a', 'b'))).isDirectory());
  await fs.rm(nested, { recursive: true, force: true });
});
