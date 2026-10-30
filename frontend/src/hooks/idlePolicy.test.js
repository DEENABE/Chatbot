import test from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_COLLAPSE_MS, shouldCollapse } from './idlePolicy.js';

test('the idle limit is three minutes', () => {
  assert.equal(IDLE_COLLAPSE_MS, 180000);
});

test('collapses once the window has been idle for the full limit', () => {
  assert.equal(shouldCollapse({ idleMs: IDLE_COLLAPSE_MS }), true);
  assert.equal(shouldCollapse({ idleMs: IDLE_COLLAPSE_MS + 1 }), true);
});

test('does not collapse before the limit', () => {
  assert.equal(shouldCollapse({ idleMs: IDLE_COLLAPSE_MS - 1 }), false);
  assert.equal(shouldCollapse({ idleMs: 0 }), false);
});

test('never collapses while the app is busy, however long it has been idle', () => {
  assert.equal(shouldCollapse({ idleMs: IDLE_COLLAPSE_MS * 10, busy: true }), false);
});
