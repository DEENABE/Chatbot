import rateLimit from 'express-rate-limit';

// Local model = single GPU/CPU worker, so protect it from being
// swamped by concurrent requests from a desktop UI (e.g. accidental
// double-submits, retry loops).
export const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});
