#!/usr/bin/env node
/**
 * Dataset Manager CLI for .json and .jsonl files.
 *
 * Supports:
 *   - Checking duplicate entries in .json or .jsonl files
 *   - Deduplicating / cleaning .json or .jsonl files
 *   - Adding new entry/entries to .json or .jsonl files with duplicate checking
 *
 * Commands:
 *   node dataset-manager.mjs check <filePath> [--key <field>]
 *   node dataset-manager.mjs dedupe <filePath> [--key <field>] [--output <outPath>]
 *   node dataset-manager.mjs add <filePath> '<json-string-or-file-path>' [--key <field>] [--allow-duplicates]
 */

import fs from 'node:fs';
import path from 'node:path';

/** Detect if file is JSONL based on path or content */
export function isJsonl(filePath, content = '') {
  if (filePath && filePath.endsWith('.jsonl')) return true;
  if (content) {
    const trimmed = content.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return true;
    const firstLine = trimmed.split('\n')[0].trim();
    try {
      JSON.parse(firstLine);
      return trimmed.includes('\n');
    } catch {
      return false;
    }
  }
  return false;
}

/** Compute a canonical string representation for object equality */
export function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',') + '}';
}

/** Extract entry key for duplicate matching (supports dot notation like "user.id" and optional ignoreCase) */
export function getEntryKey(entry, keyField, options = {}) {
  const ignoreCase = Boolean(options.ignoreCase);
  if (!keyField) {
    const rawKey = canonicalize(entry);
    return ignoreCase ? rawKey.toLowerCase() : rawKey;
  }
  if (typeof entry === 'object' && entry !== null) {
    const parts = String(keyField).split('.');
    let val = entry;
    for (const part of parts) {
      if (val !== null && typeof val === 'object' && part in val) {
        val = val[part];
      } else {
        val = undefined;
        break;
      }
    }
    if (val !== undefined) {
      const res = typeof val === 'object' ? canonicalize(val) : String(val);
      return ignoreCase ? res.toLowerCase() : res;
    }
  }
  const fallback = canonicalize(entry);
  return ignoreCase ? fallback.toLowerCase() : fallback;
}

/** Read entries from a .json or .jsonl file */
export function readEntries(filePath) {
  if (!fs.existsSync(filePath)) {
    return { format: filePath.endsWith('.jsonl') ? 'jsonl' : 'json', entries: [], raw: '' };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const format = isJsonl(filePath, content) ? 'jsonl' : 'json';

  if (format === 'jsonl') {
    const lines = content.split('\n');
    const entries = [];
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        entries.push({ data: JSON.parse(trimmed), rawIndex: index + 1 });
      } catch (err) {
        console.warn(`[Warning] Unparseable line ${index + 1} in ${filePath}: ${err.message}`);
      }
    });
    return { format, entries, raw: content };
  } else {
    try {
      const parsed = JSON.parse(content);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const entries = items.map((data, index) => ({ data, rawIndex: index + 1 }));
      return { format, entries, raw: content };
    } catch (err) {
      throw new Error(`Failed to parse JSON file ${filePath}: ${err.message}`);
    }
  }
}

/** Check file for duplicate entries */
export function checkDuplicates(filePath, options = {}) {
  const opts = typeof options === 'string' ? { key: options } : options;
  const keyField = opts.key || null;
  const { format, entries } = readEntries(filePath);
  const seen = new Map();
  const duplicates = [];

  entries.forEach((item, index) => {
    const key = getEntryKey(item.data, keyField, opts);
    if (seen.has(key)) {
      duplicates.push({
        index: index + 1,
        rawIndex: item.rawIndex,
        firstSeenIndex: seen.get(key).index,
        firstSeenRawIndex: seen.get(key).rawIndex,
        data: item.data
      });
    } else {
      seen.set(key, { index: index + 1, rawIndex: item.rawIndex, data: item.data });
    }
  });

  return {
    filePath,
    format,
    totalEntries: entries.length,
    uniqueEntries: seen.size,
    duplicateCount: duplicates.length,
    duplicates
  };
}

