import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { codingWorkspacePath, normalizeCodingPaths } from './codingPaths.js';
import { CodingToolEngine } from './CodingToolEngine.js';
import { CodingTaskRepository } from './CodingTaskRepository.js';

test('selected Windows root and descendants normalize without broadening the workspace', () => {
  for (const name of ['D:\\project', 'd:/PROJECT/', '.', './', ''])
    assert.equal(
      codingWorkspacePath(name, 'D:\\project', { allowRoot: true, directory: true }),
      '',
    );
  for (const name of [
    'D:\\project\\src\\App.jsx',
    'd:/project/src/App.jsx',
    './src/App.jsx',
    'src\\App.jsx',
  ])
    assert.equal(codingWorkspacePath(name, 'D:\\project'), 'src/App.jsx');
  assert.equal(codingWorkspacePath('D:/', 'D:\\', { allowRoot: true, directory: true }), '');
  assert.equal(codingWorkspacePath('/tmp/project/src/a.js', '/tmp/project'), 'src/a.js');
});

test('outside roots, traversal, protected files, device/UNC paths and alternate streams remain denied', () => {
  for (const name of [
    'D:\\project-other\\a.js',
    'C:\\project\\a.js',
    'D:\\outside\\a.js',
    'D:\\project\\..\\outside\\a.js',
    'D:\\project\\src\\..\\a.js',
    '../a.js',
    'src/../a.js',
    '/src/a.js',
    '\\src\\a.js',
    '\\\\server\\share\\a.js',
    '\\\\?\\D:\\project\\a.js',
    '\\\\.\\D:\\project\\a.js',
    'D:project\\a.js',
    'D:\\project\\a.js:stream',
    'D:\\project\\.git\\config',
    './.env',
    'src/./a.js',
    'src//a.js',
    'src./a.js',
    'NUL.txt',
  ])
    assert.throws(
      () => codingWorkspacePath(name, 'D:\\project'),
      (error) => ['WORKSPACE_PATH_DENIED', 'PROTECTED_FILE'].includes(error.code),
      name,
    );
});

test('normalization touches only the typed path, leaving content, argv and observed file versions intact', () => {
  const request = {
    tool: 'fs.write',
    params: {
      path: 'D:\\project\\src\\a.js',
      content: 'D:\\outside\\literal',
      expectedVersion: 'new',
    },
  };
  const normalized = normalizeCodingPaths(request, 'D:\\project');
  assert.equal(normalized.params.path, 'src/a.js');
  assert.equal(normalized.params.content, request.params.content);
  assert.equal(normalized.params.expectedVersion, 'new');
  assert.equal(request.params.path, 'D:\\project\\src\\a.js');
  assert.deepEqual(
    normalizeCodingPaths(
      {
        tool: 'tests.run',
        params: { executable: 'node', args: ['D:\\outside\\test.js'], cwd: 'D:\\project' },
      },
      'D:\\project',
    ).params,
    { executable: 'node', args: ['D:\\outside\\test.js'], cwd: '' },
  );
});

test('the screenshot root search reaches the file tool; outside paths never reach it', async (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const repository = new CodingTaskRepository(database);
  let searches = 0;
  const engine = new CodingToolEngine({ repository });
  const context = {
    userId: 'owner',
    workspaceId: 'project',
    root: 'D:\\project',
    binding: 'binding',
    currentBinding: 'binding',
    files: {
      search: async ({ path }) => {
        searches++;
        assert.equal(path, '');
        return { results: [] };
      },
    },
  };
  const result = await engine.execute(
    {
      tool: 'code.search',
      params: { query: 'create-react-app', path: 'D:\\project', maxResults: 1 },
    },
    context,
  );
  assert.equal(result.success, true);
  const denied = await engine.execute(
    { tool: 'code.search', params: { query: 'text', path: 'D:\\outside' } },
    context,
  );
  assert.equal(denied.error.code, 'WORKSPACE_PATH_DENIED');
  assert.equal(searches, 1);
});

test('absolute configuration paths still require exact approval and a workspace grant', async (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const repository = new CodingTaskRepository(database);
  const engine = new CodingToolEngine({ repository });
  let writes = 0;
  const context = {
    userId: 'owner',
    workspaceId: 'project',
    root: 'D:\\project',
    binding: 'binding',
    currentBinding: 'binding',
    files: {
      write: async ({ path }) => {
        writes++;
        assert.equal(path, 'package.json');
        return { path, changed: true };
      },
    },
  };
  const request = {
    tool: 'fs.write',
    params: { path: 'D:\\project\\package.json', content: '{}', expectedVersion: 'new' },
  };
  assert.equal((await engine.execute(request, context)).error.code, 'WRITE_GRANT_REQUIRED');
  repository.grant('owner', 'project', 'binding', true);
  const pending = await engine.execute(request, context);
  assert.equal(pending.needsConfirmation, true);
  assert.equal(pending.params.path, 'package.json');
  assert.equal(writes, 0);
  assert.equal(
    (await engine.approve('owner', 'project', pending.approvalId, true, context)).success,
    true,
  );
  assert.equal(writes, 1);
  await assert.rejects(engine.approve('owner', 'project', pending.approvalId, true, context), {
    code: 'APPROVAL_INVALID',
  });
});
