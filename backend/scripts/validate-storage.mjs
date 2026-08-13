#!/usr/bin/env node
/**
 * Structural verification for backend/storage/*.json(l) files.
 *
 * Catches, before any request handler does:
 *   - JSON syntax errors (a truncated/partially-written file)
 *   - Schema violations (wrong types, missing required fields, stray keys)
 *   - Duplicate ids within an array (two sessions/users/chats sharing an id)
 *   - Unparseable embedded-JSON string fields (e.g. a user's `permissions`
 *     cell) — this exact case crashed /api/agent and /api/repair via an
 *     unguarded JSON.parse in authService.js before it was made defensive.
 *
 * Usage: node scripts/validate-storage.mjs
 * Exit code 0 = clean, 1 = at least one problem found.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { SUBDOMAINS } from '../src/knowledge/subdomains.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemasDir = path.join(root, 'src', 'schemas');
const storageDir = path.join(root, 'storage');

// ajv-core doesn't ship format validators (that's the separate ajv-formats
// package) — "format": "date-time" in the schemas is documentation for
// readers, not an enforced check, so silence the "unknown format" notices.
const ajv = new Ajv2020({ allErrors: true, strict: false, logger: false });

function loadSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(schemasDir, name), 'utf8'));
}

const problems = [];
function fail(file, message) {
  problems.push(`${file}: ${message}`);
}

// Groups repeats of the same error shape (e.g. one bad enum value hit by 800
// records) into a single line with a count, instead of flooding the report.
function summarize(list) {
  const groups = new Map();
  for (const p of list) {
    const key = p.replace(/\/\d+\//, '/N/').replace(/index \d+/, 'index N');
    if (!groups.has(key)) groups.set(key, { count: 0, examples: [] });
    const g = groups.get(key);
    g.count++;
    if (g.examples.length < 3) g.examples.push(p);
  }
  return [...groups.entries()].map(([key, g]) =>
    g.count === 1 ? g.examples[0] : `${key}  (x${g.count}, e.g. ${g.examples.join(' | ')})`
  );
}

function findDuplicates(items, keyFn, label) {
  const seen = new Map();
  for (let i = 0; i < items.length; i++) {
    const key = keyFn(items[i]);
    if (key === undefined || key === null) continue;
    if (seen.has(key)) {
      fail(label, `duplicate ${key} at index ${i} (first seen at index ${seen.get(key)})`);
    } else {
      seen.set(key, i);
    }
  }
}

function checkEmbeddedJson(items, field, label) {
  for (let i = 0; i < items.length; i++) {
    const raw = items[i][field];
    if (raw === null || raw === undefined) continue;
    try {
      JSON.parse(raw);
    } catch (err) {
      fail(label, `index ${i} has unparseable '${field}': ${err.message}`);
    }
  }
}

// ── db_store.json ────────────────────────────────────────────────────────
function validateDbStore() {
  const file = path.join(storageDir, 'db_store.json');
  const label = 'storage/db_store.json';
  if (!fs.existsSync(file)) {
    console.log(`[skip] ${label} does not exist yet.`);
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(label, `JSON syntax error: ${err.message}`);
    return;
  }

  const validate = ajv.compile(loadSchema('dbStore.schema.json'));
  if (!validate(data)) {
    for (const err of validate.errors) {
      fail(label, `${err.instancePath || '(root)'} ${err.message}`);
    }
  }

  if (Array.isArray(data.users)) {
    findDuplicates(data.users, (u) => u.id, label + ' [users.id]');
    findDuplicates(data.users, (u) => u.username, label + ' [users.username]');
    checkEmbeddedJson(data.users, 'permissions', label + ' [users.permissions]');
  }
  if (Array.isArray(data.chats)) {
    findDuplicates(data.chats, (c) => c.id, label + ' [chats.id]');
  }
  if (Array.isArray(data.messages)) {
    findDuplicates(data.messages, (m) => m.id, label + ' [messages.id]');
    checkEmbeddedJson(data.messages, 'sources', label + ' [messages.sources]');
  }
  if (Array.isArray(data.folders)) {
    findDuplicates(data.folders, (f) => f.id, label + ' [folders.id]');
  }
  if (Array.isArray(data.memories)) {
    findDuplicates(data.memories, (m) => m.id, label + ' [memories.id]');
  }
  if (Array.isArray(data.documents)) {
    findDuplicates(data.documents, (d) => d.id, label + ' [documents.id]');
  }
}

// ── repair-sessions.json / automation-sessions.json ───────────────────────
// Same schema for both (it already covers domain:'automation') — the raw
// session logs are split by RepairLogger.js, not by shape. Compiled once and
// reused: ajv errors on a second compile() of a schema with the same $id.
const validateSession = ajv.compile(loadSchema('repairSessions.schema.json'));

function validateSessionsFile(filename) {
  const file = path.join(storageDir, filename);
  const label = `storage/${filename}`;
  if (!fs.existsSync(file)) {
    console.log(`[skip] ${label} does not exist yet.`);
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(label, `JSON syntax error: ${err.message}`);
    return;
  }

  if (!validateSession(data)) {
    for (const err of validateSession.errors) {
      fail(label, `${err.instancePath || '(root)'} ${err.message}`);
    }
  }

  if (Array.isArray(data)) {
    findDuplicates(data, (s) => s.id, label + ' [sessions.id]');

    // The schema enum can only check that a subdomain is known *somewhere*.
    // The real invariant is that it belongs to its own domain — a
    // "network"-domain session tagged "printer" still gets silently dropped
    // by normalizeSubdomain() at export.
    data.forEach((session, i) => {
      if (!session.subdomain) return;
      const allowed = SUBDOMAINS[session.domain] || [];
      if (!allowed.includes(session.subdomain)) {
        fail(label, `index ${i}: subdomain '${session.subdomain}' is not valid for domain '${session.domain}'`);
      }
    });
  }
}

// ── *-dataset.jsonl (JSON Lines — one object per line) ─────────────────────
// repair-dataset.jsonl, automation-dataset.jsonl, general-dataset.jsonl are
// all { messages: [...] } chat-format exports — same shape, same schema.
// Compiled once and reused, same reason as validateSession above.
const validateDatasetLine = ajv.compile(loadSchema('repairDatasetLine.schema.json'));

function validateDatasetFile(filename) {
  const file = path.join(storageDir, filename);
  const label = `storage/${filename}`;
  if (!fs.existsSync(file)) {
    console.log(`[skip] ${label} does not exist yet.`);
    return;
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return; // blank lines are harmless in JSONL
    const lineNo = i + 1;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      fail(label, `line ${lineNo}: JSON syntax error: ${err.message}`);
      return;
    }
    if (!validateDatasetLine(obj)) {
      for (const err of validateDatasetLine.errors) {
        fail(label, `line ${lineNo}: ${err.instancePath || '(root)'} ${err.message}`);
      }
    }
  });
}

validateDbStore();
validateSessionsFile('repair-sessions.json');
validateSessionsFile('automation-sessions.json');
validateDatasetFile('repair-dataset.jsonl');
validateDatasetFile('automation-dataset.jsonl');
validateDatasetFile('general-dataset.jsonl');
validateDatasetFile('general-examples.jsonl');

if (problems.length) {
  const grouped = summarize(problems);
  console.error(`\n✖ ${problems.length} problem(s) found (${grouped.length} distinct):\n`);
  for (const p of grouped) console.error('  - ' + p);
  console.error('');
  process.exit(1);
} else {
  console.log('✔ All storage files are structurally valid.');
}
