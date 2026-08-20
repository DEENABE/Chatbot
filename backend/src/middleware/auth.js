import { verifySession } from '../services/sessionService.js';
import { isValidUuid } from '../lib/validateUuid.js';
import { db } from '../services/db.js';

// The only role value that counts as elevated. Nothing in this app can set
// a user's `role` column to this except a direct DB write (see
// authService.updateUserProfile, which deliberately excludes `role` from the
// fields a user can self-edit) — there is no self-service or API path that
// promotes an account, by design.
const ADMIN_ROLE = 'Admin';

/**
 * Requires a valid, non-expired, non-revoked session token in
 * `Authorization: Bearer <token>`. Replaces the old scheme where every route
 * trusted a bare `x-user-id` header as if it were proof of identity
 * (AUTH-01 / RAG-03 in the security audit) — that header was never verified
 * against anything, so any process on the machine could claim any user.
 */
export function requireAuth(request, response, next) {
  const header = request.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) {
    return response.status(401).json({ error: 'Authentication required.' });
  }

  const session = verifySession(token);
  if (!session) {
    return response.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }

  // session.userId always comes from a DB row keyed by crypto.randomUUID()
  // (see sessionService.js), never from request input — this should be
  // unreachable. It's checked anyway as the one shared choke point every
  // authenticated request passes through (RAG-04): every route and service
  // downstream trusts request.userId outright, several eventually building
  // filesystem paths or query filters from it, so a corrupted/malformed
  // value must be caught here rather than silently trusted deeper in.
  if (!isValidUuid(session.userId)) {
    console.error('[auth] session resolved to a non-UUID userId:', session.userId);
    return response.status(500).json({ error: 'Unexpected local server error.' });
  }

  request.userId = session.userId;
  request.sessionToken = token;
  next();
}

/**
 * Authorization (not authentication) gate: must run after requireAuth.
 * A valid session proves who the caller is; this proves they're allowed to
 * hit an admin-only route. Role is re-read from the DB on every call rather
 * than trusted from anything the client sent, so there is exactly one place
 * in the app that decides "is this user an admin" (Step 8/22: centralized,
 * not duplicated per-controller).
 */
export function requireAdmin(request, response, next) {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(request.userId);
  if (!user || user.role !== ADMIN_ROLE) {
    return response.status(403).json({ error: 'Admin privileges required.' });
  }
  next();
}
