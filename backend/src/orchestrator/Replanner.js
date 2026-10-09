/**
 * @module orchestrator/Replanner
 * @description Generates a revised plan when one or more steps have failed.
 *
 * Strategy:
 * 1. Skip steps that already succeeded (mark as completed in context).
 * 2. Skip the exact step that failed with its known error.
 * 3. Ask the LLM (or use deterministic fallback) to produce alternative steps
 *    that avoid the failure mode.
 *
 * The replanner respects the same ALLOWED_ACTIONS manifest as OrchestratorPlanner,
 * so the LLM cannot hallucinate new tool calls through the retry path.
 */

import { buildTranscript } from './ObservationHandler.js';
import { validateAndNormaliseLLMSteps, ALLOWED_ACTIONS } from './OrchestratorPlanner.js';
import { completeJSON, DEFAULT_MODEL } from '../ai/llmClient.js';

// Build allowed action description text (same as OrchestratorPlanner).
function buildManifestText() {
  return ALLOWED_ACTIONS.map(
    (a, i) =>
      `${i + 1}. tool="${a.tool}" action="${a.action}" — ${a.description}` +
      (a.requiredParams.length ? ` [required params: ${a.requiredParams.join(', ')}]` : ''),
  ).join('\n');
}

const REPLANNER_SYSTEM = `You are a replanning agent for a Windows AI assistant. A previous plan partially failed.
Given the original task, the transcript of what has been done so far (including failures), and the available tools, produce a REVISED plan for only the REMAINING work.

Do NOT repeat steps that already succeeded. Focus only on what still needs to be done.

AVAILABLE ACTIONS:
${buildManifestText()}

Reply with JSON only:
{
  "summary": "<revised goal statement>",
  "steps": [
    {
      "description": "<what this step does>",
      "tool": "<tool name>",
      "action": "<action name>",
      "params": { <params object> }
    }
  ]
}`;

/**
 * Generate a revised plan after one or more steps have failed.
 *
 * @param {Object} args
 * @param {string} args.task           - Original user task
 * @param {import('./AgentState.js').AgentState} args.state  - Current state (with failed steps)
 * @param {string} [args.model]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ summary: string, steps: import('./AgentState.js').PlanStep[] }>}
 */
export async function replan({ task, state, model = DEFAULT_MODEL, signal }) {
  const transcript = buildTranscript(
    state.attempts?.length
      ? state.attempts.map((a) => ({
          ...a.request,
          observation: a.observation,
        }))
      : state.plan,
  );

  // Find which steps already succeeded.
  const completedActions = state.plan
    .filter((s) => s.status === 'done')
    .map((s) => `${s.tool}.${s.action}`)
    .join(', ');

  const failedSteps = state.plan
    .filter((s) => s.status === 'failed')
    .map((s) => {
      const errMsg = s.observation?.error?.message || 'unknown error';
      return `  - ${s.tool}.${s.action}: ${errMsg}`;
    })
    .join('\n');

  try {
    const result = await completeJSON({
      system: REPLANNER_SYSTEM,
      prompt: [
        `ORIGINAL TASK: ${task}`,
        completedActions ? `ALREADY COMPLETED: ${completedActions}` : '',
        failedSteps ? `FAILED STEPS:\n${failedSteps}` : '',
        `\nFULL TRANSCRIPT:\n${transcript}`,
        '\nProduce a revised plan for the remaining work only.',
      ]
        .filter(Boolean)
        .join('\n'),
      model,
      signal,
    });

    const rawSteps = Array.isArray(result.steps) ? result.steps : [];
    const validated = validateAndNormaliseLLMSteps(
      rawSteps,
      state.currentStepIndex,
      state.plan.filter((s) => s.status === 'done'),
      task,
    );

    if (validated.length === 0) {
      // Nothing the LLM suggested is valid — give up gracefully.
      return { summary: 'No valid alternative steps found.', steps: [] };
    }

    return {
      summary: result.summary || `Revised plan for: ${task}`,
      steps: validated,
    };
  } catch {
    return { summary: 'Replanning failed — no alternative found.', steps: [] };
  }
}
