import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { migrateMemory } from '../memory/migrations.js';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

let dbInstance = null;

export function getDb() {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

  dbInstance = new Database(config.dbFile);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  dbInstance.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateMemory(dbInstance);

  return dbInstance;
}
