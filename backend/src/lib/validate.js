import { isValidUuid } from './validateUuid.js';

/**
 * Thrown by every helper below. `.status` is read by app.js's generic error
 * handler (the one shared choke point every route eventually funnels an
 * unhandled error through) to decide whether a message is safe to echo back
 * to the client — only errors deliberately constructed here carry a status,
 * so a raw DB/library exception can never accidentally leak its message just
 * by having a `.status` property collide with this convention.
 */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

/**
 * HTTP Parameter Pollution guard: a query/body value that's supposed to be a
 * single scalar can arrive as an array instead — `?q=a&q=b` parses to
 * `['a','b']`, not a string — because Express's default query parser accepts
 * repeated keys. Collapsing to the first value keeps behavior deterministic
 * rather than passing an array into a SQL bind param (better-sqlite3 throws)
 * or a string context (silently stringifies to "a,b").
 */
export function scalar(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function requireString(value, field, { min = 1, max = 1000 } = {}) {
  value = scalar(value);
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new ValidationError(`${field} is required.`);
  }
  if (value.length > max) {
    throw new ValidationError(`${field} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

/** Same as requireString, but undefined/null/empty is allowed through as undefined. */
export function optionalString(value, field, opts = {}) {
  value = scalar(value);
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field, opts);
}

export function requireEnum(value, field, allowed) {
  value = scalar(value);
  if (!allowed.includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

/** Bounded integer with a default when the field is absent — never trusts an unbounded client-supplied number (Step 19: resource exhaustion via e.g. maxSteps=999999999). */
export function boundedInt(value, field, { min, max, fallback }) {
  value = scalar(value);
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max}.`);
  }
  return n;
}

/** Express middleware: reject a route param that isn't UUID-shaped before it ever reaches a query. */
export function requireUuidParam(paramName) {
  return (request, _response, next) => {
    if (!isValidUuid(request.params[paramName])) {
      return next(new ValidationError(`Invalid ${paramName}.`));
    }
    next();
  };
}
