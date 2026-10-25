import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.APP_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-tests-'));
const { repairTask } = await import('./RepairTask.js');
const { runDiagnosticRepair, diagnosticPlan } = await import('./DiagnosticRepair.js');
const { validateCapability } = await import('./CapabilityContracts.js');
const { ALLOWED_ACTIONS } = await import('./OrchestratorPlanner.js');

test('repair admission accepts symptoms and Tanglish but leaves ordinary printer questions in chat', () => {
  for (const text of ['my wifi is not working', 'fix my internet', 'wifi work agala'])
    assert.equal(repairTask(text)?.domain, 'network');
  assert.equal(repairTask('fix my printer')?.domain, 'spooler');
  assert.equal(repairTask('my laptop is running slow')?.domain, 'system');
  assert.equal(repairTask('bluetooth connect agala')?.domain, 'bluetooth');
  for (const text of [
    'What is a printer?',
    'Explain the print spooler',
    'write a story about printing',
    'open printer settings',
  ])
    assert.equal(repairTask(text), null);
});
test('every fixed diagnostic plan passes the existing capability manifest', () => {
  for (const domain of ['network', 'bluetooth', 'audio', 'system'])
    for (const step of diagnosticPlan(domain)) {
      assert.ok(
        ALLOWED_ACTIONS.some((a) => a.tool === step.tool && a.action === step.action),
        JSON.stringify(step),
      );
      assert.equal(
        validateCapability(step.tool, step.action, step.params),
        null,
        JSON.stringify(step),
      );
    }
});
test('network repair collects fresh evidence but never claims diagnostic checks repaired the issue', async () => {
  const calls = [],
    events = [];
  const result = await runDiagnosticRepair({
    goal: 'fix my internet',
    domain: 'network',
    userId: randomUUID(),
    onEvent: (e) => events.push(e),
    dependencies: {
      save: () => {},
      executeStep: async (step) => {
        calls.push(`${step.tool}.${step.action}`);
        return { success: true, data: { observed: true } };
      },
      complete: async () => ({
        summary: 'The network adapter was inspected.',
        recommendation: 'Check the router connection.',
      }),
    },
  });
  assert.deepEqual(calls, ['hardware.networkAdapters', 'network.ipConfig', 'network.ping']);
  assert.equal(result.success, true);
  assert.equal(result.resolved, false);
  assert.equal(result.scope, 'diagnostics_only');
  assert.match(result.answer, /No system changes were made/);
  assert.equal(events.filter((e) => e.type === 'final').length, 1);
});
test('a denied diagnostic stops the plan without model fallback or further commands', async () => {
  let calls = 0;
  const result = await runDiagnosticRepair({
    goal: 'fix my PC',
    domain: 'system',
    userId: randomUUID(),
    dependencies: {
      save: () => {},
      executeStep: async () => {
        calls++;
        return {
          success: false,
          error: { code: 'PERMISSION_DENIED', message: 'Denied by policy.' },
        };
      },
      complete: async () => assert.fail('must not review a denied plan'),
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.success, false);
  assert.equal(result.resolved, false);
  assert.match(result.answer, /Denied/);
});
