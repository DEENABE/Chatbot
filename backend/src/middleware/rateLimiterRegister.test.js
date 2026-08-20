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
