import crypto from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { revokeAllSessionsForUser, hashToken } from './sessionService.js';
import { config } from '../config.js';

// Marks every deliberate failure this module throws (bad password, unknown
// user, duplicate username) as safe to show to the client verbatim — the
// route layer (routes/auth.js) echoes `error.message` only for an
// AuthError; anything else (a DB I/O error, a corrupted database, a bug)
// falls back to a generic message instead of leaking internal detail. Kept
// local to this module rather than reusing lib/validate.js's
// ValidationError: that class hardcodes `.status = 400`, which doesn't fit
// login's 401 — the route already decides the right status per-endpoint,
// this class only needs to mark "message is safe", not carry a status.
export class AuthError extends Error {}

// scrypt runs on libuv's thread pool here, not on the event loop: the synchronous variant froze the whole server for ~40 ms per
// hash, and login is reachable without authentication, so a trickle of bad logins could starve every other request.
// Same parameters as before (Node defaults, 64-byte key), so every stored hash still verifies.
const scrypt = promisify(crypto.scrypt);
async function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return { hash, salt };
}

// scryptSync throws a raw TypeError for anything that isn't a string/Buffer —
// e.g. a numeric or object password — which without this guard bubbled up as
// an uncaught exception, caught by the route's generic catch block and
// returned as a confusing internal error message instead of a clean 400/401.
// `password.length < 8` alone doesn't catch this: a number has no `.length`,
// so `undefined < 8` is `false` and validation silently passed.
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

const MIN_PASSWORD_LENGTH = 8;
// No functional need for scrypt itself (unlike bcrypt, it doesn't silently
// truncate long input) — this exists so a client can't send a
// multi-megabyte string and make the server spend real CPU/memory hashing
// it. 128 comfortably covers any real passphrase a person would type.
const MAX_PASSWORD_LENGTH = 128;

// Centralized so register/change-password/reset-password can't drift from
// each other on what "a valid new password" means.
function assertValidPassword(password, label = 'Password') {
  if (!isNonEmptyString(password)) {
    throw new AuthError(`${label} must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`${label} must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(`${label} must be ${MAX_PASSWORD_LENGTH} characters or fewer.`);
  }
}

// Constant-time comparison — `hash !== user.passwordHash` short-circuits on
// the first differing character, which leaks (in principle) how many
// leading hex characters of a guess were correct via response timing.
// scryptSync's own cost dominates in practice, but there's no reason to
// leave a cheap, well-known mitigation off the table.
function hashesMatch(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function registerUser(username, displayName, password) {
  if (!isNonEmptyString(username)) {
    throw new AuthError('Username is required.');
  }
  const lowerName = username.toLowerCase().trim();

  if (!lowerName || lowerName.length < 2) {
    throw new AuthError('Username must be at least 2 characters.');
  }
  assertValidPassword(password);

  // Check if user already exists
  const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(lowerName);
  if (existingUser) {
    throw new AuthError('Username already taken.');
  }

  const { hash, salt } = await hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    username: lowerName,
    displayName: displayName?.trim() || lowerName,
    email: null,
    department: null,
    role: 'Employee',
    permissions: JSON.stringify(['read', 'write']),
    passwordHash: hash,
    salt,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `
    INSERT INTO users (id, username, displayName, email, department, role, permissions, passwordHash, salt, createdAt)
    VALUES (@id, @username, @displayName, @email, @department, @role, @permissions, @passwordHash, @salt, @createdAt)
  `,
  ).run(user);

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    department: user.department,
    role: user.role,
    permissions: JSON.parse(user.permissions),
    createdAt: user.createdAt,
  };
}

export async function loginUser(username, password) {
  // Same "Invalid username or password." for a malformed request as for a
  // real mismatch — this is the login route, so it stays deliberately
  // generic rather than distinguishing "you sent garbage" from "wrong
  // credentials" (that distinction is exactly what username enumeration
  // attacks go looking for).
  if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
    throw new AuthError('Invalid username or password.');
  }
  const lowerName = username.toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(lowerName);

  if (!user) {
    throw new AuthError('Invalid username or password.');
  }

  const { hash } = await hashPassword(password, user.salt);
  if (!hashesMatch(hash, user.passwordHash)) {
    throw new AuthError('Invalid username or password.');
  }

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    department: user.department,
    role: user.role,
    permissions: user.permissions ? JSON.parse(user.permissions) : [],
    createdAt: user.createdAt,
  };
}

export async function getUserById(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    department: user.department,
    role: user.role,
    permissions: user.permissions ? JSON.parse(user.permissions) : [],
    createdAt: user.createdAt,
  };
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    throw new AuthError('User not found.');
  }
  if (!isNonEmptyString(currentPassword)) {
    throw new AuthError('Current password is incorrect.');
  }
  const { hash } = await hashPassword(currentPassword, user.salt);
  if (!hashesMatch(hash, user.passwordHash)) {
    throw new AuthError('Current password is incorrect.');
  }
  assertValidPassword(newPassword, 'New password');
  const { hash: newHash, salt: newSalt } = await hashPassword(newPassword);
  db.prepare('UPDATE users SET passwordHash = ?, salt = ? WHERE id = ?').run(
    newHash,
    newSalt,
    userId,
  );
  // A leaked/stale session token must stop working the moment the password
  // it was issued under changes (AUTH-01/AUTH-02) — the caller re-issues a
  // fresh session for the device that just made this request.
  revokeAllSessionsForUser(userId);
  return { ok: true };
}

