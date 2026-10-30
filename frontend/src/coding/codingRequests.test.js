import test from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay, isCodingModel } from './codingRequests.js';

test('polling respects Retry-After seconds/date and backs off repeated failures', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  assert.equal(retryDelay({ response: { headers: { 'retry-after': '60' } } }, 1, now), 60000);
  assert.equal(
    retryDelay(
      { response: { headers: new Headers({ 'retry-after': 'Sun, 25 Oct 2026 12:00:15 GMT' }) } },
      1,
      now,
    ),
    15000,
  );
  assert.equal(retryDelay({}, 1), 2000);
  assert.equal(retryDelay({}, 4), 16000);
  assert.equal(retryDelay({}, 20), 30000);
  assert.equal(retryDelay({ response: { headers: { 'retry-after': '99999' } } }), 300000);
});

test('only installed verified local models declaring completion and tools are selectable', () => {
  const model = {
    id: 'local-coder',
    capabilities: ['completion', 'tools'],
    capabilityVerified: true,
    local: true,
  };
  assert.ok(isCodingModel(model));
  for (const override of [
    { local: false },
    { installed: false },
    { capabilityVerified: false },
    { capabilities: ['completion'] },
  ])
    assert.ok(!isCodingModel({ ...model, ...override }));
  assert.ok(!isCodingModel(null));
});
