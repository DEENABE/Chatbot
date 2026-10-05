import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentState, transition, updateCurrentStep, advanceStep, TRANSITIONS, serializeState, checkpoint, restoreCheckpoint } from './AgentState.js';
import { ExecutionController } from './ExecutionController.js';

const step = { tool: 'hardware', action: 'systemInfo', params: {}, toolCallId: 'model-exact-id' };
async function states() {
  const c = new ExecutionController('test', { sessionId: 'test-session' });
  const fixtures = { idle: c.state };
  c.plan([step]); fixtures.plan = c.state;
  c.move('act'); fixtures.act = c.state;
  c.move('observe'); fixtures.observe = c.state;
  c.commit(updateCurrentStep(c.state, 'done', { success: true, toolCallId: step.toolCallId, needsConfirmation: false }));
  c.move('decide'); fixtures.decide = c.state;
  c.move('verify'); fixtures.verify = c.state;
  c.move('done', { verdict: { success: true } }); fixtures.done = c.state;
  fixtures.error = transition(fixtures.idle, 'error');
  fixtures.cancelled = transition(fixtures.idle, 'cancelled');
  const confirmation = updateCurrentStep(fixtures.observe, 'confirmation_required', { success: false, toolCallId: step.toolCallId, needsConfirmation: true, confirmationId: 'approval' });
  fixtures.confirmDecide = transition(confirmation, 'decide');
  fixtures.waiting_confirmation = transition(fixtures.confirmDecide, 'waiting_confirmation');
  fixtures.replan = transition(fixtures.decide, 'replan');
  return fixtures;
}
const fixtures = await states();
for (const from of Object.keys(TRANSITIONS)) {
  for (const to of Object.keys(TRANSITIONS)) {
    test(`${from} -> ${to}: ${TRANSITIONS[from].includes(to) ? 'legal' : 'rejected'}`, () => {
      let source = fixtures[from];
      let patch = {};
      if (from === 'decide' && to === 'act') {
        source = { ...source, plan: [...source.plan, { ...step, toolCallId: 'second', status: 'pending' }], currentStepIndex: 1 };
      }
      if (to === 'decide' && from === 'observe') source = updateCurrentStep(source, 'done', { success: true, toolCallId: step.toolCallId });
      if (to === 'verify' && from === 'plan') source = { ...source, plan: [] };
      if (to === 'waiting_confirmation') source = from === 'decide' ? fixtures.confirmDecide : source;
      if (from === 'waiting_confirmation' && to === 'act') patch = { confirmationId: 'approval' };
      if (to === 'done') patch = { verdict: { success: true } };
      const before = serializeState(source);
      if (TRANSITIONS[from].includes(to)) {
        const result = transition(source, to, patch);
        assert.equal(result.phase, to);
        assert.equal(result.revision, source.revision + 1);
        assert.equal(result.events.at(-1).from, from);
        assert.equal(serializeState(source), before);
      } else assert.throws(() => transition(source, to, patch), /Illegal transition/);
    });
  }
}
test('budgets reject invalid direct inputs', () => {
  for (const maxSteps of [0, -1, NaN, Infinity, 51, 1.2, '3']) assert.throws(() => createAgentState('t', { maxSteps }));
  for (const maxRetries of [-1, NaN, Infinity, 11, '2']) assert.throws(() => createAgentState('t', { maxRetries }));
});
test('protected counters, false verdicts and forged completed work are rejected', () => {
  assert.throws(() => transition(fixtures.idle, 'plan', { stepCount: 99 }));
  assert.throws(() => transition(fixtures.verify, 'done', { verdict: { success: 'false' } }));
  assert.throws(() => transition(fixtures.idle, 'plan', { plan: [{ ...step, status: 'done' }] }));
  assert.throws(() => advanceStep(fixtures.plan));
  assert.throws(() => updateCurrentStep(fixtures.plan, 'done', { success: true }));
  assert.throws(() => updateCurrentStep(fixtures.observe, 'done', { success: true, toolCallId: 'wrong' }));
  assert.throws(() => transition(fixtures.waiting_confirmation, 'act', { confirmationId: 'wrong' }));
});
test('canonical checkpoints round-trip and mark in-flight effects for reconciliation', () => {
  for (const state of Object.values(fixtures)) {
    const c = checkpoint(state);
    assert.equal(serializeState(restoreCheckpoint(serializeState(c))), serializeState(state));
  }
  assert.equal(checkpoint(fixtures.act).recovery, 'reconcile-before-resume');
  assert.equal(serializeState({ b: 2, a: 1 }), serializeState({ a: 1, b: 2 }));
  assert.throws(() => restoreCheckpoint({ ...checkpoint(fixtures.done), schemaVersion: 99 }));
});
test('step budget charged before dispatch and never exceeded', async () => {
  const c = new ExecutionController('t', { maxSteps: 1 });
  c.plan([step]);
  await c.execute(() => { assert.equal(c.state.stepCount, 1); return { success: true }; });
  c.plan([{ ...step, toolCallId: 'next' }]);
  let calls = 0;
  await assert.rejects(c.execute(() => { calls++; }), /budget/);
  assert.equal(calls, 0);
});
test('retry exhausted and failed observations preserved after replan', async () => {
  const c = new ExecutionController('t', { maxRetries: 1 });
  c.plan([step]); await c.execute(() => ({ success: false }));
  assert.throws(() => c.plan([{ ...step, toolCallId: 'bypass' }]), /requires replan/);
  c.recover(); c.plan([{ ...step, toolCallId: 'retry' }]);
  await c.execute(() => ({ success: false }));
  assert.throws(() => c.recover(), /budget/);
  assert.equal(c.state.attempts.length, 2);
  assert.equal(c.state.observations.length, 2);
});
test('persistence failure prevents dispatch', async () => {
  const c = new ExecutionController('t'); c.plan([step]);
  c.save = () => { throw new Error('disk full'); };
  let calls = 0;
  await assert.rejects(c.execute(() => { calls++; }), /disk full/);
  assert.equal(calls, 0);
  assert.equal(c.state.phase, 'plan');
});
