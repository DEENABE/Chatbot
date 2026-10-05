/**
 * @file ObservationHandler.test.js
 * @description Unit tests for the ObservationHandler normalisation functions.
 * Run with: node --test backend/src/orchestrator/ObservationHandler.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseObservation, summariseObservation, buildTranscript } from './ObservationHandler.js';

const STEP = { index: 0, tool: 'hardware', action: 'systemInfo', params: {}, description: 'Get system info', status: 'done', observation: null };

describe('normaliseObservation — success', () => {
  it('produces a success observation', () => {
    const raw = { success: true, data: { cpu: 'Intel i7' } };
    const obs = normaliseObservation(raw, 0);
    assert.equal(obs.success, true);
    assert.deepEqual(obs.data, { cpu: 'Intel i7' });
    assert.equal(obs.error, null);
    assert.equal(obs.needsConfirmation, false);
    assert.equal(obs.stepIndex, 0);
    assert.ok(obs.timestamp);
  });
});

describe('normaliseObservation — failure', () => {
  it('produces a failure observation with error details', () => {
    const raw = { success: false, error: { code: 'BRIDGE_UNAVAILABLE', message: 'No bridge.' } };
    const obs = normaliseObservation(raw, 2);
    assert.equal(obs.success, false);
    assert.equal(obs.data, null);
    assert.equal(obs.error.code, 'BRIDGE_UNAVAILABLE');
    assert.equal(obs.error.message, 'No bridge.');
    assert.equal(obs.stepIndex, 2);
  });

  it('provides fallback error when error object is missing', () => {
    const raw = { success: false };
    const obs = normaliseObservation(raw, 0);
    assert.equal(obs.success, false);
    assert.equal(obs.error.code, 'UNKNOWN_ERROR');
  });
});

describe('normaliseObservation — confirmation required', () => {
  it('produces a confirmation observation', () => {
    const raw = {
      success: true,
      needsConfirmation: true,
      confirmationId: 'test-uuid',
      message: 'This will start notepad. Allow?',
    };
    const obs = normaliseObservation(raw, 1);
    assert.equal(obs.needsConfirmation, true);
    assert.equal(obs.confirmationId, 'test-uuid');
    assert.equal(obs.success, false); // treated as not-yet-done
    assert.equal(obs.error, null);
  });
});

describe('summariseObservation', () => {
  it('formats a success observation', () => {
    const obs = { stepIndex: 0, success: true, data: { os: 'Windows 11' }, error: null, needsConfirmation: false };
    const summary = summariseObservation(obs, STEP);
    assert.match(summary, /SUCCESS/);
    assert.match(summary, /hardware\.systemInfo/);
  });

  it('formats a failure observation', () => {
    const obs = { stepIndex: 0, success: false, data: null, error: { code: 'TIMEOUT', message: 'timed out' }, needsConfirmation: false };
    const summary = summariseObservation(obs, STEP);
    assert.match(summary, /FAILED/);
    assert.match(summary, /TIMEOUT/);
  });

  it('formats a confirmation observation', () => {
    const obs = { stepIndex: 0, success: false, data: null, error: null, needsConfirmation: true, confirmationId: 'abc' };
    const summary = summariseObservation(obs, STEP);
    assert.match(summary, /CONFIRMATION/i);
  });

  it('truncates large data payloads', () => {
    const bigData = { value: 'x'.repeat(1000) };
    const obs = { stepIndex: 0, success: true, data: bigData, error: null, needsConfirmation: false };
    const summary = summariseObservation(obs, STEP);
    assert.match(summary, /truncated/);
  });
});

describe('buildTranscript', () => {
  it('returns empty message for no steps', () => {
    const t = buildTranscript([]);
    assert.match(t, /no steps/i);
  });

  it('builds a multi-step transcript', () => {
    const step0 = { ...STEP, index: 0, status: 'done', observation: { stepIndex: 0, success: true, data: 'a', error: null, needsConfirmation: false } };
    const step1 = { ...STEP, index: 1, action: 'cpuUsage', status: 'failed', observation: { stepIndex: 1, success: false, data: null, error: { code: 'ERR', message: 'fail' }, needsConfirmation: false } };
    const t = buildTranscript([step0, step1]);
    assert.match(t, /Step 1/);
    assert.match(t, /Step 2/);
    assert.match(t, /SUCCESS/);
    assert.match(t, /FAILED/);
  });

  it('handles a step with no observation', () => {
    const step = { ...STEP, status: 'running', observation: null };
    const t = buildTranscript([step]);
    assert.match(t, /no observation/i);
  });
});
