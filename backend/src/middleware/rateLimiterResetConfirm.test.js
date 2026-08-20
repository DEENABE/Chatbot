import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Isolated: see rateLimiter.test.js for why reset-password (confirm step)
// gets its own file.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-ratelimit-resetconfirm-test-'));
process.env.APP_DATA_PATH = tmpDir;
process.env.AUTH_IP_MAX_ATTEMPTS = '100000';
process.env.AUTH_LOGIN_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_REQUEST_MAX_ATTEMPTS = '100000';
process.env.AUTH_REGISTER_MAX_ATTEMPTS = '100000';
process.env.AUTH_RESET_CONFIRM_WINDOW_MS = '6000';
process.env.AUTH_RESET_CONFIRM_MAX_ATTEMPTS = '3';

const { app } = await import('../app.js');

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;

test.after(() => new Promise((resolve) => server.close(resolve)));

async function resetConfirm(token) {
  return fetch(`${base}/auth/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, newPassword: 'brandnewpassword1' })
  });
}

test('reset-password: repeated invalid-token attempts are throttled', async () => {
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await resetConfirm('not-a-real-token-' + i)).status);
  }
  assert.ok(statuses.slice(0, 3).every((s) => s === 400), 'ordinary invalid-token rejections, not yet limited');
  assert.equal(statuses[3], 429);
});
