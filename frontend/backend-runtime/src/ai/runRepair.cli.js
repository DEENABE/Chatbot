/**
 * CLI harness for the enterprise multi-agent repair pipeline.
 *
 * Usage:
 *   node src/ai/runRepair.cli.js "my bluetooth is off, turn it on"
 *   node src/ai/runRepair.cli.js "internet is slow" --model qwen3 --max 8
 */

import { runRepair } from './Orchestrator.js';
import { DEFAULT_MODEL } from './llmClient.js';

function parseArgs(argv) {
  const args = { model: DEFAULT_MODEL, maxSteps: 8, parts: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--max') args.maxSteps = Number(argv[++i]) || 8;
    else args.parts.push(argv[i]);
  }
  args.goal = args.parts.join(' ').trim();
  return args;
}

const { goal, model, maxSteps } = parseArgs(process.argv.slice(2));
if (!goal) {
  console.error('Usage: node src/ai/runRepair.cli.js "<problem>" [--model qwen3] [--max 8]');
  process.exit(1);
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  mag: (s) => `\x1b[35m${s}\x1b[0m`
};

console.log(c.cyan(`\n🏢 Chanakya Enterprise Repair  (model: ${model})`));
console.log(c.dim(`Problem: ${goal}\n`));

function onEvent(event) {
  const p = event.payload || {};
  switch (event.type) {
    case 'intent':
      console.log(c.mag(`🧭 Domain: ${p.domain}  (confidence ${p.confidence})  ${c.dim(p.reason || '')}`));
      break;
    case 'plan':
      console.log(c.mag(`📋 Plan: ${p.summary}`));
      (p.steps || []).forEach((s, i) => console.log(c.dim(`   ${i + 1}. ${s}`)));
      break;
    case 'agent':
      console.log(c.cyan(`🤖 Handing off to: ${p.name}\n`));
      break;
    case 'thought':
      console.log(c.dim(`💭 ${p.text}`));
      break;
    case 'command':
      console.log(`${c.yellow('▶ RUN')} [${p.level}] ${p.command}`);
      break;
    case 'blocked':
      console.log(c.red(`⛔ BLOCKED: ${p.command}\n   ${p.reason}`));
      break;
    case 'output': {
      const body = [p.stdout, p.stderr && `stderr: ${p.stderr}`].filter(Boolean).join('\n') || '(no output)';
      console.log(c.dim(`   exit=${p.exitCode}${p.timedOut ? ' TIMEOUT' : ''}\n   ${body.replace(/\n/g, '\n   ')}`));
      break;
    }
    case 'final':
      console.log((p.resolved ? c.green : c.yellow)(`\n${p.resolved ? '✅ RESOLVED' : '⚠️  NOT FULLY RESOLVED'}\n${p.answer}`));
      if (p.recommendation) console.log(c.yellow(`\n👉 Recommendation: ${p.recommendation}`));
      console.log('');
      break;
    case 'error':
      console.log(c.red(`\n❌ ERROR: ${p.message}\n`));
      break;
    default:
      break;
  }
}

runRepair({ goal, model, maxSteps, onEvent })
  .then(() => process.exit(0))
  .catch((err) => { console.error(c.red(`Fatal: ${err.message}`)); process.exit(1); });
