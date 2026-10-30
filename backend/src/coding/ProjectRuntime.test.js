import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startProjectProcess } from './WindowsProjectProcess.js';
import { ProjectRuntime } from './ProjectRuntime.js';
import { fileVersion } from './WorkspaceFiles.js';

test(
  'native process supervisor preserves argv, output and nonzero exit evidence',
  { skip: process.platform !== 'win32' },
  async () => {
    let output = '';
    const processHandle = await startProjectProcess(
      {
        executable: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify(process.argv.slice(1))); process.exit(7)',
          'space value',
          'quote"value',
          'trailing\\',
        ],
        cwd: os.tmpdir(),
        environment: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP },
      },
      { onOutput: (_channel, chunk) => (output += chunk) },
    );
    const result = await processHandle.completion;
    assert.equal(result.exitCode, 7);
    assert.deepEqual(JSON.parse(output), ['space value', 'quote"value', 'trailing\\']);
  },
);

test(
  'native process deadline stops a running project command',
  { skip: process.platform !== 'win32' },
  async () => {
    const processHandle = await startProjectProcess(
      {
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: os.tmpdir(),
        environment: { SystemRoot: process.env.SystemRoot },
      },
      { timeoutMs: 200 },
    );
    const result = await processHandle.completion;
    assert.equal(result.code, 'COMMAND_TIMEOUT');
    assert.notEqual(result.exitCode, 0);
  },
);

test(
  'cancelling a project command also terminates its spawned child',
  { skip: process.platform !== 'win32' },
  async () => {
    let output = '';
    const processHandle = await startProjectProcess(
      {
        executable: process.execPath,
        args: [
          '-e',
          'const {spawn}=require("node:child_process"); const p=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log(p.pid); setInterval(()=>{},1000)',
        ],
        cwd: os.tmpdir(),
        environment: { SystemRoot: process.env.SystemRoot },
      },
      { onOutput: (_channel, text) => (output += text) },
    );
    const deadline = Date.now() + 5000;
    while (!output.trim() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const child = Number(output.trim());
    assert.ok(child > 0);
    processHandle.stop();
    await processHandle.completion;
    assert.throws(() => process.kill(child, 0));
  },
);

test('project execution requires a root-bound grant and exact approval, without inheriting secrets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-runtime-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = new ProjectRuntime({
    storage: path.join(root, 'storage'),
    processStart: async () => assert.fail('Unapproved execution cannot spawn'),
  });
  const context = {
    root,
    userId: 'owner',
    workspaceId: 'project',
    files: { list: async () => ({ entries: [] }) },
    executionPolicy: { commands: false, downloads: false },
  };
  await assert.rejects(
    runtime.preview('exec.run', { executable: 'node', args: ['--version'] }, context),
    { code: 'EXECUTION_GRANT_REQUIRED' },
  );
  await assert.rejects(
    runtime.run(
      'exec.run',
      { executable: 'node', args: ['--version'] },
      { ...context, executionPolicy: { commands: true } },
    ),
    { code: 'COMMAND_APPROVAL_REQUIRED' },
  );
  await assert.rejects(
    runtime.preview(
      'deps.install',
      { manager: 'npm', packages: ['is-number'] },
      { ...context, executionPolicy: { commands: true, downloads: false } },
    ),
    { code: 'DOWNLOAD_GRANT_REQUIRED' },
  );
  const env = runtime.environment({ root });
  assert.equal(env.CHANAKYA_CLIENT_SECRET, undefined);
  assert.equal(env.TOOL_ENGINE_SESSION_SECRET, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.notEqual(env.npm_config_userconfig, env.npm_config_globalconfig);
});

test('an empty unittest discovery cannot claim tests passed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-empty-tests-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = new ProjectRuntime({
    storage: path.join(root, 'runtime'),
    processStart: async (_plan, { onOutput }) => {
      onOutput('stderr', 'Ran 0 tests in 0.000s\n\nOK\n');
      return { completion: Promise.resolve({ exitCode: 0 }), stop() {} };
    },
  });
  runtime.discover = async () => ({
    python: { available: true, path: process.execPath },
    node: { path: process.execPath },
  });
  const result = await runtime.run(
    'tests.run',
    { executable: 'python', args: ['-m', 'unittest', 'discover'] },
    {
      root,
      userId: 'owner',
      workspaceId: 'project',
      approved: true,
      executionPolicy: { commands: true },
      files: { list: async () => ({ entries: [] }) },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.success, false);
  assert.equal(result.code, 'NO_TESTS_DISCOVERED');
});

test(
  'approved commands execute locally and a changed entry point invalidates approval',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-runtime-approved-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'check.js'), 'console.log("verified-run")');
    const files = {
      list: async () => ({ entries: [] }),
      read: async ({ path: name }) => {
        const content = await fs.readFile(path.join(root, name), 'utf8');
        return { path: name, content, version: fileVersion(content) };
      },
    };
    const runtime = new ProjectRuntime({ storage: path.join(root, 'storage') });
    const context = {
      root,
      userId: 'owner',
      workspaceId: 'project',
      files,
      approved: true,
      executionPolicy: { commands: true, downloads: true },
    };
    const params = { executable: 'node', args: ['check.js'] };
    const preview = await runtime.preview('exec.run', params, context);
    const result = await runtime.run('exec.run', params, { ...context, executionPreview: preview });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /verified-run/);
    await fs.writeFile(path.join(root, 'check.js'), 'console.log("external-change")');
    await assert.rejects(
      runtime.run('exec.run', params, { ...context, executionPreview: preview }),
      { code: 'FILE_CONFLICT' },
    );
    await assert.rejects(
      runtime.preview('exec.run', { executable: 'cmd.exe', args: ['/c', 'echo no'] }, context),
      { code: 'COMMAND_DENIED' },
    );
    await assert.rejects(
      runtime.preview(
        'deps.install',
        { manager: 'pip', packages: ['https://example.com/code.whl'] },
        context,
      ),
      (error) => ['PACKAGE_SPEC_DENIED', 'RUNTIME_MISSING'].includes(error.code),
    );
  },
);
