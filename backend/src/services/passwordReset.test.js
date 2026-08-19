import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Isolated per-run SQLite file, same convention as authService.test.js —
// never touches the real dev/production database.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-reset-test-'));
process.env.APP_DATA_PATH = tmpDir;

const authService = await import('./authService.js');
const sessionService = await import('./sessionService.js');
const { db } = await import('./db.js');
const { config } = await import('../config.js');

const RESET_TOKEN_FILE = path.join(path.dirname(config.dbFile), 'password-reset-token.txt');

function readResetToken() {
  const content = fs.readFileSync(RESET_TOKEN_FILE, 'utf8');
  return content.match(/Reset code: (\S+)/)?.[1] ?? null;
}

function freshUsername(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function registerAndRequestReset(label) {
  const username = freshUsername(label);
  const user = await authService.registerUser(username, label, 'correcthorsebatterystaple');
  await authService.requestPasswordReset(username);
  const token = readResetToken();
  return { username, user, token };
}

// ── FORGOT PASSWORD / ENUMERATION ──────────────────────────────────────

test('forgot-password: registered username generates a usable token', async () => {
  const { token } = await registerAndRequestReset('fp-reg');
  assert.ok(token);
  const row = db.prepare('SELECT * FROM password_resets ORDER BY createdAt DESC LIMIT 1').get();
  assert.equal(row.usedAt, null);
  assert.ok(row.expiresAt > Date.now());
  // The raw token is never itself in the table — only its hash.
  assert.notEqual(row.tokenHash, token);
});

test('forgot-password: unregistered username does not throw and creates no row', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM password_resets').get().c;
  await assert.doesNotReject(() => authService.requestPasswordReset(freshUsername('does-not-exist')));
  const after = db.prepare('SELECT COUNT(*) AS c FROM password_resets').get().c;
  assert.equal(after, before);
});

test('forgot-password: malformed input (empty, non-string, oversized) does not throw', async () => {
  await assert.doesNotReject(() => authService.requestPasswordReset(''));
  await assert.doesNotReject(() => authService.requestPasswordReset(undefined));
  await assert.doesNotReject(() => authService.requestPasswordReset(12345));
  await assert.doesNotReject(() => authService.requestPasswordReset('x'.repeat(10000)));
});

test('forgot-password: repeated requests invalidate the previous token (only one active at a time)', async () => {
  const username = freshUsername('fp-repeat');
  await authService.registerUser(username, 'x', 'correcthorsebatterystaple');

  await authService.requestPasswordReset(username);
  const tokenA = readResetToken();

  await authService.requestPasswordReset(username);
  const tokenB = readResetToken();

  assert.notEqual(tokenA, tokenB);
  // The old token must not still work.
  await assert.rejects(() => authService.resetPasswordWithToken(tokenA, 'brandnewpassword1'));
  // The new one must.
  await authService.resetPasswordWithToken(tokenB, 'brandnewpassword1');
});

// ── TOKEN VALIDATION ────────────────────────────────────────────────────

test('token: valid token is accepted', async () => {
  const { token } = await registerAndRequestReset('tok-valid');
  await assert.doesNotReject(() => authService.resetPasswordWithToken(token, 'brandnewpassword1'));
});

test('token: random/invalid token is rejected', async () => {
  await assert.rejects(
    () => authService.resetPasswordWithToken(crypto.randomBytes(32).toString('hex'), 'brandnewpassword1'),
    /Invalid or expired/
  );
});

test('token: missing/empty token is rejected', async () => {
  await assert.rejects(() => authService.resetPasswordWithToken('', 'brandnewpassword1'), /Invalid or expired/);
  await assert.rejects(() => authService.resetPasswordWithToken(undefined, 'brandnewpassword1'), /Invalid or expired/);
});

test('token: modified/tampered token is rejected', async () => {
  const { token } = await registerAndRequestReset('tok-tamper');
  const tampered = token.slice(0, -1) + (token.at(-1) === '0' ? '1' : '0');
  await assert.rejects(() => authService.resetPasswordWithToken(tampered, 'brandnewpassword1'), /Invalid or expired/);
});

test('token: expired token is rejected', async () => {
  const { token } = await registerAndRequestReset('tok-expired');
  const tokenHash = sessionService.hashToken(token);
  db.prepare('UPDATE password_resets SET expiresAt = ? WHERE tokenHash = ?').run(Date.now() - 1000, tokenHash);
  await assert.rejects(() => authService.resetPasswordWithToken(token, 'brandnewpassword1'), /Invalid or expired/);
});

