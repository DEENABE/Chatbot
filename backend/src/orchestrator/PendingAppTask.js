import { computerTask } from './ComputerTaskPolicy.js';
import { currentStep } from './AgentState.js';
// Continuation state for "which application do you mean?". While an execution is in `awaiting_app_choice` this record is
// everything needed to carry on: the question, the options, the exact step that is paused and what comes after it.
// The answer is applied to that step by candidate id; nothing here is ever sent back through chat or a model.
const text = (value) =>
  String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));
/** What the user asked for, in structured form (no application names are interpreted here). */
export function describeIntent(task) {
  const parsed = computerTask(task);
  if (!parsed) return { kind: 'unknown' };
  if (parsed.genericDesktop)
    return {
      kind: 'desktop_goal',
      app: parsed.genericDesktop.query,
      goal: parsed.genericDesktop.goal,
    };
  if (parsed.compound)
    return {
      kind: 'open_with_target',
      app: parsed.compound.app,
      target: parsed.compound.query,
    };
  if (parsed.call?.tool === 'browser') {
    const { browser, ...params } = parsed.call.params || {};
    return {
      kind: 'browser',
      action: parsed.call.action,
      app: browser || null,
      params,
    };
  }
  if (parsed.call)
    return {
      kind: 'tool_call',
      tool: parsed.call.tool,
      action: parsed.call.action,
      app: parsed.call.params?.query || null,
    };
  return { kind: 'computer_task' };
}
/**
 * What still has to happen once the application is known. `via: "awaiting_step"` actions are part of the paused call and run
 * when it is re-run with the picked application; `via: "follow_up"` actions are carried on by the execution loop afterwards.
 */
export function remainingActions(intent, state) {
  const awaiting = state.currentStepIndex;
  const actions = [];
  if (intent.kind === 'browser' && intent.action === 'navigate')
    actions.push({
      type: 'navigate',
      url: intent.params.url,
      via: 'awaiting_step',
    });
  else if (intent.kind === 'browser' && intent.action === 'search')
    actions.push({
      type: 'search',
      query: intent.params.query,
      via: 'awaiting_step',
    });
  else if (intent.kind === 'open_with_target')
    actions.push({
      type: 'open_target',
      target: intent.target,
      via: 'awaiting_step',
    });
  else if (intent.kind === 'desktop_goal')
    actions.push({ type: 'desktop_goal', goal: intent.goal, via: 'follow_up' });
  for (const step of state.plan.slice(awaiting + 1))
    if (step.status !== 'done')
      actions.push({
        type: 'planned_step',
        tool: step.tool,
        action: step.action,
        via: 'follow_up',
      });
  return actions;
}
/** The persisted pending task for a step whose observation asks the user to choose an application. */
export function buildPendingAppTask(state, observation) {
  const step = currentStep(state);
  const intent = describeIntent(state.task);
  return plain({
    schemaVersion: 1,
    taskId: state.sessionId,
    correlationId: step.requestId || step.toolCallId,
    phase: 'awaiting_app_choice',
    originalQuery: state.task,
    intent,
    requestedApp: observation.requestedApp,
    candidates: observation.candidates || [],
    choiceId: observation.choiceId,
    expiresAt: observation.choiceExpiresAt,
    awaitingStep: {
      index: step.index,
      toolCallId: step.toolCallId,
      tool: step.tool,
      action: step.action,
      params: step.params,
    },
    remainingActions: remainingActions(intent, state),
    createdAt: new Date().toISOString(),
  });
}
/**
 * A typed reply that is exactly one offered application's name (or its list position) answers the pending choice instead of
 * starting a new chat request. Exact comparison against the offered candidates only: no fuzzy matching, and an ambiguous
 * name (two offered candidates with it) is not an answer.
 */
export function matchTypedChoice(message, pendingTask) {
  const candidates = pendingTask?.candidates;
  const reply = text(message);
  if (!reply || !Array.isArray(candidates) || !candidates.length) return null;
  if (/^\d{1,2}$/.test(reply)) return candidates[Number(reply) - 1] || null;
  const hits = candidates.filter(
    (c) => text(c.displayName) === reply || text(c.canonicalName) === reply,
  );
  return hits.length === 1 ? hits[0] : null;
}
/** One line for the chooser: what the user asked and what happens after they answer. */
export function describePendingTask(task) {
  const after = (task?.remainingActions || [])
    .map((a) =>
      a.type === 'navigate'
        ? `go to ${a.url}`
        : a.type === 'search'
          ? `search for ${a.query}`
          : a.type === 'open_target'
            ? `open ${a.target}`
            : a.type === 'desktop_goal'
              ? a.goal
              : null,
    )
    .filter(Boolean);
  return after.length ? `Then: ${after.join(', then ')}.` : '';
}