/** Deduplicate file entries and return remaining entries */
export function dedupeFile(filePath, options = {}) {
  const opts = typeof options === 'string' ? { key: options } : options;
  const keyField = opts.key || null;
  const outputPath = opts.output || filePath;
  const { format, entries } = readEntries(filePath);
  const seen = new Map();
  const cleanData = [];

  entries.forEach((item) => {
    const key = getEntryKey(item.data, keyField, opts);
    if (!seen.has(key)) {
      seen.set(key, true);
      cleanData.push(item.data);
    }
  });

  const removedCount = entries.length - cleanData.length;

  if (format === 'jsonl') {
    const content = cleanData.map((item) => JSON.stringify(item)).join('\n') + (cleanData.length ? '\n' : '');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf8');
  } else {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(cleanData, null, 2) + '\n', 'utf8');
  }

  return {
    filePath,
    outputPath,
    format,
    originalCount: entries.length,
    cleanCount: cleanData.length,
    removedCount
  };
}

/** Add one or more entries to a .json or .jsonl file with duplicate checking */
export function addEntries(filePath, newItems, options = {}) {
  const opts = typeof options === 'string' ? { key: options } : options;
  const keyField = opts.key || null;
  const allowDuplicates = Boolean(opts.allowDuplicates);

  const itemsToAdd = Array.isArray(newItems) ? newItems : [newItems];
  const { format, entries } = readEntries(filePath);
  const existingKeys = new Set(entries.map((e) => getEntryKey(e.data, keyField, opts)));

  const added = [];
  const skipped = [];

  itemsToAdd.forEach((item) => {
    const key = getEntryKey(item, keyField, opts);
    if (existingKeys.has(key) && !allowDuplicates) {
      skipped.push({ data: item, reason: 'Duplicate entry' });
    } else {
      existingKeys.add(key);
      added.push(item);
      entries.push({ data: item, rawIndex: entries.length + 1 });
    }
  });

  if (added.length > 0) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (format === 'jsonl') {
      const newLines = added.map((item) => JSON.stringify(item)).join('\n') + '\n';
      fs.appendFileSync(filePath, newLines, 'utf8');
    } else {
      const allData = entries.map((e) => e.data);
      fs.writeFileSync(filePath, JSON.stringify(allData, null, 2) + '\n', 'utf8');
    }
  }

  return {
    filePath,
    format,
    addedCount: added.length,
    skippedCount: skipped.length,
    totalNow: entries.length,
    added,
    skipped
  };
}

/** Recursively find all .json and .jsonl files in a directory */
export function scanDirectory(dirPath) {
  let results = [];
  if (!fs.existsSync(dirPath)) return results;
  const list = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const dirent of list) {
    const fullPath = path.join(dirPath, dirent.name);
    if (dirent.isDirectory()) {
      if (dirent.name !== 'node_modules' && !dirent.name.startsWith('.')) {
        results = results.concat(scanDirectory(fullPath));
      }
    } else if (dirent.isFile() && (dirent.name.endsWith('.json') || dirent.name.endsWith('.jsonl'))) {
      results.push(fullPath);
    }
  }
  return results;
}

// ── CLI Execution ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  const filePath = args[1];

  const options = {
    key: null,
    output: null,
    allowDuplicates: false,
    ignoreCase: false
  };

  let payload = null;
  if (command === 'add') {
    payload = args[2];
  }

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--key' && args[i + 1]) {
      options.key = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      options.output = args[++i];
    } else if (args[i] === '--allow-duplicates' || args[i] === '--force') {
      options.allowDuplicates = true;
    } else if (args[i] === '--ignore-case' || args[i] === '-i') {
      options.ignoreCase = true;
    }
  }

  return { command, filePath, payload, options };
}

