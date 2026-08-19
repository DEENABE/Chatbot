import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

// Real HTTP-level tests against the actual Express app and its real
// middleware chain (CORS, express.json, requireAuth, route wiring) — not
// just the service layer. Isolated per-run SQLite file, exactly as
// authService.test.js does, so this never touches real dev/production data.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-auth-http-test-'));
process.env.APP_DATA_PATH = tmpDir;

const { app } = await import('../app.js');
const { db } = await import('../services/db.js');
const { config } = await import('../config.js');

function readResetToken() {
  const filePath = path.join(path.dirname(config.dbFile), 'password-reset-token.txt');
  const content = fs.readFileSync(filePath, 'utf8');
  return content.match(/Reset code: (\S+)/)?.[1] ?? null;
}

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;

test.after(() => new Promise((resolve) => server.close(resolve)));

function freshUsername(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function registerAndGetToken(label) {
  const username = freshUsername(label);
  const password = 'correcthorsebatterystaple';
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName: label, password })
  });
  const body = await res.json();
  assert.equal(res.status, 201, `register should succeed for ${username}`);
  return { username, password, token: body.token, userId: body.user.id };
}

// A protected route with no side effects, used purely as the "does this
// token authenticate" probe throughout this file.
const PROTECTED_PATH = '/history';

// ── VALID / MISSING / MALFORMED CREDENTIALS ────────────────────────────

test('protected API: valid token succeeds', async () => {
  const { token } = await registerAndGetToken('valid');
  const res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
});

test('protected API: missing token -> 401', async () => {
  const res = await fetch(`${base}${PROTECTED_PATH}`);
  assert.equal(res.status, 401);
});

test('protected API: empty bearer token -> 401', async () => {
  const res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: 'Bearer ' } });
  assert.equal(res.status, 401);
});

test('protected API: wrong scheme (not "Bearer") -> 401', async () => {
  const { token } = await registerAndGetToken('scheme');
  const res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: `Token ${token}` } });
  assert.equal(res.status, 401);
});

test('protected API: malformed header (no scheme at all) -> 401', async () => {
  const { token } = await registerAndGetToken('malformed');
  const res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: token } });
  assert.equal(res.status, 401);
});

test('protected API: garbage/non-token string -> 401', async () => {
  const res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: 'Bearer not-a-real-token' } });
  assert.equal(res.status, 401);
});

// ── TAMPERING ────────────────────────────────────────────────────────────

test('protected API: single-character-modified token -> 401', async () => {
  const { token } = await registerAndGetToken('tamper');
  const tampered = token.slice(0, -1) + (token.at(-1) === '0' ? '1' : '0');
  const res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: `Bearer ${tampered}` } });
  assert.equal(res.status, 401);
});

// ── "ALGORITHM CONFUSION" / DECODE-ONLY-TRUST, TRANSLATED TO THIS ARCHITECTURE ──
// There's no algorithm to confuse and no signature to forge here — the
// token is 256 bits of randomness, verified by a server-side hash lookup,
// not decoded or trusted based on its own shape. This test proves that
// directly: a syntactically valid, well-formed JWT (including the classic
// {"alg":"none"} attack shape) is just an opaque string to this middleware
// and is rejected exactly like any other wrong guess — confirming
// middleware/auth.js does no JWT-like decode-and-trust of its input.

test('protected API: a well-formed {"alg":"none"} JWT is rejected, not decoded/trusted', async () => {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const forged = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: 'admin', role: 'Employee' })}.`;
  const res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: `Bearer ${forged}` } });
  assert.equal(res.status, 401);
});

test('protected API: a well-formed JWT with a fabricated HS256 signature is rejected', async () => {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const forged = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'admin' })}.${crypto.randomBytes(32).toString('base64url')}`;
  const res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: `Bearer ${forged}` } });
  assert.equal(res.status, 401);
});

// ── EXPIRY ──────────────────────────────────────────────────────────────

test('protected API: expired token -> 401', async () => {
  const { token } = await registerAndGetToken('expired');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('UPDATE sessions SET expiresAt = ? WHERE tokenHash = ?').run(Date.now() - 1000, tokenHash);
  const res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});

// ── USER STATE ──────────────────────────────────────────────────────────
// This app has no separate "is the user still active" check per request —
// deliberately: sessions.userId has ON DELETE CASCADE against users(id)
// (schema.sql), so a session for a deleted user cannot exist in the table
// at all, rather than being checked-and-caught on every single request.
// That's a stronger guarantee than a per-request join (no staleness
// window) and satisfies "don't add an unnecessary DB lookup" — proven
// here, not assumed.

