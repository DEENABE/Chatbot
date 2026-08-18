import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from '../config.js';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

let dbInstance = null;

export function getDb() {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

  dbInstance = new Database(config.dbFile);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  dbInstance.exec(fs.readFileSync(schemaPath, 'utf8'));

  // First-run seed: an empty install needs at least one account to log in
  // with. Still the same admin/admin default the security audit flagged
  // (AUTH-04) — that removal is tracked separately, not part of this swap.
  const { count } = dbInstance.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count === 0) {
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync('admin', salt, 64).toString('hex');
    dbInstance
      .prepare(
        `INSERT INTO users (id, username, displayName, email, department, role, permissions, passwordHash, salt, createdAt)
         VALUES (@id, @username, @displayName, @email, @department, @role, @permissions, @passwordHash, @salt, @createdAt)`
      )
      .run({
        id: crypto.randomUUID(),
        username: 'admin',
        displayName: 'Chanakya Developer',
        email: null,
        department: null,
        role: 'Employee',
        permissions: JSON.stringify(['read', 'write']),
        passwordHash,
        salt,
        createdAt: new Date().toISOString()
      });
  }

  return dbInstance;
}
