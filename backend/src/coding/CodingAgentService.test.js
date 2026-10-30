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
    list: async () => ({ entries: [] }),
    mkdir: async ({ path }) => ({ path, changed: true, createdDirectories: [path] }),
    search: async ({ path }) => ({ path, results: [] }),
    read: async ({ path }) => {
      if (!files.has(path))
        throw Object.assign(new Error('Missing file'), { code: 'FILE_NOT_FOUND' });
      return { path, content: files.get(path), version: fileVersion(files.get(path)) };
    },
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
    ['workspace.inspect', 'checkpoint.create', 'fs.list', 'fs.write', 'fs.write'],
  );
  assert.equal(task.changes.length, 2);
  assert.match(task.summary, /No project test or build command has run/);
});

test('run that file launches the last HTML change without installing npm packages or asking the model', async (t) => {
  const { service, repository, start, calls } = fixture(t, [
    {
      kind: 'tool',
      tool: 'fs.write',
      params: { path: 'public/index.html', content: '<h1>Hello</h1>', expectedVersion: 'new' },
    },
    { kind: 'finish', summary: 'HTML created' },
  ]);
  const previous = await settled(service, await start({ task: 'Create hello world HTML' }));
  assert.equal(previous.status, 'done');
  repository.setExecutionPolicy('owner', 'project', 'binding', {
    commands: true,
    downloads: false,
  });
  let launches = 0;
  service.engine.runtime = {
    inspect: async () => ({ node: { available: true } }),
    preview: async (tool, params) => {
      assert.equal(tool, 'preview.start');
      assert.equal(params.path, 'public/index.html');
      return { command: 'Preview HTML', message: 'Serve locally', observedFiles: [] };
    },
    run: async () => {
      launches++;
      return {
        jobId: 'preview',
        status: 'running',
        previewUrl: 'http://127.0.0.1:5175/entry/index.html',
      };
    },
    output: () => ({ status: 'running' }),
  };
  let task = await settled(
    service,
    await start({ task: 'run that file', previousTaskId: previous.id }),
  );
  assert.equal(task.status, 'waiting_approval');
  assert.equal(launches, 0);
  await service.approve('owner', task.id, task.approvals[0].approvalId, true);
  task = await settled(service, task);
  assert.equal(task.status, 'done', task.summary);
  assert.match(task.summary, /Project app started/);
  assert.equal(launches, 1);
  assert.equal(calls.length, 2, 'the run-only follow-up must not generate a guessed npm command');
});

test('a failed command reports its actual missing-script error instead of a generic validation message', async (t) => {
  const { service, repository, start, files } = fixture(t, [
    { kind: 'tool', tool: 'exec.run', params: { executable: 'npm', args: ['start'] } },
    { kind: 'finish', summary: 'Done' },
    { kind: 'finish', summary: 'Done' },
    { kind: 'finish', summary: 'Done' },
  ]);
  files.set('package.json', '{}');
  repository.setExecutionPolicy('owner', 'project', 'binding', {
    commands: true,
    downloads: false,
  });
  service.engine.runtime = {
    inspect: async () => ({}),
    preview: async () => ({ command: 'npm start', message: 'Runs locally' }),
    run: async () => ({
      exitCode: 1,
      stderr: 'npm error Missing script: "start"',
      stdout: '',
      code: 'COMMAND_FAILED',
    }),
  };
  let task = await settled(service, await start({ task: 'Run npm start' }));
  assert.equal(task.status, 'waiting_approval');
  await service.approve('owner', task.id, task.approvals[0].approvalId, true);
  task = await settled(service, task);
  assert.equal(task.status, 'blocked');
  assert.equal(task.reason, 'COMMAND_FAILED');
  assert.match(task.summary, /npm start.*exit 1.*Missing script/);
});

test('a requested py_compile or Node syntax command satisfies syntax validation', () => {
  assert.deepEqual(requiredValidations('Run python -m py_compile app.py'), ['syntax']);
  assert.deepEqual(requiredValidations('Run node --check app.js'), ['syntax']);
});