test('token: user binding — the token alone determines the account, there is no way to target another user', async () => {
  // authService.resetPasswordWithToken(token, newPassword) has no
  // username/userId parameter at all — proven by the function signature
  // itself, not just by a runtime check. A valid token for user A always
  // resets user A, full stop.
  const { username: userA, token } = await registerAndRequestReset('bind-a');
  const { username: userB } = await registerAndRequestReset('bind-b');

  await authService.resetPasswordWithToken(token, 'brandnewpassword1');

  // User A's password changed...
  const a = await authService.loginUser(userA, 'brandnewpassword1');
  assert.equal(a.username, userA);
  // ...user B's did not.
  const b = await authService.loginUser(userB, 'correcthorsebatterystaple');
  assert.equal(b.username, userB);
});

// ── RESET ────────────────────────────────────────────────────────────────

test('reset: valid token + invalid password is rejected, and does NOT consume the token', async () => {
  const { token } = await registerAndRequestReset('reset-badpw');
  await assert.rejects(() => authService.resetPasswordWithToken(token, 'short')); // too short
  await assert.rejects(() => authService.resetPasswordWithToken(token, 'a'.repeat(129))); // too long
  // The token must still be usable — a failed password validation must not
  // have marked it used.
  await assert.doesNotReject(() => authService.resetPasswordWithToken(token, 'brandnewpassword1'));
});

test('reset: old password fails, new password works', async () => {
  const { username, token } = await registerAndRequestReset('reset-oldnew');
  await authService.resetPasswordWithToken(token, 'brandnewpassword1');
  await assert.rejects(() => authService.loginUser(username, 'correcthorsebatterystaple'));
  const user = await authService.loginUser(username, 'brandnewpassword1');
  assert.equal(user.username, username);
});

// ── REPLAY ───────────────────────────────────────────────────────────────

test('replay: reusing the same token after a successful reset is rejected', async () => {
  const { token } = await registerAndRequestReset('replay');
  await authService.resetPasswordWithToken(token, 'brandnewpassword1');
  await assert.rejects(() => authService.resetPasswordWithToken(token, 'yetanotherpassword2'), /Invalid or expired/);
});

// ── RACE CONDITION ───────────────────────────────────────────────────────

test('race: two concurrent uses of the same token — exactly one succeeds', async () => {
  const { token } = await registerAndRequestReset('race');
  const results = await Promise.allSettled([
    authService.resetPasswordWithToken(token, 'racepassword1'),
    authService.resetPasswordWithToken(token, 'racepassword2')
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent attempt should succeed');
  assert.equal(rejected.length, 1, 'the other must be rejected, not silently ignored or both accepted');
});

// ── SESSION REVOCATION ───────────────────────────────────────────────────

test('session: reset revokes existing sessions for the account', async () => {
  const { user, token } = await registerAndRequestReset('sess-revoke');
  const before = sessionService.createSession(user.id);
  assert.ok(sessionService.verifySession(before.token));
  await authService.resetPasswordWithToken(token, 'brandnewpassword1');
  assert.equal(sessionService.verifySession(before.token), null);
});

// ── LOGGING SECURITY ─────────────────────────────────────────────────────

test('logging: the raw token is never logged, on request or on reset', async () => {
  const captured = [];
  const originalLog = console.log, originalError = console.error, originalWarn = console.warn;
  const spy = (...args) => captured.push(args.map(String).join(' '));
  console.log = spy; console.error = spy; console.warn = spy;
  let token;
  try {
    const username = freshUsername('logsafe');
    await authService.registerUser(username, 'x', 'correcthorsebatterystaple');
    await authService.requestPasswordReset(username);
    token = readResetToken();
    await authService.resetPasswordWithToken(token, 'brandnewpassword1');
  } finally {
    console.log = originalLog; console.error = originalError; console.warn = originalWarn;
  }
  assert.ok(token, 'sanity: a token was actually generated for this test');
  const everLogged = captured.some((line) => line.includes(token));
  assert.equal(everLogged, false);
  // Only the safe, value-free markers should appear.
  assert.ok(captured.some((l) => l.includes('PASSWORD_RESET_REQUESTED')));
  assert.ok(captured.some((l) => l.includes('PASSWORD_RESET_SUCCESS')));
});

test('logging: a failed reset attempt logs a safe marker, never the attempted token', async () => {
  const captured = [];
  const originalLog = console.log;
  console.log = (...args) => captured.push(args.map(String).join(' '));
  const badToken = 'not-a-real-token-' + crypto.randomBytes(8).toString('hex');
  try {
    await authService.resetPasswordWithToken(badToken, 'brandnewpassword1').catch(() => {});
  } finally {
    console.log = originalLog;
  }
  assert.ok(!captured.some((l) => l.includes(badToken)));
  assert.ok(captured.some((l) => l.includes('PASSWORD_RESET_FAILED')));
});
