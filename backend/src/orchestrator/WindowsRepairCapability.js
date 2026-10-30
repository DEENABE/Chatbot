import { ExecutionController } from './ExecutionController.js';
import { currentStep } from './AgentState.js';
import { createCheckpointStore } from './CheckpointStore.js';
import { claimSession } from './ExecutionSessions.js';
import { executeStep } from './AgentExecutor.js';
import { LIMITS, verified } from './WindowsRepairContract.js';
import { logTypedRepair } from '../ai/RepairLogger.js';
export const REPAIR_TASK = 'windows_repair_print_spooler_start';
export const isSpoolerIntent = (task) => /\b(spooler|printer|printing|print service)\b/i.test(task);
const plan = (action, params = {}) => [
  { tool: 'windowsRepair', action, params, description: action },
];
function result(c) {
  const step = currentStep(c.state),
    confirmation = step?.observation;
  return {
    sessionId: c.state.sessionId,
    revision: c.state.revision,
    phase: c.state.phase,
    success: c.state.phase === 'done',
    resolved: false,
    userIssueResolved: null,
    summary: c.state.verdict?.summary || c.state.reason || c.state.phase,
    answer: c.state.verdict?.summary || c.state.reason || c.state.phase,
    requestId: step?.requestId,
    stepCount: c.state.stepCount,
    retryCount: c.state.retryCount,
    ...(c.state.phase === 'act' || c.state.phase === 'observe'
      ? {
          recoveryRequired: true,
          summary:
            'Execution outcome is uncertain. Inspect and reconcile before resuming; do not retry the start.',
          answer:
            'Execution outcome is uncertain. Inspect and reconcile before resuming; do not retry the start.',
        }
      : {}),
    ...(c.state.phase === 'waiting_confirmation'
      ? {
          confirmationId: confirmation.confirmationId,
          confirmationMessage: confirmation.confirmationMessage,
        }
      : {}),
  };
}
/** Fixed mode adapter; every attempt, transition and terminal verdict is admitted by AgentState. */
export async function driveWindowsRepair(
  c,
  { executeStep: execute = executeStep, recordRepair = logTypedRepair } = {},
  { signal, onEvent = () => {}, confirmationId } = {},
) {
  try {
    if (c.state.phase === 'waiting_confirmation') {
      if (!confirmationId || confirmationId !== currentStep(c.state)?.observation?.confirmationId)
        throw Object.assign(new Error('Explicit matching human approval required.'), {
          status: 409,
        });
      await c.execute(execute, { signal, confirmationId });
    }
    while (!c.stopped) {
      if (signal?.aborted) {
        c.stop('cancelled', 'Cancelled; any admitted service effect requires inspection.');
        break;
      }
      if (c.state.phase === 'plan') {
        await c.execute(execute, { signal });
        continue;
      }
      if (c.state.phase !== 'decide') throw new Error('Repair checkpoint requires reconciliation.');
      const step = currentStep(c.state),
        o = step?.observation;
      if (o?.reconciliation?.disposition === 'abandon') {
        c.stop('cancelled', 'Abandoned after manual review.');
        break;
      }
      if (!o?.success) {
        c.stop(
          'error',
          o?.error?.message || 'Repair attempt failed. No mutation retry is allowed.',
        );
        break;
      }
      if (step.action === 'inspectSpooler') {
        onEvent({ type: 'diagnosis', payload: o.data });
        if (!o.data.eligible && o.data.reason !== 'ALREADY_RUNNING') {
          c.stop('error', o.data.reason || 'Diagnosis is not eligible.');
          break;
        }
        c.plan(
          plan(o.data.reason === 'ALREADY_RUNNING' ? 'verifySpooler' : 'startSpooler', {
            diagnosisId: o.data.diagnosisId,
          }),
        );
      } else if (step.action === 'startSpooler')
        c.plan(plan('verifySpooler', { diagnosisId: step.params.diagnosisId }));
      else if (step.action === 'verifySpooler') {
        const ok =
          o.data?.verificationStatus === 'passed' && verified(o.data.samples, o.data.baseline);
        c.finish({
          success: ok,
          scope: 'service_running',
          summary: ok
            ? 'Print Spooler is running; printing has not been verified.'
            : 'Spooler running condition was not verified.',
          recommendation: '',
          userIssueResolved: null,
        });
      } else throw new Error('Unknown repair step.');
    }
  } catch (e) {
    if (e.status) throw e;
    if (signal?.aborted)
      c.stop('cancelled', 'Cancelled; a service start may already have occurred.');
    else if (!e.recoveryRequired) c.stop('error', e.message);
  }
  recordRepair(c.state);
  const final = result(c);
  onEvent({ type: 'final', payload: final });
  return final;
}
export async function runWindowsRepair({
  goal,
  userId,
  signal,
  onEvent = () => {},
  dependencies = {},
}) {
  const c = new ExecutionController(goal, {
    ownerId: userId ?? null,
    taskType: REPAIR_TASK,
    maxSteps: LIMITS.maxSteps,
    maxRetries: 0,
    save: dependencies.save || createCheckpointStore(),
    onEvent,
  });
  const lease = claimSession(c, signal);
  try {
    if (!isSpoolerIntent(goal)) {
      c.stop(
        'error',
        'Only diagnosis and approved start of the local Print Spooler are supported.',
      );
      const final = result(c);
      onEvent({ type: 'final', payload: final });
      return final;
    }
    c.plan(plan('inspectSpooler'));
    return await driveWindowsRepair(c, dependencies, {
      signal: lease.signal,
      onEvent,
    });
  } finally {
    lease.release();
  }
}
