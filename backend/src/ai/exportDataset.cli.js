/**
 * Export logged repair sessions as a fine-tuning dataset (JSONL, chat format).
 * Only sessions the user marked "worked" (or that resolved with no feedback)
 * are included — these are the good trajectories worth learning from.
 *
 * Usage:
 *   node src/ai/exportDataset.cli.js                 # writes storage/repair-dataset.jsonl
 *   node src/ai/exportDataset.cli.js path\to\out.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';
import { exportTrainingData, getSessions } from './RepairLogger.js';
import { config } from '../config.js';

const outPath = process.argv[2] || path.join(path.dirname(config.dbFile), 'repair-dataset.jsonl');
const examples = exportTrainingData();
const total = getSessions().length;

if (!examples.length) {
  console.log(`No good sessions to export yet (of ${total} logged). Run some repairs and mark them 👍 first.`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, examples.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

console.log(`Exported ${examples.length} training examples (of ${total} logged sessions) to:\n${outPath}`);
console.log('\nNext steps to fine-tune:');
console.log('  1. Collect more examples (aim for a few hundred).');
console.log('  2. Train a LoRA on Qwen2.5 with Unsloth (needs an NVIDIA GPU or Colab).');
console.log('  3. Export to GGUF, then: ollama create chanakya-repair -f Modelfile');
console.log('  4. Set AGENT_MODEL=chanakya-repair');
