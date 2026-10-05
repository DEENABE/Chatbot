/**
 * @file DecisionEngine.test.js
 * @description Unit tests for the DecisionEngine pure decision function.
 * Run with: node --test backend/src/orchestrator/DecisionEngine.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decide, shouldAdvance, isTerminal } from './DecisionEngine.js';
import { createAgentState } from './AgentState.js';
// Decision fixtures are snapshots, not commands to bypass the transition validator.
const transition = (state, phase, patch = {}) => ({ ...state, ...patch, phase });

/** Build a minimal plan step */
function makeStep(tool, action, status = 'pending', observation = null) {
  return { index: 0, tool, action, params: {}, description: '', status, observation };
}

/** Build a success observation */
function successObs(stepIndex = 0) {
  return { stepIndex, success: true, data: { result: 'ok' }, error: null, needsConfirmation: false, confirmationId: null, timestamp: new Date().toISOString() };
}

/** Build a failure observation */
function failObs(stepIndex = 0, code = 'INTERNAL_ERROR') {
  return { stepIndex, success: false, data: null, error: { code, message: 'Something failed' }, needsConfirmation: false, confirmationId: null, timestamp: new Date().toISOString() };
}

/** Build a confirmation-required observation */
function confirmObs(stepIndex = 0) {
  return { stepIndex, success: false, data: null, error: null, needsConfirmation: true, confirmationId: 'test-id', confirmationMessage: 'Please confirm.', timestamp: new Date().toISOString() };
}

describe('decide — step budget exhausted', () => {
  it('returns abort when stepCount >= maxSteps', () => {
    const state = transition(createAgentState('task', { maxSteps: 3 }), 'act', { stepCount: 3 });
    const result = decide(state);
    assert.equal(result.decision, 'abort');
    assert.match(result.reason, /budget/i);
  });
});

describe('decide — no current step (plan exhausted)', () => {
  it('returns success when no steps failed', () => {
    const step = makeStep('hardware', 'systemInfo', 'done', successObs());
    const state = transition(
      createAgentState('task'),
      'decide',
      { plan: [step], currentStepIndex: 1 }
    );
    const result = decide(state);
    assert.equal(result.decision, 'success');
  });

  it('returns replan when steps failed and retries available', () => {
    const step = makeStep('hardware', 'systemInfo', 'failed', failObs());
    const state = transition(
      createAgentState('task', { maxRetries: 2 }),
      'decide',
      { plan: [step], currentStepIndex: 1 }
    );
    const result = decide(state);
    assert.equal(result.decision, 'replan');
  });
});

describe('decide — step succeeded', () => {
  it('returns continue when more steps remain', () => {
    const step0 = makeStep('hardware', 'systemInfo', 'done', successObs(0));
    const step1 = makeStep('hardware', 'cpuUsage', 'pending', null);
    step1.index = 1;
    const state = transition(
      createAgentState('task'),
      'observe',
      { plan: [step0, step1], currentStepIndex: 0 }
    );
    const result = decide(state);
    assert.equal(result.decision, 'continue');
  });

  it('returns success when last step succeeded', () => {
    const step = makeStep('hardware', 'systemInfo', 'done', successObs(0));
    const state = transition(
      createAgentState('task'),
      'observe',
      { plan: [step], currentStepIndex: 0 }
    );
    const result = decide(state);
    assert.equal(result.decision, 'success');
  });
});

describe('decide — step failed', () => {
  it('returns replan when failure and retries available', () => {
    const step = makeStep('hardware', 'systemInfo', 'failed', failObs(0, 'INTERNAL_ERROR'));
    const state = transition(
      createAgentState('task', { maxRetries: 2 }),
      'observe',
      { plan: [step], currentStepIndex: 0 }
    );
    const result = decide(state);
    assert.equal(result.decision, 'replan');
  });

  it('returns abort when no retries left', () => {
    const step = makeStep('hardware', 'systemInfo', 'failed', failObs(0, 'INTERNAL_ERROR'));
    const state = transition(
      createAgentState('task', { maxRetries: 0 }),
      'observe',
      { plan: [step], currentStepIndex: 0 }
    );
    const result = decide(state);
    assert.equal(result.decision, 'abort');
  });

  it('returns abort for BRIDGE_UNAVAILABLE regardless of retries', () => {
    const step = makeStep('hardware', 'systemInfo', 'failed', failObs(0, 'BRIDGE_UNAVAILABLE'));
    const state = transition(
      createAgentState('task', { maxRetries: 3 }),
      'observe',
      { plan: [step], currentStepIndex: 0 }
    );
    const result = decide(state);
    assert.equal(result.decision, 'abort');
    assert.match(result.reason, /bridge/i);
  });

  it('returns abort for TOOL_NOT_ALLOWED regardless of retries', () => {
    const step = makeStep('powershell', 'run', 'failed', failObs(0, 'TOOL_NOT_ALLOWED'));
    const state = transition(
      createAgentState('task', { maxRetries: 3 }),
      'observe',
      { plan: [step], currentStepIndex: 0 }
    );
    const result = decide(state);
    assert.equal(result.decision, 'abort');
    assert.match(result.reason, /security/i);
  });
});

describe('decide — confirmation required', () => {
  it('returns confirm when step needs confirmation', () => {
    const step = makeStep('process', 'startProcess', 'confirmation_required', confirmObs(0));
    const state = transition(
      createAgentState('task'),
      'observe',
      { plan: [step], currentStepIndex: 0 }
    );
    const result = decide(state);
    assert.equal(result.decision, 'confirm');
  });
});

describe('shouldAdvance / isTerminal helpers', () => {
  it('shouldAdvance is true only for continue', () => {
    assert.equal(shouldAdvance({ decision: 'continue', reason: '' }), true);
    assert.equal(shouldAdvance({ decision: 'success', reason: '' }), false);
    assert.equal(shouldAdvance({ decision: 'abort', reason: '' }), false);
  });

  it('isTerminal is true for success and abort', () => {
    assert.equal(isTerminal({ decision: 'success', reason: '' }), true);
    assert.equal(isTerminal({ decision: 'abort', reason: '' }), true);
    assert.equal(isTerminal({ decision: 'continue', reason: '' }), false);
    assert.equal(isTerminal({ decision: 'replan', reason: '' }), false);
  });
});
