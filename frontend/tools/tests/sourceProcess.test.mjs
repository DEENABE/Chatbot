import test from 'node:test';
import assert from 'node:assert/strict';
import { runSourceProcess } from '../software/providers/discoverProviders.js';
import { ExecutionLedger } from '../ExecutionLedger.js';
import { reportExecutionProgress } from '../ExecutionContext.js';

test('a finished package manager settles even if a descendant holds its output pipe open', async () => {
  const script = `
    require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},2000)'], {
      stdio: ['ignore', process.stdout, process.stderr], windowsHide: true
    });
    console.log('fixture installer cancelled');
    process.exit(7);
  `;
  const result = await runSourceProcess(process.execPath, ['-e', script], { timeout: 1200 });
  assert.equal(result.code, 7);
  assert.equal(result.timedOut, false);
  assert.match(result.out, /fixture installer cancelled/);
});

test('execution progress binds to the authenticated request and always clears after completion', async () => {
  const progress = [];
  const ledger = new ExecutionLedger({
    dispatch: async () => {
      reportExecutionProgress('installing', 'Installing fixture software…');
      return { success: true };
    },
  });
  await ledger.execute(
    'renderer:fixture-1',
    {
      tool: 'software',
      action: 'install',
      params: { planId: 'fixture-plan' },
      requestId: 'fixture-request',
      idempotencyKey: 'fixture-key',
      toolCallId: 'fixture-call',
    },
    null,
    { modelRoute: 'windows', onProgress: (event) => progress.push(event) },
  );
  assert.deepEqual(
    progress.map((event) => event.stage),
    ['installing', 'complete'],
  );
  assert.ok(
    progress.every(
      (event) => event.scope === 'renderer:fixture-1' && event.requestId === 'fixture-request',
    ),
  );
});
