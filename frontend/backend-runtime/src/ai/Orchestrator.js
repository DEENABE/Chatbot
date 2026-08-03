/**
 * @module ai/Orchestrator
 * @description The enterprise repair pipeline. Ties the whole system together:
 *
 *   problem
 *     -> IntentClassifier   (which domain?)
 *     -> knowledge.loadGuide (domain repair guide as RAG context)
 *     -> Planner            (short ordered plan)
 *     -> specialized Agent  (ReAct diagnose/fix loop)
 *     -> ResultAnalyzer     (resolved? + user-facing recommendation)
 *
 * Every stage streams a typed event through `onEvent` so the UI can show the
 * whole reasoning process live.
 */

import { classifyIntent } from './IntentClassifier.js';
import { createPlan } from './Planner.js';
import { analyzeOutcome } from './ResultAnalyzer.js';
import { loadGuide } from '../knowledge/index.js';
import { getAgent } from '../agents/AgentRegistry.js';
import { DEFAULT_MODEL } from './llmClient.js';
import { logSession } from './RepairLogger.js';

/**
 * Run the full repair pipeline for a problem.
 *
 * @param {Object} args
 * @param {string} args.goal - The user's problem statement.
 * @param {string} [args.model]
 * @param {number} [args.maxSteps]
 * @param {AbortSignal} [args.signal]
 * @param {(event: Object) => void} args.onEvent
 * @returns {Promise<{ domain: string, resolved: boolean, summary: string, recommendation: string }>}
 */
export async function runRepair({ goal, model = DEFAULT_MODEL, maxSteps = 8, signal, onEvent = () => {} }) {
  // 1. Classify the problem into a domain.
  const intent = await classifyIntent(goal, { model, signal });
  onEvent({ type: 'intent', payload: { domain: intent.domain, confidence: intent.confidence, reason: intent.reason } });

  // 2. Load the domain repair guide (RAG context).
  const knowledge = loadGuide(intent.domain);

  // 3. Build a short plan grounded in that guide.
  const plan = await createPlan({ goal, domain: intent.domain, knowledge, model, signal });
  onEvent({ type: 'plan', payload: { summary: plan.summary, steps: plan.steps } });

  // 4. Hand off to the specialized agent.
  const agent = getAgent(intent.domain);
  onEvent({ type: 'agent', payload: { name: agent.title, domain: intent.domain } });

  const { answer, steps } = await agent.run({
    goal,
    knowledge,
    plan: plan.steps,
    model,
    maxSteps,
    signal,
    onEvent
  });

  // 5. Verify the outcome and produce the final verdict.
  const verdict = await analyzeOutcome({ goal, steps, agentAnswer: answer, model, signal });

  // 6. Log the session so the system can learn from it (few-shot / fine-tuning).
  const sessionId = logSession({
    goal,
    domain: intent.domain,
    plan: plan.steps,
    steps,
    resolved: verdict.resolved,
    summary: verdict.summary,
    recommendation: verdict.recommendation
  });

  onEvent({
    type: 'final',
    payload: {
      sessionId,
      domain: intent.domain,
      agent: agent.title,
      resolved: verdict.resolved,
      answer: verdict.summary,
      recommendation: verdict.recommendation
    }
  });

  return { sessionId, domain: intent.domain, resolved: verdict.resolved, summary: verdict.summary, recommendation: verdict.recommendation };
}
