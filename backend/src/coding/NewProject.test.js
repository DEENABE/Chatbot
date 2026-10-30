import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectWorkspace, validateProjectName, defaultProjectsRoot } from './NewProject.js';

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-newproject-'));
const saver = (calls) => async (userId, input) => {
  calls.push({ userId, ...input });
  return { id: 'ws-1', ...input };
};

test('project names are a single safe folder name', () => {
  assert.equal(validateProjectName('  my-app 1  '), 'my-app 1');
  for (const bad of [
    '',
    '..',
    '../x',
    'a/b',
    'a\\b',
    'con',
    'NUL.txt',
    'x.',
    '.hidden',
    'a..b',
    'x'.repeat(65),
    5,
    null,
  ])
    assert.throws(() => validateProjectName(bad), { code: 'INVALID_PROJECT_NAME' }, String(bad));
});

test('creates the folder under an existing parent and registers the workspace', async () => {
  const parent = await temp();
  const calls = [];
  const result = await createProjectWorkspace(
    'u1',
    { name: 'todo-app', parent },
    { save: saver(calls) },
  );
  const real = await fs.realpath(parent);
  assert.equal(result.root, path.join(real, 'todo-app'));
  assert.equal(result.created, true);
  assert.deepEqual(await fs.readdir(result.root), []);
  assert.deepEqual(calls, [{ userId: 'u1', name: 'todo-app', root: result.root }]);
});

test('uses the default projects folder under home when no parent is given', async () => {
  const home = await temp();
  const result = await createProjectWorkspace('u1', { name: 'demo' }, { save: saver([]), home });
  assert.equal(result.root, path.join(await fs.realpath(defaultProjectsRoot(home)), 'demo'));
});

test('refuses a non-empty existing folder and leaves it untouched', async () => {
  const parent = await temp();
  await fs.mkdir(path.join(parent, 'busy'));
  await fs.writeFile(path.join(parent, 'busy', 'keep.txt'), 'mine');
  await assert.rejects(
    createProjectWorkspace('u1', { name: 'busy', parent }, { save: saver([]) }),
    { code: 'PROJECT_DIR_NOT_EMPTY', status: 409 },
  );
  assert.equal(await fs.readFile(path.join(parent, 'busy', 'keep.txt'), 'utf8'), 'mine');
});

test('reuses an empty existing folder without deleting it on failure', async () => {
  const parent = await temp();
  await fs.mkdir(path.join(parent, 'empty'));
  const failing = async () => {
    throw Object.assign(new Error('boom'), { status: 400 });
  };
  await assert.rejects(createProjectWorkspace('u1', { name: 'empty', parent }, { save: failing }), {
    code: 'PROJECT_CREATE_FAILED',
  });
  assert.ok((await fs.stat(path.join(parent, 'empty'))).isDirectory());
});

test('removes a folder it created when registering the workspace fails', async () => {
  const parent = await temp();
  const failing = async () => {
    throw new Error('db down');
  };
  await assert.rejects(createProjectWorkspace('u1', { name: 'fresh', parent }, { save: failing }), {
    code: 'PROJECT_CREATE_FAILED',
  });
  await assert.rejects(fs.stat(path.join(parent, 'fresh')), { code: 'ENOENT' });
});

test('rejects unknown fields, bad parents and symlinked parents', async () => {
  const parent = await temp();
  await assert.rejects(
    createProjectWorkspace('u1', { name: 'a', parent, extra: 1 }, { save: saver([]) }),
    {
      code: 'INVALID_PROJECT',
    },
  );
  await assert.rejects(
    createProjectWorkspace('u1', { name: 'a', parent: 'relative/path' }, { save: saver([]) }),
    {
      code: 'PROJECT_PARENT_INVALID',
    },
  );
  await assert.rejects(
    createProjectWorkspace(
      'u1',
      { name: 'a', parent: path.join(parent, 'missing') },
      { save: saver([]) },
    ),
    {
      code: 'PROJECT_PARENT_INVALID',
    },
  );
  const link = path.join(parent, 'link');
  await fs.mkdir(path.join(parent, 'real'));
  await fs.symlink(path.join(parent, 'real'), link, 'dir').catch(() => null);
  if (
    await fs.lstat(link).then(
      () => true,
      () => false,
    )
  )
    await assert.rejects(
      createProjectWorkspace('u1', { name: 'a', parent: link }, { save: saver([]) }),
      {
        code: 'PROJECT_PARENT_INVALID',
      },
    );
});
