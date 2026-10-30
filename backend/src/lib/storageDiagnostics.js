/**
 * @module lib/storageDiagnostics
 * @description Makes the one canonical storage location impossible to miss
 * or misremember. Two consumers:
 *   - logStartupDiagnostics(): printed once, every server start.
 *   - getDbIdentity(db): path/size/tables/row-counts for an already-open
 *     database handle — used by scripts/db-status.mjs for on-demand checks,
 *     and safe to call any time since it only counts rows, never reads or
 *     logs actual content (no usernames, no message text, no tokens).
 */

import fs from 'node:fs';
import { config } from '../config.js';

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function logStartupDiagnostics() {
  const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const exists = fs.existsSync(config.dbFile);
  const sizeBytes = exists ? fs.statSync(config.dbFile).size : 0;

  console.log(`[storage] Environment: ${environment}`);
  console.log(`[storage] App data directory: ${config.appDataPath}`);
  console.log(`[storage] Database path: ${config.dbFile}`);
  console.log(`[storage] Database exists: ${exists}`);
  console.log(`[storage] Database size: ${formatBytes(sizeBytes)}`);
  console.log(`[storage] Uploads directory: ${config.uploadDir}`);
  console.log(`[storage] Vector store directory: ${config.vectorDir}`);
  console.log(`[translate] IndicTrans2 URL: ${config.translate.serviceUrl}`);
}

export function logDatabaseInitialized() {
  console.log(`[storage] Database initialized: true (${config.dbFile})`);
}

/**
 * @param {import('better-sqlite3').Database} db - an already-open handle
 * @returns {{path: string, sizeBytes: number, tables: string[], rowCounts: Record<string, number>}}
 */
export function getDbIdentity(db) {
  const exists = fs.existsSync(config.dbFile);
  const sizeBytes = exists ? fs.statSync(config.dbFile).size : 0;
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);

  const rowCounts = {};
  for (const table of tables) {
    // Table names come only from sqlite_master above, never user input —
    // safe to interpolate directly, better-sqlite3 has no parameter
    // binding for identifiers anyway.
    rowCounts[table] = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
  }

  return { path: config.dbFile, sizeBytes, tables, rowCounts };
}