// ── Password reset (forgot-password) ───────────────────────────────────
//
// Previously this app's "reset" was `{username, newPassword}` with no
// token at all — identity proven only by knowing a username. This is a
// real token-based flow now. It's still not email-delivered: this is a
// fully offline desktop app with no email address ever collected and no
// SMTP/email-provider infrastructure — building one would be a much larger,
// unrequested architecture change (new external dependency, new secrets to
// manage) than this phase asks for. The raw token is instead written to a
// local file in the same storage directory as the database itself — the
// same trust tier "identity is proven by machine access" already relies on
// elsewhere in this app. This is a strict improvement over the old
// behavior: resetting now requires machine access AND being the one who
// triggered the request (reading the just-written file), not just knowing
// a username.

const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // short-lived — a much higher-stakes credential than a login session
const RESET_TOKEN_FILE = path.join(path.dirname(config.dbFile), 'password-reset-token.txt');
const MAX_USERNAME_LOOKUP_LENGTH = 128;

function writeLocalResetToken(username, token, expiresAt) {
  const body = [
    `Password reset requested for user: ${username}`,
    `Reset code: ${token}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    '',
    'Enter this code in the app to finish resetting your password.',
    'This file is overwritten by the next reset request and deleted once the code is used.',
    '',
  ].join('\n');
  // 0o600: owner read/write only. Best-effort on platforms where chmod
  // semantics don't map cleanly (e.g. Windows) — the OS/filesystem ACLs on
  // the containing storage directory are the real boundary there either way.
  fs.writeFileSync(RESET_TOKEN_FILE, body, { encoding: 'utf8', mode: 0o600 });
}

function clearLocalResetToken() {
  try {
    fs.unlinkSync(RESET_TOKEN_FILE);
  } catch {
    // Already gone (or never existed) — fine, this is just cleanup.
  }
}

// Always returns the same shape (nothing) whether or not the account
// exists — the route layer sends one identical response regardless, so
// this endpoint can't be used to enumerate accounts. Logs only the safe,
// value-free markers from PASSWORD_RESET_REQUESTED — never the token,
// never which branch (found/not-found) was actually taken.
export async function requestPasswordReset(username) {
  const usable = isNonEmptyString(username) && username.length <= MAX_USERNAME_LOOKUP_LENGTH;
  const lowerName = usable ? username.toLowerCase().trim() : '';
  const user = usable
    ? db.prepare('SELECT id, username FROM users WHERE username = ?').get(lowerName)
    : null;

  // Do the same shape of CPU work (generate + hash a token) regardless of
  // whether an account was found, so the dominant observable cost doesn't
  // itself signal existence. The disk I/O below (DB write + file write,
  // skipped entirely when there's no account) is a smaller, noisier
  // residual timing signal — an intentional, documented tradeoff, not an
  // oversight: this is a loopback-only, single-user desktop app, not a
  // hosted multi-tenant service, so the realistic attacker able to reach
  // this endpoint at all already has local execution on the machine.
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);

  console.log('[auth] PASSWORD_RESET_REQUESTED');

  if (!user) return;

  // Only one active reset credential per account — issuing a new one
  // retires any previous unused one outright, so an old, possibly-forgotten
  // request can't sit around as a second standing way into the account.
  db.prepare('DELETE FROM password_resets WHERE userId = ?').run(user.id);

  const now = Date.now();
  db.prepare(
    'INSERT INTO password_resets (id, userId, tokenHash, expiresAt, usedAt, createdAt) VALUES (@id, @userId, @tokenHash, @expiresAt, NULL, @createdAt)',
  ).run({
    id: crypto.randomUUID(),
    userId: user.id,
    tokenHash,
    expiresAt: now + RESET_TOKEN_TTL_MS,
    createdAt: now,
  });

  writeLocalResetToken(user.username, token, now + RESET_TOKEN_TTL_MS);
}

// Identity comes entirely from the token — there is no username/userId
// parameter here at all, so a client cannot pair a valid token with a
// different account.
export async function resetPasswordWithToken(token, newPassword) {
  if (!isNonEmptyString(token) || token.length > 256) {
    console.log('[auth] PASSWORD_RESET_FAILED');
    throw new AuthError('Invalid or expired reset code.');
  }
  assertValidPassword(newPassword, 'New password');

  const tokenHash = hashToken(token);
  const now = Date.now();

  // Atomic claim: the WHERE clause (unused AND not expired) IS the check —
  // there is no separate "read usedAt, then later write usedAt" gap for a
  // second concurrent request to land in. better-sqlite3 executes this
  // synchronously, so nothing else touching this row can interleave with it.
  const claim = db
    .prepare(
      'UPDATE password_resets SET usedAt = ? WHERE tokenHash = ? AND usedAt IS NULL AND expiresAt > ?',
    )
    .run(now, tokenHash, now);

  if (claim.changes === 0) {
    console.log('[auth] PASSWORD_RESET_FAILED');
    throw new AuthError('Invalid or expired reset code.');
  }

  const record = db
    .prepare('SELECT userId FROM password_resets WHERE tokenHash = ?')
    .get(tokenHash);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(record.userId);
  if (!user) {
    // Structurally shouldn't happen — ON DELETE CASCADE removes this row
    // the moment the user is deleted — but never trust that silently.
    console.log('[auth] PASSWORD_RESET_FAILED');
    throw new AuthError('Invalid or expired reset code.');
  }

  // The token is already claimed at this point (fail-closed): if hashing or
  // the update below somehow throws, the token stays permanently unusable
  // rather than staying valid for a retry — a stuck reset request is a far
  // smaller problem than reopening the single-use guarantee.
  const { hash, salt } = await hashPassword(newPassword);
  const applyReset = db.transaction(() => {
    db.prepare('UPDATE users SET passwordHash = ?, salt = ? WHERE id = ?').run(hash, salt, user.id);
    // Same reasoning as changePassword: kill every existing session for the
    // account, including one an attacker may already hold, the moment the
    // password changes.
    revokeAllSessionsForUser(user.id);
  });
  applyReset();

  clearLocalResetToken();
  console.log('[auth] PASSWORD_RESET_SUCCESS');
  return { ok: true };
}

// Irreversible: deletes the account row (ON DELETE CASCADE in schema.sql
// takes care of sessions/chats/messages/memories/documents/folders/
// password_resets for this userId) plus the one piece of this user's data
// that lives outside SQLite — their per-user LanceDB vector store directory
// (see vectorService.js's `db(userId)`, which derives the exact same path).
// Requires the current password, same proof-of-identity bar as
// changePassword, since this is far more destructive than a routine edit.
export async function deleteAccount(userId, password) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    throw new AuthError('User not found.');
  }
  if (!isNonEmptyString(password)) {
    throw new AuthError('Password is incorrect.');
  }
  const { hash } = await hashPassword(password, user.salt);
  if (!hashesMatch(hash, user.passwordHash)) {
    throw new AuthError('Password is incorrect.');
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  // The DB runs in WAL mode (db/connection.js): a committed DELETE lands in
  // the -wal sidecar file first and is only merged into the main .sqlite
  // file at SQLite's own checkpoint threshold (a few MB of writes) or on
  // clean shutdown. Any tool that reads db.sqlite directly without also
  // understanding WAL — a plain SQLite viewer, a copy of the file — sees
  // the pre-delete state until then, i.e. a "deleted" account that still
  // looks present. Account deletion is rare and deliberate, so forcing an
  // immediate checkpoint here (unlike on every ordinary write, where the
  // I/O cost isn't worth paying) makes the on-disk file accurate right away.
  db.pragma('wal_checkpoint(TRUNCATE)');

  const vectorDir = path.join(path.dirname(config.dbFile), 'users', userId);
  try {
    fs.rmSync(vectorDir, { recursive: true, force: true });
  } catch (error) {
    console.error(
      `[auth] Failed to remove vector store for deleted account ${userId}:`,
      error.message,
    );
  }

  return { ok: true };
}

// Allowlisted fields only (Step 13: mass assignment protection) — `role`,
// `permissions`, `id`, `passwordHash`, `salt` etc. are never accepted here
// even if a caller passes them in `data`, because they are never read out of
// it. There is intentionally no API path that lets an account change its own
// role; promoting a user to Admin is a direct DB operation only.
export async function updateUserProfile(userId, data) {
  const invalid = (message) => Object.assign(new AuthError(message), { status: 400 });
  const current = await getUserById(userId);
  if (!current) throw Object.assign(new AuthError('Account not found.'), { status: 404 });
  const fields = {};
  for (const [key, limit] of [
    ['displayName', 120],
    ['email', 254],
    ['department', 120],
  ]) {
    if (data[key] === undefined) {
      fields[key] = current[key] ?? null;
      continue;
    }
    if (typeof data[key] !== 'string' || data[key].length > limit)
      throw invalid(`Invalid ${key === 'displayName' ? 'display name' : key}.`);
    const value = data[key].trim();
    if (key === 'displayName' && !value) throw invalid('Display name is required.');
    if (key === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      throw invalid('Enter a valid email address.');
    fields[key] = value || null;
  }
  db.prepare(
    `
    UPDATE users
    SET displayName = ?,
        email = ?,
        department = ?
    WHERE id = ?
  `,
  ).run(fields.displayName, fields.email, fields.department, userId);

  return getUserById(userId);
}
