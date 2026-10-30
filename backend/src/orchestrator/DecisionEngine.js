import { currentStep, isStepBudgetExhausted, canReplan } from './AgentState.js';

export function decide(state) {
  const obs = currentStep(state)?.observation;
  if (obs?.needsConfirmation) return { decision: 'confirm', reason: 'User confirmation required.' };
  if (obs?.needsAppChoice)
    return {
      decision: 'choose_app',
      reason: 'The user must choose an application.',
    };
  if (state.plan.length && state.plan.every((s) => s.status === 'done'))
    return { decision: 'success', reason: 'All required steps completed.' };
  if (isStepBudgetExhausted(state)) return { decision: 'abort', reason: 'Step budget exhausted.' };
  if (!obs && currentStep(state)?.status === 'pending')
    return { decision: 'continue', reason: 'Step not yet executed.' };
  if (obs?.success === true) return { decision: 'continue', reason: 'Advance to the next step.' };
  const code = obs?.error?.code;
  if (
    obs?.error?.retryable === false ||
    [
      'TARGET_NOT_FOUND',
      'TARGET_TYPE_UNSUPPORTED',
      'AMBIGUOUS_TARGET',
      'PERMISSION_DENIED',
      'USER_REJECTED',
      'VERIFICATION_FAILED',
    ].includes(code)
  )
    return { decision: 'abort', reason: obs.error.message };
  if (obs?.error?.retryable === true && canReplan(state))
    return {
      decision: 'replan',
      reason: 'Retryable observation requires a revised plan.',
    };
  if (code?.startsWith('APP_') || code?.startsWith('UI_') || code === 'AMBIGUOUS_APP')
    return { decision: 'abort', reason: obs.error.message };
  if (code === 'MANUALLY_ABANDONED')
    return { decision: 'abort', reason: 'Abandoned after manual review.' };
  if (
    [
      'EXECUTION_UNCERTAIN',
      'CANCELLED',
      'IDEMPOTENCY_CONFLICT',
      'BRIDGE_UNAVAILABLE',
      'BRIDGE_NETWORK_ERROR',
      'BRIDGE_TIMEOUT',
      'IDENTITY_MISMATCH',
      'TOOL_NOT_ALLOWED',
    ].includes(code)
  )
    return {
      decision: 'abort',
      reason: `Bridge or security failure: ${code}.`,
    };
  if (state.plan.length && canReplan(state))
    return {
      decision: 'replan',
      reason: 'Failed work requires a revised plan.',
    };
  return {
    decision: 'abort',
    reason: 'Retry budget exhausted or no valid plan.',
  };
}
export const shouldAdvance = (r) => r.decision === 'continue';
export const isTerminal = (r) => ['success', 'abort'].includes(r.decision);
