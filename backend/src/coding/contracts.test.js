import test from 'node:test';
import assert from 'node:assert/strict';
import { CODING_TOOLS, validateCall, codingRisk, digest } from './contracts.js';
import { CommandExecutionService } from './CommandExecutionService.js';

test('coding manifest has fixed unique tools, complete schemas, risks and bounded timeouts', () => {
  assert.equal(new Set(CODING_TOOLS.map((t) => t.name)).size, CODING_TOOLS.length);
  for (const tool of CODING_TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.outputSchema.required.includes('success'));
    assert.deepEqual(tool.allowedScopes, ['coding']);
    assert.ok(tool.timeout > 0 && tool.timeout <= 300000);
  }
  assert.throws(() => validateCall({ tool: 'process.startProcess', params: {} }), {
    code: 'TOOL_DENIED',
  });
  assert.throws(
    () =>
      validateCall({
        tool: 'fs.write',
        params: { path: 'main.js', content: 'hello', expectedVersion: 'new', approved: true },
      }),
    { code: 'INVALID_TOOL_INPUT' },
  );
  assert.throws(
    () =>
      validateCall({
        tool: 'fs.patch',
        params: { path: 'a', search: '', replace: 'b', expectedVersion: 'new' },
      }),
    { code: 'INVALID_TOOL_INPUT' },
  );
  assert.throws(() => validateCall({ tool: 'exec.run', params: { command: 'node; malicious' } }), {
    code: 'INVALID_TOOL_INPUT',
  });
  assert.throws(
    () => validateCall(JSON.parse('{"tool":"fs.read","params":{"path":"a","__proto__":{}}}')),
    { code: 'INVALID_TOOL_INPUT' },
  );
});
test('configuration changes require approval and previews cannot authorize mutations', () => {
  const write = CODING_TOOLS.find((t) => t.name === 'fs.write');
  assert.equal(codingRisk(write, { path: 'src/feature.js' }), 'SAFE_WRITE');
  for (const name of [
    'package.json',
    'package-lock.json',
    'pyproject.toml',
    'src/settings.config.js',
    'deploy.yaml',
  ])
    assert.equal(codingRisk(write, { path: name }), 'DANGEROUS');
  assert.equal(
    codingRisk(
      CODING_TOOLS.find((t) => t.name === 'fs.patch'),
      { path: 'package.json', preview: true },
    ),
    'READ',
  );
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});
test('project execution fails closed without actual trusted OS confinement', async () => {
  const commands = new CommandExecutionService();
  const root = process.cwd();
  await assert.rejects(commands.run({ executable: 'node', args: ['--test'] }, { root }), {
    code: 'ISOLATION_UNAVAILABLE',
  });
  for (const executable of [
    'cmd.exe',
    'powershell.exe',
    'pwsh',
    'npm.cmd',
    '../node',
    'C:\\node.exe',
  ])
    await assert.rejects(commands.run({ executable, args: [] }, { root }), {
      code: 'COMMAND_DENIED',
    });
  await assert.rejects(commands.run({ executable: 'node', args: [], cwd: '../' }, { root }), {
    code: 'WORKSPACE_PATH_DENIED',
  });
  await assert.rejects(
    commands.run({ executable: 'npm', args: ['install', 'anything'] }, { root }),
    { code: 'DEPENDENCY_INSTALL_BLOCKED' },
  );
  const partial = new CommandExecutionService({
    isolation: {
      capabilities: { workspaceIsolation: true },
      run: () => assert.fail('partial confinement cannot execute'),
    },
  });
  await assert.rejects(partial.run({ executable: 'node', args: [] }, { root }), {
    code: 'ISOLATION_UNAVAILABLE',
  });
});
test('trusted injected confinement receives structured argv, no secrets, shell=false and output limits', async () => {
  let received;
  const commands = new CommandExecutionService({
    isolation: {
      capabilities: {
        workspaceIsolation: true,
        networkDenied: true,
        processTreeCleanup: true,
        environmentRestricted: true,
      },
      run: async (value) => {
        received = value;
        return { exitCode: 0, stdout: 'fixture', stderr: '', durationMs: 1 };
      },
    },
  });
  const result = await commands.run(
    { executable: 'node', args: ['--test', 'test file.js'], timeoutMs: 2000 },
    { root: process.cwd() },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(received.args, ['--test', 'test file.js']);
  assert.equal(received.shell, false);
  assert.deepEqual(received.environment, {});
  assert.equal(received.maxOutputBytes, 1048576);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    commands.run(
      { executable: 'node', args: [] },
      { root: process.cwd(), signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
});