test('protected API: token for a deleted user is rejected (FK cascade removes the session)', async () => {
  const { token, userId } = await registerAndGetToken('deleteduser');
  let res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200, 'sanity: token works before the user is deleted');

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const orphaned = db.prepare('SELECT * FROM sessions WHERE tokenHash = ?').get(tokenHash);
  assert.equal(orphaned, undefined, 'ON DELETE CASCADE should have removed the session row automatically');

  res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});

// ── LOGOUT / REVOCATION ─────────────────────────────────────────────────

test('logout: protected API works, then logout, then the same token is rejected', async () => {
  const { token } = await registerAndGetToken('logoutflow');
  let res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);

  res = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);

  res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});

// ── PASSWORD RESET INVALIDATION ─────────────────────────────────────────

test('password reset: an existing token stops authenticating after reset', async () => {
  const { username, token } = await registerAndGetToken('resetflow');
  let res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);

  res = await fetch(`${base}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  });
  assert.equal(res.status, 200);
  const resetToken = readResetToken();

  res = await fetch(`${base}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: resetToken, newPassword: 'brandnewpassword1' })
  });
  assert.equal(res.status, 200);

  res = await fetch(`${base}${PROTECTED_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});

// ── INFORMATION LEAKAGE ─────────────────────────────────────────────────

test('error responses never leak the token, a stack trace, or internal details', async () => {
  const { token } = await registerAndGetToken('leaktest');
  const captured = [];
  const originalLog = console.log, originalError = console.error, originalWarn = console.warn;
  const spy = (...args) => captured.push(args.map(String).join(' '));
  console.log = spy; console.error = spy; console.warn = spy;
  let bodies = [];
  try {
    const paths = [
      { url: `${base}${PROTECTED_PATH}`, headers: {} },
      { url: `${base}${PROTECTED_PATH}`, headers: { Authorization: 'Bearer garbage' } },
      { url: `${base}${PROTECTED_PATH}`, headers: { Authorization: `Bearer ${token.slice(0, -1)}x` } }
    ];
    for (const { url, headers } of paths) {
      const res = await fetch(url, { headers });
      bodies.push(await res.text());
    }
  } finally {
    console.log = originalLog; console.error = originalError; console.warn = originalWarn;
  }
  for (const b of bodies) {
    assert.ok(!b.includes(token), 'response body must never contain the real token');
    assert.ok(!/at [\w.]+ \(.*:\d+:\d+\)/.test(b), 'response body must never contain a stack trace');
  }
  const everLoggedToken = captured.some((line) => line.includes(token));
  assert.equal(everLoggedToken, false, 'the real token must never be logged, including on a failed auth attempt');
});

// ── FORGOT-PASSWORD ENUMERATION (HTTP contract) ─────────────────────────

test('forgot-password: identical response for a registered vs. an unknown username', async () => {
  const { username } = await registerAndGetToken('enumreal');
  const unknown = 'nobody_' + Date.now();

  const resReal = await fetch(`${base}/auth/forgot-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username })
  });
  const resUnknown = await fetch(`${base}/auth/forgot-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: unknown })
  });

  assert.equal(resReal.status, resUnknown.status);
  assert.deepEqual(await resReal.json(), await resUnknown.json());
});

test('forgot-password: malformed/empty/oversized username never crashes, always the same generic response', async () => {
  const payloads = [{ username: '' }, {}, { username: 12345 }, { username: 'x'.repeat(5000) }];
  const responses = [];
  for (const body of payloads) {
    const res = await fetch(`${base}/auth/forgot-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(res.status, 200);
    responses.push(await res.json());
  }
  for (const r of responses) assert.deepEqual(r, responses[0]);
});

test('reset-password: malformed JSON body is rejected cleanly, not a crash', async () => {
  const res = await fetch(`${base}/auth/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not valid json'
  });
  // Falls through to app.js's app-wide JSON body-parser error handler
  // (a generic 500, not a route-specific 400) — unrelated to this phase to
  // change. What matters here: no crash, and no stack trace/internal detail
  // leaked into the response.
  assert.ok(res.status >= 400);
  const text = await res.text();
  assert.ok(!/at [\w.]+ \(.*:\d+:\d+\)/.test(text), 'must not leak a stack trace');
  assert.ok(!text.toLowerCase().includes('syntaxerror'), 'must not leak the parser exception type');
});
