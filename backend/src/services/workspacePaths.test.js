import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  enumerateWorkspace,
  resolveWorkspaceFile,
  validateWorkspaceRoot,
} from './workspacePaths.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-workspace-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'nested', 'empty'), { recursive: true });
  await fs.writeFile(path.join(directory, 'direct.txt'), 'Direct file');
  await fs.writeFile(path.join(directory, 'nested', 'deep.md'), 'Nested file');
  await fs.writeFile(path.join(directory, 'nested', 'unsupported.exe'), 'Unsupported file');
  return directory;
}
test('recursive scan includes files, hierarchy and empty subdirectories', async (t) => {
  const directory = await fixture(t);
  const result = await enumerateWorkspace(directory);
  assert.equal(result.files, 3);
  assert.equal(result.directories, 2);
  assert.equal(result.supportedFiles, 2);
  assert.equal(result.unsupportedFiles, 1);
  assert(
    result.entries.some(
      (entry) => entry.relativePath === 'nested/empty' && entry.type === 'directory',
    ),
  );
  assert(
    result.entries.some(
      (entry) =>
        entry.relativePath === 'nested/deep.md' && entry.parent === 'nested' && entry.depth === 1,
    ),
  );
  assert.equal(result.errors.length, 0);
  assert.equal(result.truncated, false);
});
test('selected nested file accepts slash normalization and rejects traversal', async (t) => {
  const directory = await fixture(t);
  const file = await resolveWorkspaceFile(directory, 'nested\\deep.md');
  assert.equal(file.relativePath, 'nested/deep.md');
  assert.equal(await fs.readFile(file.path, 'utf8'), 'Nested file');
  await assert.rejects(resolveWorkspaceFile(directory, '../outside.txt'), /outside/);
  await assert.rejects(resolveWorkspaceFile(directory, '..\\outside.txt'), /outside/);
  await assert.rejects(
    resolveWorkspaceFile(directory, path.join(directory, 'direct.txt')),
    /Invalid/,
  );
});
test('link loop and escape are skipped; linked roots and linked files rejected', async (t) => {
  const directory = await fixture(t);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-workspace-external-'));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.writeFile(path.join(external, 'secret.txt'), 'Outside the workspace');
  await fs.symlink(
    directory,
    path.join(directory, 'nested', 'loop'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await fs.symlink(
    external,
    path.join(directory, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = await enumerateWorkspace(directory);
  assert.equal(result.files, 3);
  assert.equal(result.errors.filter((entry) => entry.code === 'SYMLINK').length, 2);
  await assert.rejects(validateWorkspaceRoot(path.join(directory, 'escape')), /symbolic link/);
  await assert.rejects(resolveWorkspaceFile(directory, 'escape/secret.txt'), /Symbolic links/);
});
test('credential files skipped; enumeration bounded and cancellation honored', async (t) => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, '.env'), 'token=not-for-documents');
  const scan = await enumerateWorkspace(directory);
  assert(scan.errors.some((entry) => entry.code === 'PROTECTED'));
  const bounded = await enumerateWorkspace(directory, { maxEntries: 2 });
  assert.equal(bounded.entries.length, 2);
  assert.equal(bounded.truncated, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(enumerateWorkspace(directory, { signal: controller.signal }), {
    name: 'AbortError',
  });
});
test('missing drive/directory and non-directory roots report failures', async (t) => {
  const directory = await fixture(t);
  await assert.rejects(validateWorkspaceRoot(path.join(directory, 'missing')), {
    code: 'ENOENT',
  });
  await assert.rejects(validateWorkspaceRoot(path.join(directory, 'direct.txt')), /directory/);
  await assert.rejects(validateWorkspaceRoot('relative/root'), /absolute local/);
});
