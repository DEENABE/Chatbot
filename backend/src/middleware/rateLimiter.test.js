import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Deliberately tight LOGIN limits — this file exists specifically to test
// login throttling. forgot-password/reset/register each have their own
// dedicated, similarly-isolated file (rateLimiterForgot.test.js,
// rateLimiterResetConfirm.test.js, rateLimiterRegister.test.js,
// rateLimiterIp.test.js) rather than sharing one file: every test here
// incidentally calls register() to set up an account, and earlier attempts
// at combining multiple tight limiters in one file caused exactly the
// failure this split fixes — an incidental register() call silently 429'd
// from a DIFFERENT limiter's test-only tight threshold, leaving a later
// assertion failing for an unrelated reason. Keeping every limiter but the
// one under test generous in each file removes that cross-contamination.
//
// 6s windows, not under 1s: scrypt is deliberately expensive, and several
// sequential login attempts (each a real scrypt hash) can approach ~1s on
// their own under load — a tighter window made this suite flaky, not just
// slow.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-ratelimit-test-'));
process.env.APP_DATA_PATH = tmpDir;
process.env.AUTH_IP_MAX_ATTEMPTS = '100000';
process.env.AUTH_REGISTER_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_REQUEST_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_CONFIRM_MAX_ATTEMPTS = '100000';
process.env.AUTH_LOGIN_WINDOW_MS = '6000';
process.env.AUTH_LOGIN_MAX_ATTEMPTS = '3';
process.env.AUTH_LOGIN_PROGRESSIVE_DELAY_THRESHOLD = '1';
process.env.AUTH_LOGIN_PROGRESSIVE_DELAY_STEP_MS = '30';
process.env.AUTH_LOGIN_PROGRESSIVE_DELAY_MAX_MS = '100';

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
async function login(username, password) {
  return fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
}

test('login: normal login succeeds, wrong password rejected', async () => {
  const username = freshUsername('rl-basic');
  await register(username);
  let res = await login(username, 'wrongpassword');
  assert.equal(res.status, 401);
  res = await login(username, 'correcthorsebatterystaple');
  assert.equal(res.status, 200);
});

test('login: repeated wrong-password attempts against one account are throttled (429)', async () => {
  const username = freshUsername('rl-throttle');
  await register(username);
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    statuses.push((await login(username, 'wrongpassword')).status);
  }
  assert.ok(statuses.slice(0, 3).every((s) => s === 401), 'first 3 (the configured max) are normal failures');
  assert.ok(statuses.slice(3).every((s) => s === 429), 'anything past the max is rate-limited, not just another 401');
});

test('login: 429 response has no sensitive data and a safe generic message', async () => {
  const username = freshUsername('rl-safe429');
  await register(username);
  for (let i = 0; i < 3; i++) await login(username, 'wrongpassword');
  const res = await login(username, 'wrongpassword');
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.ok(body.error);
  assert.ok(!JSON.stringify(body).match(/stack|internal|sqlite|scrypt/i));
});

test('login: the rate limit eventually expires, and login works again after cooldown', async () => {
  const username = freshUsername('rl-expire');
  await register(username);
  for (let i = 0; i < 3; i++) await login(username, 'wrongpassword');
  let res = await login(username, 'wrongpassword');
  assert.equal(res.status, 429);

  await wait(6200); // window is 6000ms

  res = await login(username, 'correcthorsebatterystaple');
  assert.equal(res.status, 200, 'a correct login must succeed again once the window has rolled over');
});

test('login: a successful login does not itself consume the failure budget', async () => {
  const username = freshUsername('rl-skipsuccess');
  await register(username);
  assert.equal((await login(username, 'wrongpassword')).status, 401); // 1 failure
  assert.equal((await login(username, 'correcthorsebatterystaple')).status, 200); // success — not counted
  assert.equal((await login(username, 'wrongpassword')).status, 401); // 2nd real failure
  // Only 2 real failures so far against a max of 3 — the 3rd must still be
  // treated as a normal failure, not already blocked.
  assert.equal((await login(username, 'wrongpassword')).status, 401);
  // Now the 4th failure should be rate-limited.
  assert.equal((await login(username, 'wrongpassword')).status, 429);
});

test('login: unknown account is throttled the same way as a known one (no enumeration signal)', async () => {
  const unknown = freshUsername('rl-unknown');
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await login(unknown, 'anything')).status);
  assert.ok(statuses.slice(0, 3).every((s) => s === 401));
  assert.ok(statuses.slice(3).every((s) => s === 429));
});

test('login: a spoofed X-Forwarded-For header does not reset or bypass the rate limit', async () => {
  // app.js never sets `trust proxy`, so Express's req.ip is always the real
  // socket address, never an attacker-supplied header — there's no reverse
  // proxy in front of this app for such a header to legitimately carry
  // real client-IP information from, so trusting it would only ever be a
  // spoofing vector, never a real signal.
  const username = freshUsername('rl-spoof');
  await register(username);
  for (let i = 0; i < 3; i++) {
    await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${i}` },
      body: JSON.stringify({ username, password: 'wrongpassword' })
    });
  }
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.99' }, // yet another claimed IP
    body: JSON.stringify({ username, password: 'wrongpassword' })
  });
  assert.equal(res.status, 429, 'a different claimed X-Forwarded-For per request must not grant a fresh budget');
});

test('login: account-based throttling is independent per account (one user\'s lockout doesn\'t affect another)', async () => {
  const userA = freshUsername('rl-indep-a');
  const userB = freshUsername('rl-indep-b');
  await register(userA);
  await register(userB);
  for (let i = 0; i < 4; i++) await login(userA, 'wrongpassword'); // exhausts A's budget
  const res = await login(userB, 'correcthorsebatterystaple');
  assert.equal(res.status, 200, 'user B must be unaffected by user A being throttled');
});
