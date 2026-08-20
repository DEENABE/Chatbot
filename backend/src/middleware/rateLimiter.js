import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

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

// ── Auth abuse protection ────────────────────────────────────────────────
//
// Layered rather than a single check, because either dimension alone has a
// known failure mode: IP-only is trivially defeated by rotating IPs, and
// account-only lets an attacker deliberately lock a real user out by
// spamming their username. All limiters below use the same MemoryStore
// approach (express-rate-limit's default) — appropriate because this app
// is single-instance by construction (see electron/main.js's single-
// instance lock from an earlier phase: nothing else can be running these
// counters at the same time). A shared store like Redis would be the right
// call for a multi-instance deployment; introducing one here would be
// unused infrastructure for an app that structurally cannot run more than
// one backend process at once. See the Phase 5 report for the full
// reasoning, including what would need to change if that ever stops being
// true (e.g. this app is ever deployed as a hosted multi-tenant service
// instead of a local desktop app).
//
// Not persisted to the database, and deliberately so: MemoryStore entries
// expire and are garbage-collected per-window automatically (bounded by
// the number of distinct keys active in one window — negligible for a
// single local user), so there's no unbounded growth to guard against and
// no schema to add. A restart clears counters, which only matters if
// something can force-restart the backend at will — on this machine,
// nothing but the user can.

const RATE_LIMIT_MESSAGE = { error: 'Too many attempts. Wait a few minutes and try again.' };

function rateLimitHandler(eventName) {
  // express-rate-limit's default handler already sends the safe generic
  // message below at 429 with RateLimit-* headers (standardHeaders: true)
  // for a safe retry indication — this just adds the server-side log line
  // requested per endpoint, with no request-identifying detail beyond the
  // marker itself (no IP, no username, no token).
  return (_request, response) => {
    console.log(`[auth] ${eventName}`);
    response.status(429).json(RATE_LIMIT_MESSAGE);
  };
}

// Broad per-IP ceiling, shared across register/login/forgot/reset — an
// attacker cycling through many different usernames, or switching between
// endpoints, still runs into one cumulative budget for the IP itself.
export const ipAuthLimiter = rateLimit({
  windowMs: config.rateLimits.ipWindowMs,
  max: config.rateLimits.ipMaxAttempts,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('AUTH_IP_RATE_LIMITED')
});

// Login: ip+username keyed, and only failed attempts count
// (skipSuccessfulRequests) — a legitimate user who mistypes their password
// once or twice and then gets in isn't penalized, but repeated failures
// against the same account are. Enumeration-safe: the 429 response and the
// bucketing key are identical in shape whether or not the username is a
// real account (an unknown username just gets its own, separately-tracked
// bucket — not a distinguishable response).
export const loginLimiter = rateLimit({
  windowMs: config.rateLimits.loginWindowMs,
  max: config.rateLimits.loginMaxAttempts,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (request) => `${request.ip}:${request.body?.username || ''}`,
  handler: rateLimitHandler('LOGIN_RATE_LIMITED')
});

// Forgot-password: ip+username keyed. Coordinates with, rather than
// duplicates, Phase 4's token design — requestPasswordReset() already
// invalidates any previous unused token for the account on every new
// request, so this isn't preventing "unlimited live tokens" (that's
// already structurally impossible), it's bounding the volume of token-
// generation/file-write work and local-file churn an automated flood
// could otherwise cause.
export const resetRequestLimiter = rateLimit({
  windowMs: config.rateLimits.resetRequestWindowMs,
  max: config.rateLimits.resetRequestMaxAttempts,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (request) => `${request.ip}:${request.body?.username || ''}`,
  handler: rateLimitHandler('PASSWORD_RESET_RATE_LIMITED')
});

// Reset-password (confirm step): ip-only. Phase 4 deliberately removed
// username from this request body — identity comes entirely from the
// token — so there is no account identifier left to key on here. The
// token's own 256 bits of entropy already make guessing computationally
// infeasible regardless of rate limit; this is a thin additional layer
// bounding automated attempt volume, not the primary defense.
export const resetConfirmLimiter = rateLimit({
  windowMs: config.rateLimits.resetConfirmWindowMs,
  max: config.rateLimits.resetConfirmMaxAttempts,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('RESET_ATTEMPT_RATE_LIMITED')
});

// Registration: ip-only — there's no account yet to key on. A longer
// window and generous ceiling since legitimately creating an account is a
// rare, one-time action compared to logging in, and this is a local
// desktop app more than one named local user might reasonably share.
export const registerLimiter = rateLimit({
  windowMs: config.rateLimits.registerWindowMs,
  max: config.rateLimits.registerMaxAttempts,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler('REGISTER_RATE_LIMITED')
});

// Progressive delay for login, layered on top of (not instead of)
// loginLimiter's hard cutoff. Reads the SAME counter loginLimiter already
// tracked for this request (express-rate-limit populates request.rateLimit
// on every request that passes through it, blocked or not) — no second
// counting system. Below the threshold, attempts are instant; above it,
// each additional attempt within the window is delayed a little longer,
// capped, so a script throwing rapid-fire guesses slows down well before
// it ever reaches the hard 429 limit.
export function progressiveLoginDelay(request, _response, next) {
  const current = request.rateLimit?.current ?? 0;
  const { progressiveDelayThreshold, progressiveDelayStepMs, progressiveDelayMaxMs } = config.rateLimits;
  if (current <= progressiveDelayThreshold) return next();
  // Earlier visibility than the hard 429 in loginLimiter: this fires the
  // moment failures start piling up, not only once the account is fully
  // blocked — useful for noticing an attack in progress before it peaks.
  if (current === progressiveDelayThreshold + 1) console.log('[auth] LOGIN_FAILED_THRESHOLD');
  const over = current - progressiveDelayThreshold;
  const delay = Math.min(over * progressiveDelayStepMs, progressiveDelayMaxMs);
  setTimeout(next, delay);
}
