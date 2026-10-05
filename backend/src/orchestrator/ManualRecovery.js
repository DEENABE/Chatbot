import { currentStep, checkpoint } from './AgentState.js';
import { loadResumeController, reconcileCheckpoint } from './CheckpointRecovery.js';
import { claimSession } from './ExecutionSessions.js';
import { reviewToolCall, renewToolConfirmation } from './ToolEngineBridge.js';
import { toolRequestForStep } from './AgentExecutor.js';
import { validateCapability, verificationPredicates } from './CapabilityContracts.js';
import { ExecutionController } from './ExecutionController.js';
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };

/** The API supplies authenticated ownership; the client never supplies a plan. */
export async function reviewCheckpoint({ store, sessionId, userId, expectedRevision, requestId, idempotencyKey, toolCallId, review, reviewCall = reviewToolCall }) {
  const saved=store.load(sessionId,userId);
  const cancelledRepair=saved.state.phase==='cancelled' && saved.state.taskType==='windows_repair_print_spooler_start';
  if(cancelledRepair && saved.revision!==expectedRevision)fail('Checkpoint revision changed; inspect it again.');
  const c = cancelledRepair?new ExecutionController('',{checkpoint:saved,save:store}):loadResumeController(store, sessionId, userId, expectedRevision);
  const lease = claimSession(c);
  try {
    const step = currentStep(c.state);
    if ((!['act','observe'].includes(c.state.phase) && !cancelledRepair) || step?.observation) fail('Only an unresolved attempt can be reviewed.');
    if (requestId !== step.requestId || idempotencyKey !== step.idempotencyKey || toolCallId !== step.toolCallId) fail('Review targets another execution attempt.');
    if (validateCapability(step.tool, step.action, step.params)) fail('Checkpoint capability does not satisfy the current contract.');
    if (review?.disposition === 'completed' && step.tool!=='windowsRepair') {
      const predicate = verificationPredicates[`${step.tool}.${step.action}`];
      if (!review.data || !predicate || !predicate(review.data, step.params)) fail('Submitted completion data does not satisfy the capability predicate.', 400);
    }
    // Write ledger evidence first. A crash before checkpoint save is recovered by normal resume.
    const request=toolRequestForStep(step);
    if(step.tool==='windowsRepair') request.repair={action:step.action,params:step.params,admission:{sessionId:c.state.sessionId,revision:c.state.revision,taskType:c.state.taskType}};
    const evidence = await reviewCall(request, review, userId);
    // Reconcile the side-effect ledger without reopening a cancelled execution.
    if(cancelledRepair)return {...checkpoint(c.state),reconciliation:evidence.reconciliation};
    await reconcileCheckpoint(c, async () => evidence);
    return checkpoint(c.state); // Explicit resume is a separate request; this never dispatches work.
  } finally { lease.release(); }
}

export async function renewCheckpointConfirmation({ store, sessionId, userId, expectedRevision, renewalId, renew = renewToolConfirmation }) {
  const c = loadResumeController(store, sessionId, userId, expectedRevision);
  const lease = claimSession(c);
  try {
    if (c.state.phase !== 'waiting_confirmation') fail('Checkpoint is not waiting for confirmation.');
    const renewal = await renew(currentStep(c.state).observation.confirmationId, renewalId, userId);
    c.renewConfirmation(renewal);
    return checkpoint(c.state);
  } finally { lease.release(); }
}
