import test from 'node:test';
import assert from 'node:assert/strict';
import { localServiceUrl } from './localServiceUrl.js';
import { isAllowedLocalOrigin, isLoopbackHost } from '../middleware/localOrigin.js';
import { isRemoteModel } from '../services/localModelPolicy.js';
import { config } from '../config.js';

test('default streaming deadlines are finite and allow model loading and reasoning', () => {
  assert.ok(config.modelFirstOutputTimeoutMs >= 1000);
  assert.ok(Number.isFinite(config.modelFirstOutputTimeoutMs));
  assert.ok(config.modelIdleTimeoutMs >= 1000);
});
test('service endpoints reject remote destinations, credentials and ambiguous URL components', () => {
  for (const url of [
    'https://example.com',
    'file:///tmp/model',
    'http://localhost@evil.com',
    'http://user:secret@localhost',
    'http://127.0.0.1/api',
    'http://localhost?next=remote',
    'http://localhost#remote',
  ])
    assert.throws(() => localServiceUrl(url), /localhost origin/);
  for (const url of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://[::1]:11434'])
    assert.equal(localServiceUrl(url), url);
});
test('API origins match the selected UI and backend, opaque origins require desktop mode', () => {
  const options = { frontendOrigin: 'http://localhost:5173', localPort: 41235 };
  for (const origin of [undefined, 'http://localhost:5173', 'http://127.0.0.1:41235'])
    assert.equal(isAllowedLocalOrigin(origin, options), true);
  for (const origin of ['https://evil.com', 'http://localhost:9999', 'null', 'file:///evil.html'])
    assert.equal(isAllowedLocalOrigin(origin, options), false);
  assert.equal(isAllowedLocalOrigin('null', { ...options, desktop: true }), true);
  for (const host of [
    'evil.com:3001',
    'localhost.evil.com',
    'localhost@evil.com',
    'localhost/path',
  ])
    assert.equal(isLoopbackHost(host), false);
  assert.equal(isLoopbackHost('127.0.0.1:41235'), true);
});
test('cloud inference through a local Ollama proxy is classified as remote', () => {
  for (const model of [
    { id: 'model:cloud' },
    { remote_host: 'https://remote.example' },
    { details: { remote_model: 'hosted' } },
    { capabilities: ['completion', 'cloud'] },
  ])
    assert.equal(isRemoteModel(model), true);
  assert.equal(isRemoteModel({ id: 'local:4b', capabilities: ['completion', 'thinking'] }), false);
});
