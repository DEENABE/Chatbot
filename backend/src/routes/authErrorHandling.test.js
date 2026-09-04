import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Isolated: this test deliberately breaks the shared `db` singleton (closes
// the connection) to force a genuine, unexpected failure — it must never
// share a process/db with any other test file.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-auth-error-test-'));
process.env.APP_DATA_PATH = tmpDir;
process.env.AUTH_IP_MAX_ATTEMPTS = '100000';
process.env.AUTH_REGISTER_MAX_ATTEMPTS = '100000';
process.env.AUTH_LOGIN_MAX_ATTEMPTS = '100000';

const { app } = await import('../app.js');
const { db } = await import('../services/db.js');

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;

test.after(() => new Promise((resolve) => server.close(resolve)));

function freshUsername(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('register: a deliberate validation failure is still echoed verbatim (control case)', async () => {
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: freshUsername('errctl'), password: 'short' })
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, 'Password must be at least 8 characters.');
});

test('register: a genuine unexpected failure (DB unavailable) returns a safe generic 500, never the raw internal error', async () => {
  db.close(); // simulates a real-world failure mode: connection/file becomes unusable

  const res = await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: freshUsername('errfail'), password: 'aValidPassword123' })
  });
  const body = await res.json();

  assert.equal(res.status, 500, 'a server-side failure must be reported as 5xx, not 400');
  assert.equal(body.error, 'Unexpected local server error.', 'must not leak the raw internal error');
  assert.ok(
    !JSON.stringify(body).toLowerCase().includes('database'),
    `response must not mention internal details, got: ${JSON.stringify(body)}`
  );
});

test('login: the same unexpected-failure handling applies (DB still unavailable)', async () => {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'anyone', password: 'anyvalidpassword' })
  });
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.error, 'Unexpected local server error.');
});
