import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CodingTaskRepository } from './CodingTaskRepository.js';
import { fileVersion } from './WorkspaceFiles.js';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-coding-regression-'));
process.env.APP_DATA_PATH = temporary;
const { CodingAgentService, requiredValidations } = await import('./CodingAgentService.js');
const { db: applicationDb } = await import('../services/db.js');
after(async () => {
  applicationDb.close();
  await fs.rm(temporary, { recursive: true, force: true });
});

test('validation intent distinguishes building a website from running a build and respects explicit exclusions', () => {
  assert.deepEqual(requiredValidations('Build a React Vite website'), []);
  assert.deepEqual(requiredValidations('Create hello.js. Do not run commands.'), []);
  assert.deepEqual(requiredValidations('Create a website without running tests or builds'), []);
  assert.deepEqual(requiredValidations('Create an app and run npm run build'), ['build']);
  assert.deepEqual(requiredValidations('Run tests and check the build'), ['tests', 'build']);
  assert.deepEqual(requiredValidations('Fix the failing test'), ['tests']);
});

async function settled(service, task) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const saved = service.get('owner', task.id);
    if (saved.status !== 'running') return saved;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  service.cancel('owner', task.id);
  const cancellationDeadline = Date.now() + 15000;
  while (service.jobs.has(task.id) && Date.now() < cancellationDeadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.fail('Coding task did not settle');
}

function fixture(t, proposals) {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const files = new Map();
  const calls = [];
  const repository = new CodingTaskRepository(database);
  repository.grant('owner', 'project', 'binding', true);
  const service = new CodingAgentService({
    repository,
    model: {
      next: async (input) => {
        calls.push(input);
        const proposal = proposals.shift();
        if (proposal instanceof Error) throw proposal;
        assert.ok(proposal, 'Model must not be called beyond its planned observations');
        return { proposal };
      },
    },
  });
  const guard = {
    inspect: async () => ({ available: true }),
    checkpoint: async () => ({ checkpointId: 'checkpoint' }),
    read: async ({ path }) => ({
      path,
      content: files.get(path),
      version: fileVersion(files.get(path)),
    }),
    write: async ({ path, content }) => {
      files.set(path, content);
      return { path, changed: true, version: fileVersion(content), diff: `+${content}` };
    },
  };
  service.context = async (userId, workspaceId, { taskId, signal } = {}) => ({
    userId,
    workspaceId,
    taskId,
    signal,
    root: temporary,
    binding: 'binding',
    currentBinding: 'binding',
    files: guard,
  });
  const start = (extra = {}) =>
    service.start('owner', {
      workspaceId: 'project',
      model: 'local-coder',
      task: 'Create two source files',
      ...extra,
    });
  return { service, repository, files, calls, start };
}

test('coding proceeds past inspection and checkpoint through multiple edits to verified completion', async (t) => {
  const { service, files, start } = fixture(t, [
    {
      kind: 'tool',
      tool: 'fs.write',
      params: { path: 'first.js', content: 'export const first = 1;', expectedVersion: 'new' },
    },
    {
      kind: 'tool',
      tool: 'fs.write',
      params: { path: 'second.js', content: 'export const second = 2;', expectedVersion: 'new' },
    },
    { kind: 'finish', summary: 'Created both files' },
  ]);
  const task = await settled(service, await start());
  assert.equal(task.status, 'done', task.summary);
  assert.equal(files.size, 2);
  assert.deepEqual(
    task.state.state.attempts.map((a) => `${a.request.tool}.${a.request.action}`),
    ['workspace.inspect', 'checkpoint.create', 'fs.write', 'fs.write'],
  );
  assert.equal(task.changes.length, 2);
  assert.match(task.summary, /No project test or build command has run/);
});

test('approval resumes the exact configuration write and continues to the next action', async (t) => {
  const { service, files, start } = fixture(t, [
    {
      kind: 'tool',
      tool: 'fs.write',
      params: { path: 'package.json', content: '{"name":"demo"}', expectedVersion: 'new' },
    },
    { kind: 'finish', summary: 'Package created' },
  ]);
  let task = await settled(service, await start({ task: 'Create package.json' }));
  assert.equal(task.status, 'waiting_approval');
  assert.equal(files.size, 0);
  await service.approve('owner', task.id, task.approvals[0].approvalId, true);
  task = await settled(service, task);
  assert.equal(task.status, 'done', task.summary);
  assert.equal(files.get('package.json'), '{"name":"demo"}');
});

test('known failures persist their actionable error and release the workspace for retry', async (t) => {
  const failure = Object.assign(new Error('Choose a larger coding context.'), {
    code: 'CODING_CONTEXT_TOO_LARGE',
    status: 400,
  });
  const { service, start } = fixture(t, [
    failure,
    { kind: 'finish', summary: 'Inspection complete' },
  ]);
  const task = await settled(service, await start());
  assert.equal(task.status, 'blocked');
  assert.deepEqual(task.error, { code: failure.code, message: failure.message });
  assert.equal(task.events.at(-1).type, 'coding_error');
  assert.equal(service.workspaceJobs.size, 0);
  const retry = await settled(service, await start({ task: 'Explain the project' }));
  assert.equal(retry.status, 'done', retry.summary);
});

test('follow-up tasks carry owned conversation context but cannot cross workspace or account boundaries', async (t) => {
  const { service, calls, start } = fixture(t, [
    { kind: 'finish', summary: 'Inspected project' },
    { kind: 'finish', summary: 'Follow-up inspected' },
  ]);
  const first = await settled(service, await start({ task: 'Explain this project' }));
  const followup = await settled(
    service,
    await start({ task: 'Explain its structure in more detail', previousTaskId: first.id }),
  );
  assert.equal(followup.status, 'done');
  assert.equal(calls[1].history[0].previousConversation[0].goal, first.goal);
  await assert.rejects(start({ workspaceId: 'other-project', previousTaskId: first.id }), {
    code: 'WRITE_GRANT_REQUIRED',
  });
  const saved = service.repository.get('owner', first.id);
  saved.workspaceId = 'foreign-workspace';
  service.repository.save('owner', saved);
  await assert.rejects(start({ previousTaskId: first.id }), { code: 'TASK_WORKSPACE_MISMATCH' });
  await assert.rejects(
    service.start('other-owner', {
      task: 'Explain',
      workspaceId: 'project',
      model: 'local',
      previousTaskId: first.id,
    }),
    { code: 'WRITE_GRANT_REQUIRED' },
  );
});

test(
  'native Windows workspace task creates and verifies an actual file after checkpoint',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const project = path.join(temporary, 'native-project');
    await fs.mkdir(project);
    const database = new Database(':memory:');
    t.after(() => database.close());
    const proposals = [
      {
        kind: 'tool',
        tool: 'fs.write',
        params: {
          path: 'hello.js',
          content: 'export const hello = "world";\n',
          expectedVersion: 'new',
        },
      },
      { kind: 'finish', summary: 'File created' },
    ];
    const service = new CodingAgentService({
      repository: new CodingTaskRepository(database),
      workspace: async () => ({ root: project }),
      model: { next: async () => ({ proposal: proposals.shift() }) },
      storage: path.join(temporary, 'native-checkpoints'),
    });
    await service.authorize('owner', 'project', true);
    const task = await settled(
      service,
      await service.start('owner', {
        workspaceId: 'project',
        model: 'fixture',
        task: 'Create hello.js',
      }),
    );
    assert.equal(task.status, 'done', `${task.reason}: ${task.summary}`);
    assert.equal(
      await fs.readFile(path.join(project, 'hello.js'), 'utf8'),
      'export const hello = "world";\n',
    );
  },
);
