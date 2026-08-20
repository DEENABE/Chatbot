import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Isolated in its own file/process so the tight AUTH_IP_MAX_ATTEMPTS here
// doesn't interact with rateLimiter.test.js's tight per-account limits —
// each file gets its own fresh module registry under `node --test`.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-ratelimit-ip-test-'));
process.env.APP_DATA_PATH = tmpDir;
process.env.AUTH_IP_WINDOW_MS = '6000';
process.env.AUTH_IP_MAX_ATTEMPTS = '5';
// Generous — this file is specifically isolating the IP layer, not the
// per-account ones, which already have their own dedicated test file.
process.env.AUTH_LOGIN_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_REQUEST_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_CONFIRM_MAX_ATTEMPTS = '100000';
process.env.AUTH_REGISTER_MAX_ATTEMPTS = '100000';

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
async function login(username) {
  return fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'wrongpassword' })
  });
}

test('IP layer: cycling through many different usernames from one IP is still throttled overall', async () => {
  // Each request below targets a DIFFERENT account, so the per-account
  // (ip+username) limiter never fires for any single one of them — this
  // proves the credential-stuffing gap (rotate the username, not the IP)
  // is closed by the separate, broader per-IP ceiling, not by coincidence.
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    statuses.push((await login(freshUsername('ip-rotate-' + i))).status);
  }
  assert.ok(statuses.slice(0, 5).every((s) => s === 401), 'first 5 (the configured IP max) are normal failed logins');
  assert.ok(statuses.slice(5).every((s) => s === 429), 'the 6th+ distinct-account attempt from this IP is still blocked');
});

test('IP layer: the ceiling is shared across different auth endpoints, not per-route', async () => {
  // The previous test exhausted this IP's budget for the window — start
  // this one with a clean window rather than inheriting its tail end.
  await wait(6200);
  // register + forgot-password + login all count against the same
  // ipAuthLimiter instance — confirm hitting a mix still adds up.
  const u1 = freshUsername('ip-mixed-1');
  const statuses = [];
  statuses.push((await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u1, displayName: 'x', password: 'correcthorsebatterystaple' })
  })).status);
  statuses.push((await fetch(`${base}/auth/forgot-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u1 })
  })).status);
  for (let i = 0; i < 5; i++) {
    statuses.push((await login(freshUsername('ip-mixed-extra-' + i))).status);
  }
  // 7 total requests against a shared budget of 5 — the tail must be blocked
  // regardless of which endpoint each individual request hit.
  assert.ok(statuses.slice(0, 5).every((s) => s !== 429));
  assert.ok(statuses.slice(5).every((s) => s === 429));
});

test('IP layer: expires after the window like the other limiters', async () => {
  await wait(6200); // start this test with a clean window too
  for (let i = 0; i < 6; i++) await login(freshUsername('ip-expire-' + i));
  let res = await login(freshUsername('ip-expire-check'));
  assert.equal(res.status, 429);

  await wait(6200);

  res = await login(freshUsername('ip-expire-after'));
  assert.equal(res.status, 401, 'a normal (non-rate-limited) failed login must be possible again after the window');
});
