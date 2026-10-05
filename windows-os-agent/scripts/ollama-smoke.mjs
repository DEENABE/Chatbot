import { runAgent } from '../src/agent.mjs';
import { Executor } from '../src/executor.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../src/config.mjs';

const config = { ollamaUrl: 'http://127.0.0.1:11434', model: process.env.OLLAMA_MODEL || 'qwen3.5:9b', think: false, ollamaTimeout: 120000, toolTimeout: 30000, maxSteps: 4, autoLow: false, uia: false };
const started = Date.now();
let report;
try {
  const result = await runAgent({
    session: { id: 'read-only-smoke', messages: [] },
    message: 'Use system.inspect to report the Windows build and whether this process is administrator. Do not change anything.',
    allowChanges: false, executor: new Executor(config), config
  });
  const observed = result.events.some(e => e.arguments?.operation === 'system.inspect' && e.result.ok);
  report = { ok: observed, model: config.model, answer: result.answer, events: result.events.map(e => ({ tool: e.tool, operation: e.arguments?.operation, ok: e.result.ok, error: e.result.error })), elapsedMs: Date.now() - started };
} catch (error) { report = { ok: false, model: config.model, error: error.message, elapsedMs: Date.now() - started }; }
await mkdir(path.join(root, 'var'), { recursive: true });
await writeFile(path.join(root, 'var', 'ollama-smoke.json'), JSON.stringify({ created: new Date().toISOString(), ...report }, null, 2));
console.log(JSON.stringify(report));
process.exitCode = report.ok ? 0 : 1;