test('run planning preserves a quoted filename and never falls back from an absolute or ambiguous target', async (t) => {
  const { service, files } = fixture(t, []);
  files.set('public/my page.html', '<h1>Page</h1>');
  const context = await service.context('owner', 'project');
  const job = {
    context,
    task: {
      goal: 'preview "public/my page.html"',
      changes: [],
      conversation: [{ changedFiles: ['public/my page.html'] }],
    },
  };
  assert.deepEqual(await service.runRequest(job), {
    tool: 'preview.start',
    params: { path: 'public/my page.html' },
  });
  for (const goal of [
    'run C:\\outside\\secret.html',
    'run foo.html or bar.html',
    'preview /outside/index.html',
  ]) {
    job.task.goal = goal;
    assert.equal(await service.runRequest(job), null);
  }
});

test('validation classification follows the actual build/unittest command through either execution tool', async (t) => {
  const { service, repository, start } = fixture(t, [
    { kind: 'tool', tool: 'tests.run', params: { executable: 'npm', args: ['run', 'build'] } },
    {
      kind: 'tool',
      tool: 'exec.run',
      params: { executable: 'python', args: ['-m', 'unittest', 'discover', '-s', 'src'] },
    },
    { kind: 'finish', summary: 'Checks passed' },
  ]);
  repository.setExecutionPolicy('owner', 'project', 'binding', {
    commands: true,
    downloads: false,
  });
  service.engine.runtime = {
    inspect: async () => ({ node: { available: true }, python: { available: true } }),
    preview: async () => ({
      command: 'approved check',
      message: 'Runs locally',
      observedFiles: [],
    }),
    run: async () => ({ exitCode: 0, stdout: '1 test passed', stderr: '' }),
  };
  let task = await settled(service, await start({ task: 'Run tests and check the build' }));
  for (let i = 0; i < 2; i++) {
    assert.equal(task.status, 'waiting_approval');
    await service.approve('owner', task.id, task.approvals[0].approvalId, true);
    task = await settled(service, task);
  }
  assert.equal(task.status, 'done', task.summary);
  assert.deepEqual(
    task.validation.map((v) => v.kind),
    ['build', 'tests'],
  );
});

test('premature finish schedules actual Python tests and syntax checks through exact approvals', async (t) => {
  const { service, repository, start } = fixture(t, [
    {
      kind: 'tool',
      tool: 'fs.write',
      params: {
        path: 'calculator.py',
        content: 'def add(a,b): return a+b',
        expectedVersion: 'new',
      },
    },
    {
      kind: 'tool',
      tool: 'fs.write',
      params: { path: 'test_calculator.py', content: 'import calculator', expectedVersion: 'new' },
    },
    { kind: 'finish', summary: 'Created files' },
    { kind: 'finish', summary: 'Tests complete' },
    { kind: 'finish', summary: 'All complete' },
  ]);
  repository.setExecutionPolicy('owner', 'project', 'binding', {
    commands: true,
    downloads: false,
  });
  const commands = [];
  service.engine.runtime = {
    inspect: async () => ({ python: { available: true } }),
    preview: async (_tool, params) => ({
      command: params.args.join(' '),
      message: 'Runs locally',
      observedFiles: [],
    }),
    run: async (_tool, params) => {
      commands.push(params.args);
      return { exitCode: 0, stdout: 'Ran 1 test\nOK', stderr: '' };
    },
  };
  let task = await settled(service, await start({ task: 'Create a Python calculator with tests' }));
  assert.equal(commands.length, 0, 'automatic checks must not bypass approval');
  for (let i = 0; i < 2; i++) {
    assert.equal(task.status, 'waiting_approval', task.summary);
    await service.approve('owner', task.id, task.approvals[0].approvalId, true);
    task = await settled(service, task);
  }
  assert.equal(task.status, 'done', task.summary);
  assert.deepEqual(commands, [
    ['-m', 'unittest', 'discover', '-s', '.'],
    ['-m', 'py_compile', 'calculator.py', 'test_calculator.py'],
  ]);
});

