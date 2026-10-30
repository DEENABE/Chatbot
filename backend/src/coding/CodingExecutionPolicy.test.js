import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { CodingTaskRepository } from './CodingTaskRepository.js';
import { CodingToolEngine } from './CodingToolEngine.js';

test('command/download grants require the same owner, root identity and write grant', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const repo = new CodingTaskRepository(db);
  repo.grant('owner', 'project', 'root', true);
  repo.setExecutionPolicy('owner', 'project', 'root', { commands: true, downloads: true });
  assert.deepEqual(repo.executionPolicy('owner', 'project', 'root'), {
    commands: true,
    downloads: true,
  });
  for (const args of [
    ['other', 'project', 'root'],
    ['owner', 'other', 'root'],
    ['owner', 'project', 'new-root'],
  ])
    assert.deepEqual(repo.executionPolicy(...args), { commands: false, downloads: false });
  assert.throws(
    () => repo.setExecutionPolicy('owner', 'project', 'root', { commands: false, downloads: true }),
    { code: 'INVALID_EXECUTION_POLICY' },
  );
  repo.grant('owner', 'project', 'root', false);
  assert.deepEqual(repo.executionPolicy('owner', 'project', 'root'), {
    commands: false,
    downloads: false,
  });
});

test('command approval is one-use and rechecks permissions before dispatch', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const repository = new CodingTaskRepository(db);
  repository.grant('owner', 'project', 'root', true);
  repository.setExecutionPolicy('owner', 'project', 'root', { commands: true, downloads: false });
  let executions = 0;
  const engine = new CodingToolEngine({
    repository,
    runtime: {
      preview: async (_tool, _params, context) => {
        if (!context.executionPolicy.commands)
          throw Object.assign(new Error('Permission revoked'), {
            code: 'EXECUTION_GRANT_REQUIRED',
            status: 403,
          });
        return {
          command: 'node --version',
          message: 'Runs with your account access',
          observedFiles: [],
        };
      },
      run: async (_tool, _params, context) => {
        if (!context.executionPolicy.commands)
          throw Object.assign(new Error('Permission revoked'), {
            code: 'EXECUTION_GRANT_REQUIRED',
            status: 403,
          });
        executions++;
        assert.ok(context.executionPreview);
        return { exitCode: 0 };
      },
    },
  });
  const context = {
    userId: 'owner',
    workspaceId: 'project',
    binding: 'root',
    currentBinding: 'root',
    root: 'D:\\project',
    files: {},
  };
  const request = { tool: 'exec.run', params: { executable: 'node', args: ['--version'] } };
  const first = await engine.execute(request, context);
  assert.equal(first.needsConfirmation, true);
  assert.equal(executions, 0);
  assert.equal(
    (await engine.approve('owner', 'project', first.approvalId, true, context)).success,
    true,
  );
  await assert.rejects(engine.approve('owner', 'project', first.approvalId, true, context), {
    code: 'APPROVAL_INVALID',
  });
  const second = await engine.execute(request, context);
  repository.setExecutionPolicy('owner', 'project', 'root', { commands: false, downloads: false });
  assert.equal(
    (await engine.approve('owner', 'project', second.approvalId, true, context)).error.code,
    'EXECUTION_GRANT_REQUIRED',
  );
  assert.equal(executions, 1);
  const editOnly = engine.definitions({ commands: false, downloads: false }).map((t) => t.name);
  assert.ok(!editOnly.includes('exec.run') && !editOnly.includes('deps.install'));
  const runOnly = engine.definitions({ commands: true, downloads: false }).map((t) => t.name);
  assert.ok(runOnly.includes('exec.run') && !runOnly.includes('deps.install'));
});

test('package installs run without a prompt only when the project allows downloads', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const repository = new CodingTaskRepository(db);
  repository.grant('owner', 'project', 'root', true);
  const installs = [];
  const engine = new CodingToolEngine({
    repository,
    runtime: {
      preview: async () => ({ command: 'npm install three', message: '', observedFiles: [] }),
      run: async (tool, params) => {
        installs.push({ tool, params });
        return { exitCode: 0 };
      },
    },
  });
  const context = {
    userId: 'owner',
    workspaceId: 'project',
    binding: 'root',
    currentBinding: 'root',
    root: 'D:\project',
    files: {},
  };
  const install = { tool: 'deps.install', params: { manager: 'npm', packages: ['three'] } };

  repository.setExecutionPolicy('owner', 'project', 'root', { commands: true, downloads: false });
  assert.equal((await engine.execute(install, context)).needsConfirmation, true);
  assert.equal(installs.length, 0);

  repository.setExecutionPolicy('owner', 'project', 'root', { commands: true, downloads: true });
  const granted = await engine.execute(install, context);
  assert.equal(granted.success, true);
  assert.equal(installs.length, 1);

  // Running software on the machine still needs its own approval.
  const python = await engine.execute(
    { tool: 'runtime.install', params: { runtime: 'python' } },
    context,
  );
  assert.equal(python.needsConfirmation, true);
  assert.equal(installs.length, 1);
});
