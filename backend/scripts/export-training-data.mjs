#!/usr/bin/env node
/**
 * "Data Cleaner" stage: reads the Unified Session DB (repair-sessions.json +
 * automation-sessions.json, merged via RepairLogger), keeps only sessions
 * confirmed working (or resolved with no feedback yet), and writes out THREE
 * separate JSONL files:
 *
 *   storage/repair-dataset.jsonl      (the 6 canonical repair domains)
 *   storage/automation-dataset.jsonl  (the automation domain)
 *   storage/general-dataset.jsonl     (reserved — empty until a general-
 *                                       conversation session log exists)
 *
 * Kept separate rather than one combined file so each category's size and
 * quality can be inspected independently, and so scripts/build-balanced-
 * training.mjs can control their mix explicitly rather than whatever ratio
 * they happened to accumulate in.
 *
 * Usage: node scripts/export-training-data.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportTrainingDataSplit } from '../src/ai/RepairLogger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageDir = path.join(root, 'storage');

function writeJsonl(file, examples) {
  const out = path.join(storageDir, file);
  const content = examples.map((e) => JSON.stringify(e)).join('\n') + (examples.length ? '\n' : '');
  fs.writeFileSync(out, content, 'utf8');
  return out;
}

const { repair, automation, general } = exportTrainingDataSplit();

const repairOut = writeJsonl('repair-dataset.jsonl', repair);
const automationOut = writeJsonl('automation-dataset.jsonl', automation);
const generalOut = writeJsonl('general-dataset.jsonl', general);

console.log('Data Cleaner — exported training examples:');
console.log(`  repair      ${String(repair.length).padStart(5)}  -> ${repairOut}`);
console.log(`  automation  ${String(automation.length).padStart(5)}  -> ${automationOut}`);
console.log(`  general     ${String(general.length).padStart(5)}  -> ${generalOut}${general.length ? '' : '  (empty — no general-conversation sessions logged yet)'}`);
console.log('\nNext: node scripts/build-balanced-training.mjs   (produces the final file train_chanakya.py reads)');
