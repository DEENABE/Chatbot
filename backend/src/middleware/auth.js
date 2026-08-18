import { verifySession } from '../services/sessionService.js';

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

  request.userId = session.userId;
  request.sessionToken = token;
  next();
}
