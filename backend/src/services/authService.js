import crypto from 'node:crypto';
import { db } from './db.js';

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export async function registerUser(username, displayName, password) {
  const lowerName = username.toLowerCase().trim();

  if (!lowerName || lowerName.length < 2) {
    throw new Error('Username must be at least 2 characters.');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

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
  const lowerName = username.toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(lowerName);

  if (!user) {
    throw new Error('Invalid username or password.');
  }

  const { hash } = hashPassword(password, user.salt);
  if (hash !== user.passwordHash) {
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
  const { hash } = hashPassword(currentPassword, user.salt);
  if (hash !== user.passwordHash) {
    throw new Error('Current password is incorrect.');
  }
  if (!newPassword || newPassword.length < 8) {
    throw new Error('New password must be at least 8 characters.');
  }
  const { hash: newHash, salt: newSalt } = hashPassword(newPassword);
  db.prepare('UPDATE users SET passwordHash = ?, salt = ? WHERE id = ?').run(newHash, newSalt, userId);
  return { ok: true };
}

// Local, offline password recovery: identity is proven by machine access.
// Resets the password for an existing username (no email round-trip exists).
export async function resetPassword(username, newPassword) {
  const lowerName = username.toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(lowerName);
  if (!user) {
    throw new Error('No account found with that username.');
  }
  if (!newPassword || newPassword.length < 8) {
    throw new Error('New password must be at least 8 characters.');
  }
  const { hash, salt } = hashPassword(newPassword);
  db.prepare('UPDATE users SET passwordHash = ?, salt = ? WHERE id = ?').run(hash, salt, user.id);
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
