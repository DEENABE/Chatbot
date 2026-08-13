#!/usr/bin/env node
/**
 * "Balanced Training" stage: combines repair-dataset.jsonl +
 * automation-dataset.jsonl + general-dataset.jsonl into one shuffled file,
 * capping/oversampling each category so no single category dominates the
 * fine-tune purely because it happens to have the most logged sessions.
 *
 * Without this, repair (1000+ examples) would drown out automation (a few
 * dozen) — the model would barely learn the automation persona at all.
 *
 * Rule: let floor = size of the smallest non-empty category. Every non-empty
 * category is resampled to floor * RATIO — categories below that are
 * oversampled (repeated + shuffled), categories above it are randomly
 * downsampled. RATIO bounds both how many times a small category's examples
 * repeat and how dominant the largest category can be (default 4, i.e. at
 * most 4x duplication for the smallest set, and every category ends up
 * within a 1:1 ratio of each other since they all land at the same size).
 *
 * Usage: node scripts/build-balanced-training.mjs [--ratio 4] [--out storage/training.jsonl]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageDir = path.join(root, 'storage');

const args = process.argv.slice(2);
const ratioIdx = args.indexOf('--ratio');
const RATIO = ratioIdx !== -1 ? Number(args[ratioIdx + 1]) : 4;
const outIdx = args.indexOf('--out');
const outPath = outIdx !== -1 ? args[outIdx + 1] : path.join(storageDir, 'training.jsonl');

function readJsonl(file) {
  const p = path.join(storageDir, file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Resample `items` to exactly `target` size: downsample if larger, oversample (repeat) if smaller. */
function resampleTo(items, target) {
  if (items.length === 0 || target <= 0) return [];
  if (items.length >= target) return shuffle(items).slice(0, target);
  const out = [];
  while (out.length < target) {
    out.push(...shuffle(items));
  }
  return out.slice(0, target);
}

const categories = {
  repair: readJsonl('repair-dataset.jsonl'),
  automation: readJsonl('automation-dataset.jsonl'),
  general: readJsonl('general-dataset.jsonl'),
};

const nonEmpty = Object.entries(categories).filter(([, items]) => items.length > 0);
if (!nonEmpty.length) {
  console.error('No training data found. Run scripts/export-training-data.mjs first.');
  process.exit(1);
}

const floor = Math.min(...nonEmpty.map(([, items]) => items.length));
const target = floor * RATIO;

console.log(`Balanced training build — ratio ${RATIO}x, target size per category: ${target}`);
console.log();

let combined = [];
for (const [name, items] of nonEmpty) {
  const resampled = resampleTo(items, target);
  const direction = items.length === resampled.length ? 'kept' : items.length < resampled.length ? 'oversampled' : 'downsampled';
  console.log(`  ${name.padEnd(11)} ${String(items.length).padStart(5)} -> ${String(resampled.length).padStart(5)}  (${direction})`);
  combined.push(...resampled);
}

combined = shuffle(combined);
fs.writeFileSync(outPath, combined.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

console.log();
console.log(`Wrote ${combined.length} examples to ${outPath}`);
console.log('Point finetune/train_chanakya.py\'s DATASET_PATH at this file.');
