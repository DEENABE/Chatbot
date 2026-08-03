/**
 * @module agent/agentLoop
 * @description Orchestrates the diagnose → act → observe loop.
 *
 * Each iteration:
 *   1. Ask the brain for the next decision.
 *   2. If done → emit the final answer and stop.
 *   3. Otherwise classify the command's risk.
 *        - 'blocked' → do NOT execute; record it so the brain finds a safer
 *          path or finishes with a manual recommendation.
 *        - 'read' / 'fix' → execute (fully-automatic mode) and feed the
 *          output back to the brain.
 *   4. Repeat until done or maxSteps is reached.
 *
 * Progress is reported through `onEvent` so the caller (HTTP route or CLI)
 * can stream it live.
 */

import { decideNextStep, AGENT_DEFAULT_MODEL } from './agentBrain.js';
import { classifyCommand } from './dangerClassifier.js';
import { runPowerShell } from './powershellRunner.js';

const DEFAULT_MAX_STEPS = 10;

/**
 * @typedef {Object} AgentEvent
 * @property {'thought'|'command'|'output'|'blocked'|'final'|'error'|'aborted'} type
 * @property {*} [payload]
 */

/**
 * Run the autonomous agent to completion.
 *
 * @param {Object} args
 * @param {string} args.goal - The user's problem statement.
 * @param {string} [args.model] - Ollama model id.
 * @param {number} [args.maxSteps]
 * @param {AbortSignal} [args.signal]
 * @param {(event: AgentEvent) => void} args.onEvent - Progress sink.
 * @returns {Promise<{ answer: string, steps: number, stopped: 'done'|'max-steps'|'aborted' }>}
 */
export async function runAgent({
  goal,
  model = AGENT_DEFAULT_MODEL,
  maxSteps = DEFAULT_MAX_STEPS,
  signal,
  onEvent = () => {},
}) {
  const steps = [];

  for (let i = 0; i < maxSteps; i++) {
    if (signal?.aborted) {
      onEvent({ type: 'aborted' });
      return { answer: 'Agent was stopped.', steps: steps.length, stopped: 'aborted' };
    }

    const decision = await decideNextStep({ goal, steps, model, signal });

    if (decision.thought) {
      onEvent({ type: 'thought', payload: { text: decision.thought } });
    }

    if (decision.done || !decision.command) {
      const answer = decision.answer || decision.thought || 'No further action was determined.';
      onEvent({ type: 'final', payload: { answer } });
      return { answer, steps: steps.length, stopped: 'done' };
    }

    const command = decision.command;
    const { level, reason } = classifyCommand(command);
    onEvent({ type: 'command', payload: { command, level, reason } });

    if (level === 'blocked') {
      onEvent({ type: 'blocked', payload: { command, reason } });
      steps.push({ command, blocked: true, reason });
      continue;
    }

    let result;
    try {
      result = await runPowerShell(command, { timeout: 60_000 });
    } catch (error) {
      onEvent({ type: 'error', payload: { message: error.message } });
      steps.push({ command, stdout: '', stderr: error.message, exitCode: null, timedOut: false });
      continue;
    }

    onEvent({
      type: 'output',
      payload: {
        command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    });
    steps.push({ command, ...result });
  }

  // Ran out of steps — ask the brain for a closing recommendation.
  const closing = await decideNextStep({
    goal: `${goal}\n\n(You have reached the step limit. Summarize what you found and give the user a final recommendation.)`,
    steps,
    model,
    signal,
  }).catch(() => null);

  const answer =
    closing?.answer ||
    'Reached the maximum number of steps without a confirmed fix. See the diagnostics above and consider the recommendations.';
  onEvent({ type: 'final', payload: { answer } });
  return { answer, steps: steps.length, stopped: 'max-steps' };
}

export default runAgent;
