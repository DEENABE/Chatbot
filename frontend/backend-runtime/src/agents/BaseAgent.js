/**
 * @module agents/BaseAgent
 * @description Shared behaviour for every specialized repair agent. Runs the
 * ReAct loop (think -> run PowerShell -> observe -> repeat) using a domain
 * system prompt assembled from the agent's identity, its repair guide, and the
 * planner's steps. Subclasses only declare their identity and expertise.
 *
 * Reuses the vetted primitives from ../agent: the danger classifier and the
 * headless PowerShell runner.
 */

import { decideNextStep, AGENT_DEFAULT_MODEL } from '../agent/agentBrain.js';
import { classifyCommand } from '../agent/dangerClassifier.js';
import { runPowerShell } from '../agent/powershellRunner.js';

const REACT_CONTRACT = `You diagnose and fix Windows problems by running PowerShell commands ONE at a time.

Every turn reply with ONE JSON object and nothing else:
{
  "thought": "<short reasoning about the current situation and your next move>",
  "command": "<a single PowerShell command, or null>",
  "done": <true or false>,
  "answer": "<final explanation + recommendation, or null>"
}

RULES:
- DIAGNOSE with read-only commands first, understand the root cause, THEN fix.
- Exactly one PowerShell command in "command" (no markdown/backticks/comments).
- When "done" is false, "command" must be non-null and "answer" null.
- When solved or out of safe options, set "done" true, "command" null, write "answer".
- If the system reports a command BLOCKED, do not retry it — find a safer path or finish and recommend the manual step.
- If a command fails with 'Access is denied'/'requires elevation', stop retrying it; finish and recommend running as Administrator (quote the exact command).
- Base every conclusion on real command output. Keep commands non-interactive.`;

export class BaseAgent {
  /**
   * @param {Object} config
   * @param {string} config.domain - Domain key (matches a repair guide).
   * @param {string} config.title - Human-readable agent name.
   * @param {string} config.expertise - One-paragraph description of the agent's focus.
   */
  constructor({ domain, title, expertise }) {
    this.domain = domain;
    this.title = title;
    this.expertise = expertise;
  }

  /**
   * Assemble the full system prompt for this agent.
   * @param {string} knowledge - The domain repair guide.
   * @param {string[]} plan - Planner steps.
   * @returns {string}
   */
  buildSystemPrompt(knowledge, plan) {
    const planText = plan && plan.length
      ? `\n\nSUGGESTED PLAN (adapt based on real output):\n${plan.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : '';
    const guideText = knowledge ? `\n\nDOMAIN REPAIR GUIDE (use these real commands):\n${knowledge}` : '';
    return `You are ${this.title}, a specialist Windows repair agent. ${this.expertise}\n\n${REACT_CONTRACT}${guideText}${planText}`;
  }

  /**
   * Run the agent to completion.
   *
   * @param {Object} args
   * @param {string} args.goal
   * @param {string} [args.knowledge]
   * @param {string[]} [args.plan]
   * @param {string} [args.model]
   * @param {number} [args.maxSteps]
   * @param {AbortSignal} [args.signal]
   * @param {(event: Object) => void} [args.onEvent]
   * @returns {Promise<{ answer: string|null, steps: Array }>}
   */
  async run({ goal, knowledge = '', plan = [], model = AGENT_DEFAULT_MODEL, maxSteps = 8, signal, onEvent = () => {} }) {
    const systemPrompt = this.buildSystemPrompt(knowledge, plan);
    const steps = [];

    for (let i = 0; i < maxSteps; i++) {
      if (signal?.aborted) {
        onEvent({ type: 'aborted' });
        return { answer: 'Repair was stopped.', steps };
      }

      const decision = await decideNextStep({ goal, steps, model, systemPrompt, signal });

      if (decision.thought) {
        onEvent({ type: 'thought', payload: { agent: this.title, text: decision.thought } });
      }

      if (decision.done || !decision.command) {
        return { answer: decision.answer || decision.thought || null, steps };
      }

      const command = decision.command;
      const { level, reason } = classifyCommand(command);
      onEvent({ type: 'command', payload: { agent: this.title, command, level, reason } });

      if (level === 'blocked') {
        onEvent({ type: 'blocked', payload: { agent: this.title, command, reason } });
        steps.push({ command, blocked: true, reason });
        continue;
      }

      let result;
      try {
        result = await runPowerShell(command, { timeout: 60_000 });
      } catch (error) {
        onEvent({ type: 'error', payload: { agent: this.title, message: error.message } });
        steps.push({ command, stdout: '', stderr: error.message, exitCode: null, timedOut: false });
        continue;
      }

      onEvent({
        type: 'output',
        payload: {
          agent: this.title,
          command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr
        }
      });
      steps.push({ command, ...result });
    }

    return { answer: null, steps };
  }
}
