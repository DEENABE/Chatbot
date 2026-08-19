import crypto from 'node:crypto';
import { db } from './db.js';

/**
 * Real server-side sessions, replacing the old scheme where the client's
 * `x-user-id` header — a permanent, unsigned, un-revocable claim — WAS the
 * entire authentication mechanism (AUTH-01 in the security audit).
 *
 * Tokens are high-entropy random bearer values (256 bits), not JWTs: since
 * revocation and expiry both require a server-side lookup anyway, a signed
 * claim buys nothing here. Only the SHA-256 hash of the token is ever
 * persisted, so a leak of the session store (the exact way db_store.json
 * leaked before) doesn't hand out live, usable sessions.
 */

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_THRESHOLD_MS = SESSION_TTL_MS / 2; // sliding refresh past the halfway point

// Exported: password-reset tokens (authService.js) use this exact same
// hash-the-opaque-token pattern rather than a second, duplicate one.
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Issue a new session for a user. Returns the raw token — shown once, never stored. */
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  db.prepare(
    'INSERT INTO sessions (id, userId, tokenHash, createdAt, expiresAt) VALUES (@id, @userId, @tokenHash, @createdAt, @expiresAt)'
  ).run({
    id: crypto.randomUUID(),
    userId,
    tokenHash: hashToken(token),
    createdAt: now,
    expiresAt
  });

  return { token, expiresAt };
}

/** Verify a bearer token. Returns { userId } if valid, or null if missing/expired/revoked. */
export function verifySession(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db.prepare('SELECT * FROM sessions WHERE tokenHash = ?').get(tokenHash);
  if (!row) return null;

  const now = Date.now();
  if (row.expiresAt < now) {
    db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(tokenHash);
    return null;
  }

  // Sliding expiry: an active session shouldn't die mid-use, but an
  // untouched/stolen token still expires on schedule rather than living
  // forever — the exact permanence problem AUTH-01 flagged.
  if (row.expiresAt - now < REFRESH_THRESHOLD_MS) {
    db.prepare('UPDATE sessions SET expiresAt = ? WHERE tokenHash = ?').run(now + SESSION_TTL_MS, tokenHash);
  }

  return { userId: row.userId };
}

/** Revoke a single session (logout). */
export function revokeSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(hashToken(token));
}

/** Revoke every session belonging to a user — e.g. on password change/reset. */
export function revokeAllSessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE userId = ?').run(userId);
}
