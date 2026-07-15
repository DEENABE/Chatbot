/**
 * @module ai/ResultAnalyzer
 * @description Reviews everything an agent did and decides whether the problem
 * is actually resolved, then writes the user-facing verdict + recommendation.
 */

import { completeJSON, DEFAULT_MODEL } from './llmClient.js';

const SYSTEM = `You are a QA reviewer for a Windows self-repair assistant. Given the problem and the full transcript of commands + outputs, decide whether the problem is RESOLVED. Base your judgement only on the command outputs, not assumptions.
Reply with JSON only:
{"resolved": true|false, "summary": "<what was found/done, 1-3 sentences>", "recommendation": "<clear next step for the user; empty string if fully resolved>"}`;

function renderTranscript(steps) {
  if (!steps.length) return '(no commands were run)';
  return steps
    .map((step, i) => {
      if (step.blocked) {
        return `STEP ${i + 1}\nCommand: ${step.command}\nResult: BLOCKED (${step.reason}) — not executed`;
      }
      const out = [step.stdout, step.stderr && `STDERR: ${step.stderr}`].filter(Boolean).join('\n') || '(no output)';
      return `STEP ${i + 1}\nCommand: ${step.command}\nExit: ${step.exitCode}\nOutput:\n${out}`;
    })
    .join('\n\n');
}

/**
 * Analyze the outcome of a repair session.
 *
 * @param {Object} args
 * @param {string} args.goal
 * @param {Array} args.steps - The agent's executed steps.
 * @param {string} [args.agentAnswer] - The agent's own closing answer, if any.
 * @param {string} [args.model]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ resolved: boolean, summary: string, recommendation: string }>}
 */
export async function analyzeOutcome({ goal, steps = [], agentAnswer = '', model = DEFAULT_MODEL, signal }) {
  try {
    const result = await completeJSON({
      system: SYSTEM,
      prompt: `PROBLEM:\n${goal}\n\nAGENT'S CLOSING NOTE:\n${agentAnswer || '(none)'}\n\nTRANSCRIPT:\n${renderTranscript(steps)}\n\nGive your verdict.`,
      model,
      signal
    });
    return {
      resolved: Boolean(result.resolved),
      summary: result.summary || agentAnswer || 'Diagnosis complete.',
      recommendation: result.recommendation || ''
    };
  } catch {
    return {
      resolved: false,
      summary: agentAnswer || 'Diagnosis complete, but the outcome could not be verified.',
      recommendation: 'Review the steps above and consider running the app as Administrator for deeper fixes.'
    };
  }
}
