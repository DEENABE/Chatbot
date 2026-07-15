/**
 * @module ai/Planner
 * @description Produces a short, ordered diagnostic/repair plan for a problem,
 * grounded in the domain's repair guide. The plan is advisory — it steers the
 * agent's first moves but the agent still adapts based on real command output.
 */

import { completeJSON, DEFAULT_MODEL } from './llmClient.js';

const SYSTEM = `You are a senior Windows support engineer. Given a problem and a domain repair guide, produce a SHORT ordered plan (2-5 steps) to diagnose and, if possible, fix it. Always diagnose before changing anything.
Reply with JSON only: {"steps": ["step 1", "step 2", ...], "summary": "<one sentence goal>"}`;

/**
 * Build a repair plan.
 *
 * @param {Object} args
 * @param {string} args.goal - The user's problem.
 * @param {string} args.domain - The classified domain.
 * @param {string} [args.knowledge] - Domain repair guide text.
 * @param {string} [args.model]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ steps: string[], summary: string }>}
 */
export async function createPlan({ goal, domain, knowledge = '', model = DEFAULT_MODEL, signal }) {
  try {
    const result = await completeJSON({
      system: SYSTEM,
      prompt: `DOMAIN: ${domain}\n\nREPAIR GUIDE:\n${knowledge || '(none)'}\n\nPROBLEM:\n${goal}\n\nProduce the plan.`,
      model,
      signal
    });
    const steps = Array.isArray(result.steps) ? result.steps.filter((s) => typeof s === 'string') : [];
    return {
      steps: steps.slice(0, 6),
      summary: result.summary || `Diagnose and resolve: ${goal}`
    };
  } catch {
    // A missing plan is non-fatal; the agent can still work from the guide.
    return { steps: [], summary: `Diagnose and resolve: ${goal}` };
  }
}
