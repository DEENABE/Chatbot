import crypto from 'node:crypto';
import { db } from './db.js';
import { revokeAllSessionsForUser } from './sessionService.js';

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
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
    throw new Error(`${label} must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`${label} must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`${label} must be ${MAX_PASSWORD_LENGTH} characters or fewer.`);
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
    throw new Error('Username is required.');
  }
  const lowerName = username.toLowerCase().trim();

  if (!lowerName || lowerName.length < 2) {
    throw new Error('Username must be at least 2 characters.');
  }
  assertValidPassword(password);

  // Check if user already exists
  const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(lowerName);
  if (existingUser) {
    throw new Error('Username already taken.');
  }

  const { hash, salt } = hashPassword(password);
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
    createdAt: new Date().toISOString()
  };

  db.prepare(`
    INSERT INTO users (id, username, displayName, email, department, role, permissions, passwordHash, salt, createdAt)
    VALUES (@id, @username, @displayName, @email, @department, @role, @permissions, @passwordHash, @salt, @createdAt)
  `).run(user);

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    department: user.department,
    role: user.role,
    permissions: JSON.parse(user.permissions),
    createdAt: user.createdAt
  };
}

export async function loginUser(username, password) {
  // Same "Invalid username or password." for a malformed request as for a
  // real mismatch — this is the login route, so it stays deliberately
  // generic rather than distinguishing "you sent garbage" from "wrong
  // credentials" (that distinction is exactly what username enumeration
  // attacks go looking for).
  if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
    throw new Error('Invalid username or password.');
  }
  const lowerName = username.toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(lowerName);

  if (!user) {
    throw new Error('Invalid username or password.');
  }

  const { hash } = hashPassword(password, user.salt);
  if (!hashesMatch(hash, user.passwordHash)) {
    throw new Error('Invalid username or password.');
  }

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    department: user.department,
    role: user.role,
    permissions: user.permissions ? JSON.parse(user.permissions) : [],
    createdAt: user.createdAt
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
    createdAt: user.createdAt
  };
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    throw new Error('User not found.');
  }
  if (!isNonEmptyString(currentPassword)) {
    throw new Error('Current password is incorrect.');
  }
  const { hash } = hashPassword(currentPassword, user.salt);
  if (!hashesMatch(hash, user.passwordHash)) {
    throw new Error('Current password is incorrect.');
  }
  assertValidPassword(newPassword, 'New password');
  const { hash: newHash, salt: newSalt } = hashPassword(newPassword);
  db.prepare('UPDATE users SET passwordHash = ?, salt = ? WHERE id = ?').run(newHash, newSalt, userId);
  // A leaked/stale session token must stop working the moment the password
  // it was issued under changes (AUTH-01/AUTH-02) — the caller re-issues a
  // fresh session for the device that just made this request.
  revokeAllSessionsForUser(userId);
  return { ok: true };
}

// Local, offline password recovery: identity is proven by machine access.
// Resets the password for an existing username (no email round-trip exists).
export async function resetPassword(username, newPassword) {
  if (!isNonEmptyString(username)) {
    throw new Error('No account found with that username.');
  }
  const lowerName = username.toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(lowerName);
  if (!user) {
    throw new Error('No account found with that username.');
  }
  assertValidPassword(newPassword, 'New password');
  const { hash, salt } = hashPassword(newPassword);
  db.prepare('UPDATE users SET passwordHash = ?, salt = ? WHERE id = ?').run(hash, salt, user.id);
  // Same reasoning as changePassword: kill every existing session for the
  // account, including one an attacker may already hold, the moment the
  // password changes.
  revokeAllSessionsForUser(user.id);
  return { ok: true };
}

export async function updateUserProfile(userId, data) {
  db.prepare(`
    UPDATE users
    SET displayName = COALESCE(?, displayName),
        email = COALESCE(?, email),
        department = COALESCE(?, department),
        role = COALESCE(?, role)
    WHERE id = ?
  `).run(data.displayName || null, data.email || null, data.department || null, data.role || null, userId);

  return getUserById(userId);
}
