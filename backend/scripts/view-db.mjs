import Database from 'better-sqlite3';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'storage', 'db.sqlite');
const db = new Database(dbPath, { readonly: true });

console.log('═══════════════════════════════════════════');
console.log('  CHANAKYA AI — db.sqlite VIEWER');
console.log('═══════════════════════════════════════════\n');

// 1. List all tables
console.log('📋 TABLES:');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
tables.forEach(t => console.log('  •', t.name));

// 2. Show Users
console.log('\n👤 USERS TABLE:');
const users = db.prepare('SELECT id, username, displayName, role, createdAt FROM users').all();
users.forEach((u, i) => {
  console.log(`  [${i + 1}] username: ${u.username} | display: ${u.displayName} | role: ${u.role} | created: ${u.createdAt} | id: ${u.id}`);
});
console.log(`  Total users: ${users.length}`);

// 3. Show Sessions
console.log('\n🔑 SESSIONS TABLE:');
const sessions = db.prepare('SELECT id, userId, tokenHash, createdAt, expiresAt FROM sessions').all();
if (sessions.length === 0) {
  console.log('  (no active sessions)');
} else {
  sessions.forEach((s, i) => {
    const expires = new Date(s.expiresAt).toISOString();
    const created = new Date(s.createdAt).toISOString();
    console.log(`  [${i + 1}] userId: ${s.userId} | created: ${created} | expires: ${expires} | hash: ${s.tokenHash.substring(0, 16)}...`);
  });
}
console.log(`  Total sessions: ${sessions.length}`);

// 4. Table schemas
console.log('\n📐 TABLE SCHEMAS:');
tables.forEach(t => {
  const cols = db.prepare(`PRAGMA table_info('${t.name}')`).all();
  console.log(`\n  ${t.name}:`);
  cols.forEach(c => {
    console.log(`    ${c.name} (${c.type || 'TEXT'}${c.pk ? ' PRIMARY KEY' : ''}${c.notnull ? ' NOT NULL' : ''})`);
  });
});

db.close();
console.log('\n✅ Done.');