function printUsage() {
  console.log(`
Dataset Manager CLI (.json & .jsonl)

Usage:
  node dataset-manager.mjs check <filePath> [--key <field>] [--ignore-case]
  node dataset-manager.mjs check-dir <dirPath> [--key <field>] [--ignore-case]
  node dataset-manager.mjs dedupe <filePath> [--key <field>] [--output <outPath>] [--ignore-case]
  node dataset-manager.mjs add <filePath> '<json-string-or-file>' [--key <field>] [--allow-duplicates] [--ignore-case]

Examples:
  node dataset-manager.mjs check storage/repair-dataset.jsonl
  node dataset-manager.mjs check storage/repair-sessions.json --key goal
  node dataset-manager.mjs check-dir storage/
  node dataset-manager.mjs dedupe storage/repair-dataset.jsonl
  node dataset-manager.mjs add storage/repair-dataset.jsonl '{"messages":[{"role":"user","content":"help"}]}'
  node dataset-manager.mjs add storage/users.json '[{"id":"u3","username":"charlie"}]' --key id
`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'dataset-manager.mjs') {
  const { command, filePath, payload, options } = parseArgs();

  if (!command || !filePath) {
    printUsage();
    process.exit(1);
  }

  try {
    if (command === 'check') {
      const res = checkDuplicates(filePath, options);
      console.log(`\n🔍 Checked dataset: ${res.filePath} (${res.format.toUpperCase()})`);
      console.log(`   Total entries: ${res.totalEntries}`);
      console.log(`   Unique entries: ${res.uniqueEntries}`);
      console.log(`   Duplicates found: ${res.duplicateCount}`);
      if (res.duplicateCount > 0) {
        console.log('\n   Duplicate details:');
        res.duplicates.slice(0, 10).forEach((d) => {
          console.log(`   - Index ${d.index} is duplicate of first seen at Index ${d.firstSeenIndex}`);
        });
        if (res.duplicateCount > 10) console.log(`   ... and ${res.duplicateCount - 10} more.`);
      } else {
        console.log('   ✔ No duplicates found.');
      }
    } else if (command === 'check-dir') {
      const files = scanDirectory(filePath);
      console.log(`\n📁 Scanning directory for datasets: ${filePath}`);
      console.log(`   Found ${files.length} .json / .jsonl file(s).\n`);
      let totalDups = 0;
      files.forEach((f) => {
        try {
          const res = checkDuplicates(f, options);
          console.log(`  • ${f} (${res.format.toUpperCase()}): ${res.totalEntries} entries, ${res.duplicateCount} duplicate(s)`);
          totalDups += res.duplicateCount;
        } catch (e) {
          console.warn(`  • ${f}: Failed to parse - ${e.message}`);
        }
      });
      console.log(`\n Total duplicates across directory: ${totalDups}`);
    } else if (command === 'dedupe') {
      const res = dedupeFile(filePath, options);
      console.log(`\n🧹 Deduplicated dataset: ${res.filePath}`);
      console.log(`   Format: ${res.format.toUpperCase()}`);
      console.log(`   Original entries: ${res.originalCount}`);
      console.log(`   Clean entries: ${res.cleanCount}`);
      console.log(`   Removed duplicates: ${res.removedCount}`);
      console.log(`   Saved to: ${res.outputPath}`);
    } else if (command === 'add') {
      if (!payload) {
        console.error('Error: Please provide JSON string or input file path to add.');
        process.exit(1);
      }

      let newItems;
      if (fs.existsSync(payload)) {
        const fileContent = fs.readFileSync(payload, 'utf8');
        const isL = isJsonl(payload, fileContent);
        if (isL) {
          newItems = fileContent.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
        } else {
          const parsed = JSON.parse(fileContent);
          newItems = Array.isArray(parsed) ? parsed : [parsed];
        }
      } else {
        const parsed = JSON.parse(payload);
        newItems = Array.isArray(parsed) ? parsed : [parsed];
      }

      const res = addEntries(filePath, newItems, options);
      console.log(`\n➕ Added entries to: ${res.filePath} (${res.format.toUpperCase()})`);
      console.log(`   Added: ${res.addedCount}`);
      console.log(`   Skipped (duplicates): ${res.skippedCount}`);
      console.log(`   Total entries now: ${res.totalNow}`);
    } else {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}
