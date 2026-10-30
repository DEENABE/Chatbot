import test from 'node:test';
import assert from 'node:assert/strict';
import { percentValue, meterWidth, executionModeLabel } from './metricsDisplay.js';

test('unavailable sensors stay visibly unavailable while a measured zero stays zero', () => {
  for (const value of [null, undefined, NaN, '0']) assert.equal(percentValue(value), 'N/A');
  assert.equal(percentValue(0), '0%');
  assert.equal(percentValue(70.2), '70%');
  assert.equal(meterWidth(null), '0%');
});
test('an adapter name or memory allocation never claims verified GPU execution', () => {
  assert.equal(
    executionModeLabel({ mode: 'gpu', verified: false }),
    'Automatic · not yet observed',
  );
  assert.equal(executionModeLabel({ mode: 'mixed', verified: true }), 'CPU + GPU · verified');
  assert.equal(executionModeLabel({ mode: 'cpu', verified: true }), 'CPU · verified');
});
