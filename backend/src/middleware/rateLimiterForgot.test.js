import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Isolated: see rateLimiter.test.js for why forgot-password gets its own
// file rather than sharing one with login/register/reset-confirm tests.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-ratelimit-forgot-test-'));
process.env.APP_DATA_PATH = tmpDir;
process.env.AUTH_IP_MAX_ATTEMPTS = '100000';
process.env.AUTH_LOGIN_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_CONFIRM_MAX_ATTEMPTS = '100000';
process.env.AUTH_REGISTER_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_REQUEST_WINDOW_MS = '6000';
process.env.AUTH_RESET_REQUEST_MAX_ATTEMPTS = '3';

const { app } = await import('../app.js');

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;

test.after(() => new Promise((resolve) => server.close(resolve)));

function freshUsername(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function register(username, password = 'correcthorsebatterystaple') {
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName: 'x', password })
  });
  assert.equal(res.status, 201, `test setup: register(${username}) must succeed`);
  return res;
}
async function forgotPassword(username) {
  return fetch(`${base}/auth/forgot-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username })
  });
}

test('forgot-password: normal request works, repeated requests are throttled, then expire', async () => {
  const username = freshUsername('rl-forgot');
  await register(username);
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await forgotPassword(username)).status);
  assert.ok(statuses.slice(0, 3).every((s) => s === 200));
  assert.equal(statuses[3], 429);

  await wait(6200);
  const res = await forgotPassword(username);
  assert.equal(res.status, 200, 'valid recovery must still work once the window rolls over');
});

test('forgot-password: unknown username throttles identically to a known one (no enumeration signal)', async () => {
  const unknown = freshUsername('rl-forgot-unknown');
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await forgotPassword(unknown)).status);
  assert.ok(statuses.slice(0, 3).every((s) => s === 200));
  assert.equal(statuses[3], 429);
});
