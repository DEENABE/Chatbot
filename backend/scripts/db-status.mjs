/**
 * On-demand database identity check — run any time to confirm exactly
 * which database file this app is (or would be) using, without starting
 * the server. Never prints usernames, message content, tokens, or any
 * other row content — path, size, tables, and row counts only.
 *
 * Usage: node scripts/db-status.mjs
 */
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { getDbIdentity } from '../src/lib/storageDiagnostics.js';
import fs from 'node:fs';

console.log('═══════════════════════════════════════════');
console.log('  CHANAKYA AI — Database identity check');
console.log('═══════════════════════════════════════════\n');

console.log(`[storage] Environment: ${process.env.NODE_ENV === 'production' ? 'production' : 'development'}`);
console.log(`[storage] App data directory: ${config.appDataPath}`);
console.log(`[db] path = ${config.dbFile}`);

if (!fs.existsSync(config.dbFile)) {
  console.log('[db] This file does not exist yet — it will be created the first time the backend starts.');
  process.exit(0);
}

const db = new Database(config.dbFile, { readonly: true });
const identity = getDbIdentity(db);
db.close();

console.log(`[db] size = ${(identity.sizeBytes / 1024).toFixed(1)} KB`);
console.log(`[db] tables = ${identity.tables.join(', ')}\n`);
for (const [table, count] of Object.entries(identity.rowCounts)) {
  console.log(`[db] ${table} = ${count}`);
}
