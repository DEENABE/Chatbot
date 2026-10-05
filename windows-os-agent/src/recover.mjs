import readline from 'node:readline/promises';
import path from 'node:path';
import { root } from './config.mjs';
import { Journal } from './journal.mjs';
import { acquireInstance } from './instance.mjs';

const release = await acquireInstance(path.join(root, 'var'));
try {
const journal = new Journal(path.join(root, 'var'));
if (!journal.writesBlocked) { console.log('No interrupted or unknown writes in the journal.'); await release(); process.exit(0); }
console.log('Stop the server and all of its workers first. Inspect the affected setting before clearing a record.');
console.log(JSON.stringify([...journal.uncertain.values()], null, 2));
const id = process.argv[2];
if (!id) { console.log('Usage: npm run recover -- EXECUTION_UUID'); process.exit(0); }
if (!journal.uncertain.has(id)) throw new Error('Execution UUID not found');
const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await prompt.question('Confirm server/workers stopped and state inspected. Type INSPECTED to acknowledge: ');
prompt.close();
if (answer !== 'INSPECTED') { console.log('Recovery record unchanged.'); process.exit(0); }
journal.append({ event: 'operator_recovery', executionId: id });
console.log('Operator inspection recorded. Restart the server after all uncertain executions are reviewed.');
} finally { await release(); }
