import rateLimit from 'express-rate-limit';

// Local model = single GPU/CPU worker, so protect it from being
// swamped by concurrent requests from a desktop UI (e.g. accidental
// double-submits, retry loops). Was defined but never mounted anywhere.
export const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});

// Password endpoints had no rate limit at all, so scryptSync's cost (the
// point of using it) was the only thing slowing down a guessing script — and
// resetPassword needs no proof of identity beyond a username, so it's the
// more important of the two to throttle. Keyed by IP + username so one
// account being hammered doesn't lock out every other user on the box.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (request) => `${request.ip}:${request.body?.username || ''}`,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' }
});
