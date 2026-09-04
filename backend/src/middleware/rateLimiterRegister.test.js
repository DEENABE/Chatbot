import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Isolated: see rateLimiter.test.js for why registration gets its own file.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-ratelimit-register-test-'));
process.env.APP_DATA_PATH = tmpDir;
process.env.AUTH_IP_MAX_ATTEMPTS = '100000';
process.env.AUTH_LOGIN_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_REQUEST_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_CONFIRM_MAX_ATTEMPTS = '100000';
process.env.AUTH_REGISTER_WINDOW_MS = '6000';
process.env.AUTH_REGISTER_MAX_ATTEMPTS = '3';

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
async function register(username) {
  return fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName: 'x', password: 'correcthorsebatterystaple' })
  });
}

test('register: normal registration works, excessive attempts throttled, works again after cooldown', async () => {
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await register(freshUsername('rl-register-' + i))).status);
  }
  assert.ok(statuses.slice(0, 3).every((s) => s === 201));
  assert.equal(statuses[3], 429, 'the 4th registration from this IP within the window must be throttled');

  await wait(6200);
  const res = await register(freshUsername('rl-register-after'));
  assert.equal(res.status, 201, 'legitimate registration must work again after the cooldown');
});

test('register: failed (validation-error) attempts do not consume the same-account-creation budget', async () => {
  // Start from a clean window — the previous test's final call lands inside
  // whatever window is active when this one starts, and would otherwise
  // eat into the budget this test is trying to measure.
  await wait(6200);

  // AUTH_REGISTER_MAX_ATTEMPTS is 3 for this whole file. Real-world trigger:
  // a user retries after a typo (weak password, a name already taken) —
  // ordinary mistakes, not abuse — and those must not eat into the budget
  // that bounds actual new-account volume.
  const name = freshUsername('rl-register-failed');
  const failStatuses = [];
  for (let i = 0; i < 5; i++) {
    // No password at all -> guaranteed validation failure (400), never a
    // real account. Same username each time so this also isn't silently
    // creating 5 accounts under different names.
    const res = await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, displayName: 'x' })
    });
    failStatuses.push(res.status);
  }
  assert.ok(failStatuses.every((s) => s === 400), `all 5 must fail validation (400), got ${failStatuses}`);

  // The budget (3 successes per window) must still be fully available —
  // none of the 5 failures above should have consumed a slot.
  const successStatuses = [];
  for (let i = 0; i < 3; i++) {
    successStatuses.push((await register(freshUsername('rl-register-failed-ok-' + i))).status);
  }
  assert.ok(successStatuses.every((s) => s === 201), `budget must be untouched by prior failures, got ${successStatuses}`);

  // Genuine excessive successful volume must still be throttled — this
  // test must not have accidentally weakened the real limit.
  const overLimit = await register(freshUsername('rl-register-failed-over'));
  assert.equal(overLimit.status, 429, 'actual excessive account-creation volume must still be throttled');

  await wait(6200);
});
