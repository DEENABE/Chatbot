import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated per-run SQLite file — must be set before authService/sessionService
// (and the db.js singleton they both import) are loaded, so this test suite
// never touches the real dev/production database.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-auth-test-'));
process.env.APP_DATA_PATH = tmpDir;

const authService = await import('./authService.js');
const sessionService = await import('./sessionService.js');
const { db } = await import('./db.js');

function freshUsername(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── PASSWORD ────────────────────────────────────────────────────────────

test('password: correct password verifies', async () => {
  const username = freshUsername('pwok');
  await authService.registerUser(username, 'PW OK', 'correcthorsebatterystaple');
  const user = await authService.loginUser(username, 'correcthorsebatterystaple');
  assert.equal(user.username, username);
});

test('password: incorrect password fails', async () => {
  const username = freshUsername('pwbad');
  await authService.registerUser(username, 'PW Bad', 'correcthorsebatterystaple');
  await assert.rejects(
    () => authService.loginUser(username, 'wrongpassword'),
    /Invalid username or password/
  );
});

test('password: never stored in plaintext', async () => {
  const username = freshUsername('pwplain');
  const plaintext = 'correcthorsebatterystaple';
  await authService.registerUser(username, 'PW Plain', plaintext);
  const row = db.prepare('SELECT passwordHash, salt FROM users WHERE username = ?').get(username);
  assert.ok(row.passwordHash && row.passwordHash !== plaintext);
  assert.ok(!row.passwordHash.includes(plaintext));
  // scrypt, 64-byte key -> 128 hex chars; a real salt, not empty/reused-looking.
  assert.equal(row.passwordHash.length, 128);
  assert.ok(row.salt && row.salt.length > 0);
});

test('password: unique salt per user (even with the same password)', async () => {
  const password = 'correcthorsebatterystaple';
  const userA = freshUsername('salta');
  const userB = freshUsername('saltb');
  await authService.registerUser(userA, 'A', password);
  await authService.registerUser(userB, 'B', password);
  const rowA = db.prepare('SELECT salt, passwordHash FROM users WHERE username = ?').get(userA);
  const rowB = db.prepare('SELECT salt, passwordHash FROM users WHERE username = ?').get(userB);
  assert.notEqual(rowA.salt, rowB.salt);
  assert.notEqual(rowA.passwordHash, rowB.passwordHash);
});

test('password: never logged (register + login + wrong-password attempt)', async () => {
  const username = freshUsername('pwlog');
  const password = 'correcthorsebatterystaple';
  const captured = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const spy = (...args) => captured.push(args.map(String).join(' '));
  console.log = spy;
  console.error = spy;
  console.warn = spy;
  try {
    await authService.registerUser(username, 'PW Log', password);
    await authService.loginUser(username, password);
    await authService.loginUser(username, 'wrongpassword').catch(() => {});
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
  const everLogged = captured.some((line) => line.includes(password));
  assert.equal(everLogged, false);
});

test('password: policy rejects too short, too long, non-string, and empty', async () => {
  const username = freshUsername('pwpolicy');
  await assert.rejects(() => authService.registerUser(username, 'x', 'short1'));
  await assert.rejects(() => authService.registerUser(username, 'x', 'a'.repeat(129)));
  await assert.rejects(() => authService.registerUser(username, 'x', 12345678));
  await assert.rejects(() => authService.registerUser(username, 'x', ''));
  // 8 and 128 are the actual boundaries — must be accepted, not just rejected outside them.
  await authService.registerUser(freshUsername('pwmin'), 'x', 'exactly8');
  await authService.registerUser(freshUsername('pwmax'), 'x', 'a'.repeat(128));
});

// ── SESSION ─────────────────────────────────────────────────────────────

test('session: valid session works', async () => {
  const username = freshUsername('sessok');
  const user = await authService.registerUser(username, 'S', 'correcthorsebatterystaple');
  const { token } = sessionService.createSession(user.id);
  const result = sessionService.verifySession(token);
  assert.equal(result.userId, user.id);
});

test('session: expired session fails', async () => {
  const username = freshUsername('sessexp');
  const user = await authService.registerUser(username, 'S', 'correcthorsebatterystaple');
  const { token } = sessionService.createSession(user.id);
  // Force it into the past directly — same tokenHash sessionService itself computes.
  const crypto = await import('node:crypto');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('UPDATE sessions SET expiresAt = ? WHERE tokenHash = ?').run(Date.now() - 1000, tokenHash);
  assert.equal(sessionService.verifySession(token), null);
});

test('session: revoked session fails', async () => {
  const username = freshUsername('sessrev');
  const user = await authService.registerUser(username, 'S', 'correcthorsebatterystaple');
  const { token } = sessionService.createSession(user.id);
  assert.ok(sessionService.verifySession(token));
  sessionService.revokeSession(token);
  assert.equal(sessionService.verifySession(token), null);
});

test('session: logout (revokeSession) revokes only that session, not other devices', async () => {
  const username = freshUsername('sesslogout');
  const user = await authService.registerUser(username, 'S', 'correcthorsebatterystaple');
  const sessionA = sessionService.createSession(user.id);
  const sessionB = sessionService.createSession(user.id);
  sessionService.revokeSession(sessionA.token);
  assert.equal(sessionService.verifySession(sessionA.token), null);
  assert.ok(sessionService.verifySession(sessionB.token), 'other device session must survive a single logout');
});

test('session: repeated/invalid logout is a harmless no-op, not an error', async () => {
  assert.doesNotThrow(() => sessionService.revokeSession('not-a-real-token'));
  assert.doesNotThrow(() => sessionService.revokeSession('not-a-real-token')); // repeated
  assert.doesNotThrow(() => sessionService.revokeSession(''));
});

// ── PASSWORD CHANGE (authenticated) ────────────────────────────────────

test('change-password: requires correct current password, then old creds stop working', async () => {
  const username = freshUsername('chpw');
  const user = await authService.registerUser(username, 'C', 'correcthorsebatterystaple');
  await assert.rejects(
    () => authService.changePassword(user.id, 'wrongcurrent', 'newpassword123'),
    /Current password is incorrect/
  );
  await authService.changePassword(user.id, 'correcthorsebatterystaple', 'newpassword123');
  await assert.rejects(() => authService.loginUser(username, 'correcthorsebatterystaple'));
  const relogin = await authService.loginUser(username, 'newpassword123');
  assert.equal(relogin.username, username);
});

test('change-password: revokes every existing session for the account', async () => {
  const username = freshUsername('chpwrevoke');
  const user = await authService.registerUser(username, 'C', 'correcthorsebatterystaple');
  const before = sessionService.createSession(user.id);
  assert.ok(sessionService.verifySession(before.token));
  await authService.changePassword(user.id, 'correcthorsebatterystaple', 'newpassword123');
  assert.equal(sessionService.verifySession(before.token), null);
});

// ── PASSWORD RESET ──────────────────────────────────────────────────────

test('reset: changes the password — old fails, new works', async () => {
  const username = freshUsername('reset');
  await authService.registerUser(username, 'R', 'correcthorsebatterystaple');
  await authService.resetPassword(username, 'brandnewpassword1');
  await assert.rejects(() => authService.loginUser(username, 'correcthorsebatterystaple'));
  const user = await authService.loginUser(username, 'brandnewpassword1');
  assert.equal(user.username, username);
});

test('reset: revokes existing sessions for the account', async () => {
  const username = freshUsername('resetrevoke');
  const user = await authService.registerUser(username, 'R', 'correcthorsebatterystaple');
  const before = sessionService.createSession(user.id);
  assert.ok(sessionService.verifySession(before.token));
  await authService.resetPassword(username, 'brandnewpassword1');
  assert.equal(sessionService.verifySession(before.token), null);
});

// NOT TESTED, BY DESIGN: reset-token issuance/validation/expiry/one-time-use.
// This app's reset flow has no token step at all — POST /auth/reset-password
// takes {username, newPassword} directly ("identity is proven by machine
// access", see authService.js). There is no token to test. Documented as a
// known gap in the security audit (AUTH-02), not something this phase adds —
// building a token-based flow needs an out-of-band delivery channel (e.g.
// email) this app doesn't have.

// ── REGRESSION ──────────────────────────────────────────────────────────
// HTTP-route-level regression (register/login/logout/protected-API/
// forgot-password over real requests, including through the packaged
// Electron app) was verified live this session — see the Auth Continuity
// Trace report. These re-confirm the same paths at the service layer so
// they run as part of `npm test` going forward instead of only ad hoc.

test('regression: register -> login -> session verify -> logout -> session rejected', async () => {
  const username = freshUsername('regression');
  const password = 'correcthorsebatterystaple';
  const registered = await authService.registerUser(username, 'Regression', password);
  const loggedIn = await authService.loginUser(username, password);
  assert.equal(loggedIn.id, registered.id);

  const { token } = sessionService.createSession(loggedIn.id);
  assert.ok(sessionService.verifySession(token), 'protected API would accept this session');

  sessionService.revokeSession(token);
  assert.equal(sessionService.verifySession(token), null, 'protected API would reject this session post-logout');
});

test('regression: duplicate registration is rejected cleanly', async () => {
  const username = freshUsername('dupe');
  await authService.registerUser(username, 'D', 'correcthorsebatterystaple');
  await assert.rejects(
    () => authService.registerUser(username, 'D again', 'correcthorsebatterystaple'),
    /already taken/
  );
});
