import { executeChatCall, executeCancellableTool } from './chatExecution.js';
import { matchTypedChoice } from '../../../backend/src/orchestrator/PendingAppTask.js';

// "Which application do you mean?" is continuation state of the paused execution, not a new chat request. The question
// is an observation (needsAppChoice) that parks the execution in `awaiting_app_choice` with its pending task persisted;
// the answer goes to the tool engine as a candidate id and resumes that same step. No model, no fuzzy matching.

/** The store entry for an execution that is waiting for the user to pick an application. */
export function appChoiceEntry(observation, { execution, tools, messageId, remainingCalls = [] }) {
  return {
    choiceId: observation.choiceId,
    requestedApp: observation.requestedApp,
    candidates: observation.candidates,
    message: observation.choiceMessage,
    expiresAt: observation.choiceExpiresAt,
    pendingTask: execution.state.pendingTask,
    messageId,
    execution,
    tools,
    remainingCalls,
    resolving: false,
    error: null,
  };
}

/**
 * Answers the open question: the engine re-runs the paused call with that candidate bound and returns its observation
 * (which may be a fresh question when the candidate went stale). If the engine no longer knows the question, the original
 * call is run again so the user is asked a fresh one; nothing is launched without an answer to a live question.
 */
export async function resumeWithChoice(choice, candidateId, { engine, signal }) {
  const { execution, tools = [] } = choice;
  const transport = (tool, action, params, toolCallId, identity) =>
    executeCancellableTool(engine, tool, action, params, toolCallId, identity);
  let observation = await execution.execute(
    (step) =>
      executeCancellableTool(
        engine,
        '_system',
        'chooseApp',
        { choiceId: choice.choiceId, candidateId },
        step.toolCallId,
        { ...step, signal },
      ),
    { choiceId: choice.choiceId, candidateId, signal },
  );
  if (observation?.error?.code === 'APP_CHOICE_EXPIRED' && !execution.stopped) {
    const { tool, action, params } = execution.state.pendingTask.awaitingStep;
    observation = await executeChatCall(
      execution,
      {
        id: globalThis.crypto.randomUUID(),
        type: 'function',
        function: { name: `${tool}_${action}`, arguments: params },
      },
      tools,
      transport,
      signal,
    );
  }
  return observation;
}

/** A typed reply that exactly names an offered application answers the oldest open question. Anything else does not. */
export function matchTypedAppChoice(message, choices) {
  const choice = choices?.[0];
  const candidate = choice && matchTypedChoice(message, choice.pendingTask);
  return candidate ? { choice, candidate } : null;
}