test('source edits invalidate earlier passing validation and require a fresh approved check', async (t) => {
  const original = 'x = 1',
    updated = 'x = 2';
  const { service, repository, start } = fixture(t, [
    {
      kind: 'tool',
      tool: 'fs.write',
      params: { path: 'calculator.py', content: original, expectedVersion: 'new' },
    },
    {
      kind: 'tool',
      tool: 'exec.run',
      params: { executable: 'python', args: ['-m', 'py_compile', 'calculator.py'] },
    },
    {
      kind: 'tool',
      tool: 'fs.write',
      params: { path: 'calculator.py', content: updated, expectedVersion: fileVersion(original) },
    },
    { kind: 'finish', summary: 'Edited after check' },
    { kind: 'finish', summary: 'Current file checked' },
  ]);
  repository.setExecutionPolicy('owner', 'project', 'binding', {
    commands: true,
    downloads: false,
  });
  let checks = 0;
  service.engine.runtime = {
    inspect: async () => ({ python: { available: true } }),
    preview: async () => ({
      command: 'python -m py_compile calculator.py',
      message: 'Runs locally',
      observedFiles: [],
    }),
    run: async () => {
      checks++;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  let task = await settled(service, await start({ task: 'Create a Python calculator' }));
  for (let i = 0; i < 2; i++) {
    assert.equal(task.status, 'waiting_approval', task.summary);
    await service.approve('owner', task.id, task.approvals[0].approvalId, true);
    task = await settled(service, task);
  }
  assert.equal(task.status, 'done', task.summary);
  assert.equal(checks, 2);
  assert.notEqual(task.validation[0].changeRevision, task.validation[1].changeRevision);
});

test('absolute project-root search and nested directory creation continue to verified source files', async (t) => {
  const { service, files, start } = fixture(t, [
    {
      kind: 'tool',
      tool: 'code.search',
      params: { query: 'create-react-app', path: temporary, maxResults: 1 },
    },
    { kind: 'tool', tool: 'fs.mkdir', params: { path: path.join(temporary, 'src') } },
    {
      kind: 'tool',
      tool: 'fs.write',
      params: {
        path: path.join(temporary, 'src', 'App.jsx'),
        content: 'export default function App() { return <h1>Hello</h1>; }',
        expectedVersion: 'new',
      },
    },
    { kind: 'finish', summary: 'Source created' },
  ]);
  service.starterProjects = false; // exercises the model-only path
  const task = await settled(service, await start({ task: 'Create a React Vite website' }));
  assert.equal(task.status, 'done', `${task.reason}: ${task.summary}`);
  assert.deepEqual(task.directories, ['src']);
  assert.deepEqual(
    task.changes.map((change) => change.path),
    ['src/App.jsx'],
  );
  assert.ok(files.has('src/App.jsx'));
  assert.match(task.summary, /1 created directory verified/);
});

test('creating only a directory cannot claim a website has been implemented', async (t) => {
  const { service, start } = fixture(t, [
    { kind: 'tool', tool: 'fs.mkdir', params: { path: 'src' } },
    { kind: 'finish', summary: 'Website created' },
  ]);
  service.starterProjects = false; // exercises the model-only path
  const task = await settled(
    service,
    await start({ task: 'Create a React website with a source directory' }),
  );
  assert.equal(task.status, 'blocked');
  assert.equal(task.reason, 'NO_VERIFIED_CHANGES');
});

test('a requested source folder is verified as a directory rather than read as a text file', async (t) => {
  const { service, start } = fixture(t, [
    { kind: 'tool', tool: 'fs.mkdir', params: { path: 'src' } },
    { kind: 'finish', summary: 'Folder created' },
  ]);
  const task = await settled(service, await start({ task: 'Create a source folder' }));
  assert.equal(task.status, 'done', task.summary);
  assert.deepEqual(task.directories, ['src']);
  assert.equal(task.changes.length, 0);
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
    const canonical = await fs.realpath(project);
    const database = new Database(':memory:');
    t.after(() => database.close());
    const proposals = [
      {
        kind: 'tool',
        tool: 'code.search',
        params: { query: 'create-react-app', path: canonical, maxResults: 1 },
      },
      { kind: 'tool', tool: 'fs.mkdir', params: { path: path.join(canonical, 'src') } },
      {
        kind: 'tool',
        tool: 'fs.write',
        params: {
          path: path.join(canonical, 'src', 'hello.js'),
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
      await fs.readFile(path.join(project, 'src', 'hello.js'), 'utf8'),
      'export const hello = "world";\n',
    );
  },
);

test('rewriting an unchanged file twice never kills the task; the server verifies instead', async (t) => {
  const content = 'export const a = 1;';
  const sameWrite = {
    kind: 'tool',
    tool: 'fs.write',
    params: { path: 'a.js', content, expectedVersion: fileVersion(content) },
  };
  const { service, files, calls, start } = fixture(t, [
    { kind: 'tool', tool: 'fs.write', params: { path: 'a.js', content, expectedVersion: 'new' } },
    sameWrite, // harmless no-op, reported as success
    sameWrite, // identical repeat on unchanged state: stop asking the model, check the project
  ]);
  const task = await settled(service, await start());
  assert.equal(task.status, 'done', task.summary);
  assert.equal(files.get('a.js'), content);
  assert.equal(task.changes.length, 1);
  assert.equal(calls.length, 3);
  assert.ok(task.events.some((e) => e.type === 'repeat_blocked'));
});

test('a Vite model that puts index.html in src/ is corrected instead of failing the task', async (t) => {
  const html =
    '<!doctype html><div id="root"></div><script type="module" src="/src/main.jsx"></script>';
  const wrong = {
    kind: 'tool',
    tool: 'fs.write',
    params: { path: 'src/index.html', content: html, expectedVersion: 'new' },
  };
  const { service, files, start } = fixture(t, [
    wrong,
    wrong, // the same mistake twice used to end the task
    {
      kind: 'tool',
      tool: 'fs.write',
      params: { path: 'index.html', content: html, expectedVersion: 'new' },
    },
    { kind: 'finish', summary: 'Done' },
  ]);
  files.set('package.json', '{"devDependencies":{"vite":"^5.0.0"}}');
  service.starterProjects = false; // exercises the model-only path
  const task = await settled(service, await start({ task: 'Create a React + Vite website' }));
  assert.equal(task.status, 'done', task.summary);
  assert.ok(files.has('index.html'));
  assert.ok(!files.has('src/index.html'));
  const codes = task.state.state.attempts.map((a) => a.observation?.error?.code).filter(Boolean);
  assert.ok(codes.includes('WRONG_LOCATION'));
});

test('the automatic build check installs packages first when node_modules is missing', async (t) => {
  const { service, repository } = fixture(t, []);
  const manifest = JSON.stringify({
    scripts: { build: 'vite build' },
    devDependencies: { vite: '^5.0.0' },
  });
  const job = (hasModules) => ({
    userId: 'owner',
    task: {
      workspaceId: 'project',
      binding: 'binding',
      goal: 'x',
      changes: [{ path: 'src/App.jsx', version: 'v' }],
      events: [],
    },
    context: {
      files: {
        read: async () => ({ content: manifest }),
        list: async () => (hasModules ? { entries: [] } : Promise.reject(new Error('no dir'))),
      },
    },
  });
  repository.setExecutionPolicy('owner', 'project', 'binding', { commands: true, downloads: true });
  assert.deepEqual((await service.nextValidation(job(false), 'build')).tool, 'deps.install');
  assert.deepEqual((await service.nextValidation(job(true), 'build')).params.args, [
    'run',
    'build',
  ]);
  repository.setExecutionPolicy('owner', 'project', 'binding', {
    commands: true,
    downloads: false,
  });
  assert.deepEqual((await service.nextValidation(job(false), 'build')).params.args, [
    'run',
    'build',
  ]);
});

test('a React + Vite request gets a runnable starter without per-file approvals', async (t) => {
  const { service, files, calls, start } = fixture(t, [{ kind: 'finish', summary: 'Ready' }]);
  const task = await settled(service, await start({ task: 'Create a React + Vite website' }));
  assert.equal(task.status, 'done', task.summary);
  assert.deepEqual([...files.keys()].sort(), [
    'index.html',
    'package.json',
    'src/App.css',
    'src/App.jsx',
    'src/index.css',
    'src/main.jsx',
    'vite.config.js',
  ]);
  assert.equal(JSON.parse(files.get('package.json')).scripts.build, 'vite build');
  assert.ok(task.events.some((event) => event.type === 'project_scaffold'));
  const history = calls[0].history.at(-2);
  assert.match(history.projectScaffold, /already created a working React \+ Vite project/);
  // The model's own config writes still need approval.
  assert.equal(task.approvals.length, 0);
});
