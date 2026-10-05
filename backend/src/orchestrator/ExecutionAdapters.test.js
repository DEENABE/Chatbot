import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOrchestrator } from './AgentOrchestrator.js';
import { runLegacyExecution } from './LegacyExecutionAdapter.js';
import { createChatExecution, executeChatCall, finishChat } from '../../../frontend/src/services/chatExecution.js';
import { createCheckpointStore } from './CheckpointStore.js';
import { restoreCheckpoint } from './AgentState.js';
import { normaliseObservation } from './ObservationHandler.js';

const step = { tool: 'hardware', action: 'systemInfo', params: {}, status: 'pending' };
async function orchestrator(options = {}, overrides = {}) {
  const checkpoints = []; let calls = 0; let verifies = 0;
  const result = await runOrchestrator({ task: 'system diagnostics', ...options, dependencies: {
    save: c => checkpoints.push(c), createLogger: () => ({ log() {} }), routeTask: async () => ({ mode: 'agentic', taskType: 'system_diagnostics' }),
    createOrchestratorPlan: async () => ({ steps: [step] }),
    executeStep: async s => { calls++; return { success: true, toolCallId: s.toolCallId }; },
    verifyOutcome: async () => { verifies++; return { success: true, summary: 'Completed.' }; },
    replan: async () => ({ steps: [step] }), ...overrides,
  } });
  return { result, checkpoints, calls, verifies };
}
test('orchestrator completes exactly at step budget', async () => {
  const { result, calls, checkpoints } = await orchestrator({ maxSteps: 1 });
  assert.equal(result.success, true); assert.equal(calls, 1); assert.equal(result.phase, 'done');
  assert.equal(checkpoints.at(-1).state.phase, 'done');
});
test('failure/replan/success retains attempt evidence and fresh identities', async () => {
  let n = 0;
  const { result, checkpoints } = await orchestrator({}, { executeStep: async () => ({ success: ++n > 1 }) });
  assert.equal(result.success, true); assert.equal(result.retryCount, 1);
  const attempts = checkpoints.at(-1).state.attempts;
  assert.equal(attempts[0].observation.success, false);
  assert.notEqual(attempts[0].request.toolCallId, attempts[1].request.toolCallId);
});
test('retry exhaustion fails and never invokes verifier', async () => {
  const { result, verifies } = await orchestrator({ maxRetries: 1 }, { executeStep: async () => ({ success: false }) });
  assert.equal(result.phase, 'error'); assert.equal(result.stepCount, 2); assert.equal(verifies, 0);
});
test('step exhaustion fails without interpreting partial work as success', async () => {
  const { result, verifies } = await orchestrator({ maxSteps: 1 }, { createOrchestratorPlan: async () => ({ steps: [step, step] }) });
  assert.equal(result.success, false); assert.equal(result.stopped, 'max_steps'); assert.equal(verifies, 0);
});
test('confirmation and cancelled calls cannot verify as success', async () => {
  const wait = await orchestrator({}, { executeStep: async () => ({ needsConfirmation: true, confirmationId: 'c' }) });
  assert.equal(wait.result.phase, 'waiting_confirmation'); assert.equal(wait.verifies, 0);
  const abort = new AbortController();
  const cancelled = await orchestrator({ signal: abort.signal }, { executeStep: async () => { abort.abort(); return { success: true }; } });
  assert.equal(cancelled.result.phase, 'cancelled'); assert.equal(cancelled.verifies, 0);
});
test('planner/replanner exceptions and empty replans terminate', async () => {
  for (const overrides of [
    { createOrchestratorPlan: async () => { throw new Error('planner down'); } },
    { executeStep: async () => ({ success: false }), replan: async () => { throw new Error('replanner down'); } },
    { executeStep: async () => ({ success: false }), replan: async () => ({ steps: [] }) },
  ]) assert.equal((await orchestrator({}, overrides)).result.phase, 'error');
});
test('string false verifier output is never success', async () => {
  assert.equal((await orchestrator({}, { verifyOutcome: async () => ({ success: 'false' }) })).result.success, false);
});
test('structured observations reject malformed success and mismatched identities', () => {
  for (const raw of [null, undefined, {}, { success: 'false' }, { success: true, toolCallId: 'other' }]) {
    assert.equal(normaliseObservation(raw, 0, 'exact').success, false);
  }
});
test('chat mode preserves multiple exact calls, raw arguments, results and underscores', async () => {
  const c = createChatExecution('task', { save: () => {}, maxSteps: 2 });
  const tool = { function: { name: 'hardware_action_with_underscore' } };
  const received = [];
  for (const id of ['model-id-1', 'model-id-2']) {
    const raw = { id, function: { name: tool.function.name, arguments: '{"x":1}' } };
    const obs = await executeChatCall(c, raw, [tool], async (...args) => { received.push(args); return { success: true }; });
    assert.equal(obs.toolCallId, id);
    assert.deepEqual(c.state.attempts.at(-1).request.rawToolCall, raw);
  }
  finishChat(c); assert.equal(c.state.phase, 'done');
  assert.equal(received[0][1], 'action_with_underscore');
  assert.equal(received[0][3], 'model-id-1');
});
test('chat unknown calls and invalid args never reach transport; retry loop is bounded', async () => {
  const c = createChatExecution('task', { save: () => {}, maxRetries: 1 });
  let executed = 0;
  for (let n = 0; n < 3 && !c.stopped; n++) await executeChatCall(c, { id: `bad-${n}`, function: { name: 'unknown_action' } }, [], () => { executed++; });
  assert.equal(executed, 0); assert.equal(c.state.phase, 'error'); assert.equal(c.state.retryCount, 1);
  const valid = createChatExecution('task', { save: () => {} });
  await executeChatCall(valid, { id: 'bad-args', function: { name: 'hardware_test', arguments: 'bad-json' } }, [{ function: { name: 'hardware_test' } }], () => { executed++; });
  assert.equal(executed, 0); finishChat(valid); assert.equal(valid.state.phase, 'error');
});
test('chat confirmation uses same identity and explicit approval; duplicate calls rejected', async () => {
  const c = createChatExecution('task', { save: () => {} });
  const raw = { id: 'exact', function: { name: 'file_open' } };
  await executeChatCall(c, raw, [{ function: { name: 'file_open' } }], () => ({ needsConfirmation: true, confirmationId: 'approval' }));
  assert.equal(c.state.phase, 'waiting_confirmation');
  await assert.rejects(c.execute(() => ({ success: true })), /pending/);
  await c.execute(() => ({ success: true }), { confirmationId: 'approval' });
  assert.equal(c.state.observations.at(-1).toolCallId, 'exact');
  await assert.rejects(executeChatCall(c, raw, [], () => ({ success: true })), /identity/);
  finishChat(c); assert.equal(c.state.phase, 'done');
});
test('legacy modes use bounded shared control without changing command or timeout', async () => {
  for (const mode of ['api-agent', 'auto-repair']) {
    let decisions = 0; const commands = [];
    const result = await runLegacyExecution({ goal: 't', mode, maxSteps: 2, dependencies: {
      save: () => {}, decideNextStep: async () => ++decisions === 1 ? { command: 'Get-Service', done: false } : { done: true, answer: 'Complete' },
      classifyCommand: () => ({ level: 'read' }),
      runPowerShell: async (cmd, opts) => { commands.push({ cmd, opts }); return { exitCode: 0, stdout: 'ok' }; },
    } });
    assert.equal(result.success, true); assert.equal(result.steps.length, 1);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].cmd, 'Get-Service');
    assert.equal(commands[0].opts.timeout, 60000);
    assert.equal(commands[0].opts.signal instanceof AbortSignal, true);
  }
});
test('API agent preserves its closing recommendation when max steps is reached', async () => {
  let decisions = 0;
  const result = await runLegacyExecution({ goal: 't', mode: 'api-agent', maxSteps: 1, dependencies: {
    save: () => {}, decideNextStep: async ({ goal }) => {
      decisions++;
      return goal.includes('step limit') ? { done: true, answer: 'Review the diagnostic output.' } : { done: false, command: 'Get-Service' };
    },
    classifyCommand: () => ({ level: 'read' }), runPowerShell: async () => ({ exitCode: 0, stdout: 'ok' }),
  } });
  assert.equal(result.stopped, 'max-steps'); assert.equal(result.success, false);
  assert.equal(result.answer, 'Review the diagnostic output.'); assert.equal(decisions, 2);
});
test('legacy repeated failures, blocked commands and runaway model terminate', async () => {
  for (const blocked of [false, true]) {
    let calls = 0;
    const result = await runLegacyExecution({ goal: 't', maxRetries: 1, dependencies: {
      save: () => {}, decideNextStep: async () => ({ command: 'same', done: false }),
      classifyCommand: () => ({ level: blocked ? 'blocked' : 'read', reason: 'policy' }),
      runPowerShell: async () => { calls++; return { exitCode: 1 }; },
    } });
    assert.equal(result.success, false); assert.equal(result.stopped, 'retry_exhausted');
    assert.equal(result.state.stepCount, 2); assert.equal(calls, blocked ? 0 : 2);
  }
});
test('atomic checkpoint store persists restorable state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-checkpoint-test-'));
  try {
    const c = createChatExecution('task', { save: createCheckpointStore(dir) });
    finishChat(c);
    const file = path.join(dir, `${c.state.sessionId}.json`);
    assert.equal(restoreCheckpoint(fs.readFileSync(file, 'utf8')).phase, 'done');
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
