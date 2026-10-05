import { ExecutionController } from './ExecutionController.js';
import { currentStep, isTerminalState, updateCurrentStep } from './AgentState.js';
import { normaliseObservation } from './ObservationHandler.js';
import { inspectToolCall } from './ToolEngineBridge.js';
const conflict = message => Object.assign(new Error(message), { status: 409 });

export function loadResumeController(store, id, ownerId, expectedRevision, onEvent) {
  const value = store.load(id, ownerId);
  if (!Number.isInteger(expectedRevision) || value.revision !== expectedRevision) throw conflict('Checkpoint revision changed; inspect it again.');
  const c = new ExecutionController('', { checkpoint: value, save: store, onEvent });
  if (isTerminalState(c.state)) throw conflict('Terminal executions cannot be resumed.');
  if (c.state.mode !== 'orchestrator') throw conflict('This execution mode does not support checkpoint replay.');
  return c;
}

/** Consume durable evidence only. Never issue a tool call during reconciliation. */
export async function reconcileCheckpoint(c, inspect = inspectToolCall) {
  if (!['act','observe'].includes(c.state.phase)) return;
  const step = currentStep(c.state);
  if (c.state.phase === 'observe' && step?.observation) {
    c.move('decide');
    if (step.observation.reconciliation?.disposition === 'abandon') c.stop('cancelled', 'Abandoned after manual review.');
    return;
  }
  if (!step?.idempotencyKey || !step.requestId) throw conflict('Checkpoint lacks durable execution identity.');
  const evidence = await inspect(step.idempotencyKey, c.state.ownerId);
  if (evidence.status !== 'completed') throw conflict(`Execution ${evidence.status || 'unknown'}; manual reconciliation is required before any further work.`);
  if (evidence.requestId !== step.requestId || evidence.toolCallId !== step.toolCallId || evidence.idempotencyKey !== step.idempotencyKey) throw conflict('Execution evidence identity does not match.');
  const result = evidence.result;
  if (!result || result.requestId !== step.requestId || result.toolCallId !== step.toolCallId || result.idempotencyKey !== step.idempotencyKey) throw conflict('Result identity does not match.');
  if (c.state.phase === 'act') c.move('observe');
  const observation = { ...normaliseObservation(result, step.index, step.toolCallId), requestId: step.requestId, idempotencyKey: step.idempotencyKey,
    ...(evidence.reconciliation ? { reconciliation: evidence.reconciliation } : {}) };
  c.commit(updateCurrentStep(c.state, observation.needsConfirmation ? 'confirmation_required' : observation.success ? 'done' : 'failed', observation));
  c.move('decide');
  if (observation.reconciliation?.disposition === 'abandon') c.stop('cancelled', 'Abandoned after manual review.');
}
