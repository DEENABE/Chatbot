import {computerTask} from './ComputerTaskPolicy.js';
import {applicationGoalVerdict} from './ApplicationGoal.js';
import {genericDesktopTask,desktopCompletion} from './GenericDesktopTask.js';
import {compoundAppTask} from './ComputerTaskPolicy.js';
/**
 * @module orchestrator/Verifier
 * @description After all plan steps have been executed, the Verifier asks the
 * LLM to review the full transcript and confirm whether the user's original
 * task was actually accomplished.
 *
 * Returns a Verdict:
 *   { success: boolean, summary: string, recommendation: string }
 *
 * Falls back to a heuristic verdict (based on step statuses) if the LLM is
 * unreachable, so the orchestrator always produces a verdict.
 */

import { completeJSON, DEFAULT_MODEL } from '../ai/llmClient.js';
import { buildTranscript } from './ObservationHandler.js';
import { verifyCapabilities } from './CapabilityContracts.js';

const VERIFIER_SYSTEM = `You are a QA reviewer for an AI assistant that executes multi-step tasks on Windows.
Given the user's original task and a transcript of every step that was executed (with results), decide whether the task was SUCCESSFULLY completed.
Base your verdict only on the actual step results, not on assumptions.

Reply with JSON only:
{"success": true|false, "summary": "<what was accomplished, 1-3 sentences>", "recommendation": "<clear next step for the user; empty string if fully done>"}`;

/**
 * Verify that the task was accomplished by reviewing the execution transcript.
 *
 * @param {Object} args
 * @param {string} args.task             - Original user task
 * @param {import('./AgentState.js').PlanStep[]} args.steps  - Executed plan steps
 * @param {string} [args.model]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<import('./AgentState.js').Verdict>}
 */
export async function verifyOutcome({ task, steps, attempts = [], model = DEFAULT_MODEL, signal }) {
  if(computerTask(task)?.genericDesktop)return {success:steps.length>0&&steps.every(s=>s.status==='done')&&desktopCompletion(steps.at(-1)?.observation?.data,task),summary:'Generic desktop completion requires fresh goal evidence.',recommendation:''};
  const goal=compoundAppTask(task);
  if(goal){const verdict=applicationGoalVerdict(goal,steps);const checked=verifyCapabilities(steps);return {...verdict,success:verdict.success && checked?.success===true};}
  if(steps.length===1 && ['uiAutomation','browser'].includes(steps[0].tool)) {
    const checked=verifyCapabilities(steps);return {success:checked?.success===true,summary:checked?.success ? steps[0].observation.data.message : steps[0].observation?.error?.message || 'UI action could not be verified.',recommendation:''};
  }
  if (steps.length === 1 && steps[0].tool === 'app' && steps[0].action === 'openApp') {
    const checked=verifyCapabilities(steps), data=steps[0].observation?.data;
    return {success:checked?.success===true,summary:checked?.success ? `${data.app.name} opened successfully.` : data?.message || steps[0].observation?.error?.message || 'Application launch could not be verified.',recommendation:''};
  }
  const deterministic = verifyCapabilities(steps);
  if (deterministic) return deterministic;
  const transcript = buildTranscript(attempts.length ? attempts.map(a => ({ ...a.request, observation: a.observation })) : steps);

  // If all steps succeeded, we can produce a heuristic verdict immediately.
  const allSucceeded = steps.length > 0 && steps.every((s) => s.status === 'done');
  const anySucceeded = steps.some((s) => s.status === 'done');

  try {
    const result = await completeJSON({
      system: VERIFIER_SYSTEM,
      prompt: `USER TASK:\n${task}\n\nEXECUTION TRANSCRIPT:\n${transcript}\n\nGive your verdict.`,
      model,
      signal,
    });

    return {
      success: allSucceeded && result.success === true,
      summary: result.summary || heuristicSummary(steps, task),
      recommendation: result.recommendation || '',
    };
  } catch {
    // LLM unavailable — fall back to heuristic.
    return heuristicVerdict(steps, task);
  }
}

/**
 * Heuristic verdict based purely on step statuses (no LLM required).
 *
 * @param {import('./AgentState.js').PlanStep[]} steps
 * @param {string} task
 * @returns {import('./AgentState.js').Verdict}
 */
function heuristicVerdict(steps, task) {
  if (!steps.length) {
    return {
      success: false,
      summary: 'No steps were executed.',
      recommendation: 'Check that the ToolEngine bridge is running and retry.',
    };
  }

  const doneCount = steps.filter((s) => s.status === 'done').length;
  const failedCount = steps.filter((s) => s.status === 'failed').length;
  const blockedCount = steps.filter((s) => s.status === 'blocked').length;

  if (doneCount === steps.length) {
    return {
      success: false,
      summary: heuristicSummary(steps, task),
      recommendation: 'Tool calls completed, but the task outcome could not be verified.',
    };
  }

  if (doneCount > 0 && failedCount > 0) {
    return {
      success: false,
      summary: `${doneCount} of ${steps.length} steps completed. ${failedCount} step(s) failed.`,
      recommendation: 'Some steps could not be completed. Review the errors above.',
    };
  }

  return {
    success: false,
    summary: `Task could not be completed: ${failedCount} step(s) failed, ${blockedCount} step(s) blocked.`,
    recommendation: 'Review the errors above and try again.',
  };
}

/**
 * Build a plain-text summary from step data without LLM.
 *
 * @param {import('./AgentState.js').PlanStep[]} steps
 * @param {string} task
 * @returns {string}
 */
function heuristicSummary(steps, task) {
  const actionList = steps
    .filter((s) => s.status === 'done')
    .map((s) => `${s.tool}.${s.action}`)
    .join(', ');

  return actionList
    ? `Executed: ${actionList}. Tool execution completed; task outcome requires review.`
    : `Task "${task.slice(0, 80)}" — no steps completed.`;
}
