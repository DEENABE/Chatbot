/**
 * CLI test harness for the autonomous Windows-fix agent — runs the whole
 * loop headless (no Electron, no UI) so you can verify it end-to-end.
 *
 * Usage:
 *   node src/agent/runAgent.cli.js "my wifi keeps disconnecting"
 *   node src/agent/runAgent.cli.js "audio not working" --model qwen2.5 --max 8
 */

import { runAgent } from './agentLoop.js';
import { AGENT_DEFAULT_MODEL } from './agentBrain.js';

function parseArgs(argv) {
  const args = { model: AGENT_DEFAULT_MODEL, maxSteps: 10, goalParts: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') { args.model = argv[++i]; }
    else if (argv[i] === '--max') { args.maxSteps = Number(argv[++i]) || 10; }
    else { args.goalParts.push(argv[i]); }
  }
  args.goal = args.goalParts.join(' ').trim();
  return args;
}

const { goal, model, maxSteps } = parseArgs(process.argv.slice(2));

if (!goal) {
  console.error('Usage: node src/agent/runAgent.cli.js "<describe your PC problem>" [--model qwen2.5] [--max 10]');
  process.exit(1);
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

console.log(c.cyan(`\n🔧 Chanakya-Fix agent  (model: ${model}, max steps: ${maxSteps})`));
console.log(c.dim(`Problem: ${goal}\n`));

function onEvent(event) {
  switch (event.type) {
    case 'thought':
      console.log(c.dim(`💭 ${event.payload.text}`));
      break;
    case 'command':
      console.log(`${c.yellow('▶ RUN')} [${event.payload.level}] ${event.payload.command}`);
      break;
    case 'blocked':
      console.log(c.red(`⛔ BLOCKED: ${event.payload.command}\n   ${event.payload.reason}`));
      break;
    case 'output': {
      const p = event.payload;
      const body = [p.stdout, p.stderr && `stderr: ${p.stderr}`].filter(Boolean).join('\n') || '(no output)';
      console.log(c.dim(`   exit=${p.exitCode}${p.timedOut ? ' TIMEOUT' : ''}\n   ${body.replace(/\n/g, '\n   ')}`));
      break;
    }
    case 'final':
      console.log(c.green(`\n✅ RESULT:\n${event.payload.answer}\n`));
      break;
    case 'error':
      console.log(c.red(`\n❌ ERROR: ${event.payload.message}\n`));
      break;
    case 'aborted':
      console.log(c.red('\n⏹ Aborted.\n'));
      break;
    default:
      break;
  }
}

runAgent({ goal, model, maxSteps, onEvent })
  .then((r) => process.exit(r.stopped === 'aborted' ? 1 : 0))
  .catch((err) => { console.error(c.red(`Fatal: ${err.message}`)); process.exit(1); });
