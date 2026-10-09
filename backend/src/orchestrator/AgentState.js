/** Portable execution authority shared by backend and chat mode. No I/O. */
export const TRANSITIONS = Object.freeze({
  idle: ['plan', 'error', 'cancelled'],
  plan: ['act', 'verify', 'error', 'cancelled'],
  act: ['observe', 'error', 'cancelled'],
  observe: ['decide', 'error', 'cancelled'],
  decide: [
    'act',
    'plan',
    'replan',
    'verify',
    'waiting_confirmation',
    'awaiting_app_choice',
    'error',
    'cancelled',
  ],
  replan: ['plan', 'error', 'cancelled'],
  verify: ['done', 'error', 'cancelled'],
  waiting_confirmation: ['act', 'cancelled', 'error'],
  awaiting_app_choice: ['act', 'cancelled', 'error'],
  done: [],
  error: [],
  cancelled: [],
});
export const isTerminalState = (s) => TRANSITIONS[s.phase]?.length === 0;
/** The step status an observation implies. A step that needs the user (approval or an application choice) is neither done nor failed. */
export const observationStatus = (o) =>
  o.needsConfirmation
    ? 'confirmation_required'
    : o.needsAppChoice
      ? 'app_choice_required'
      : o.success === true
        ? 'done'
        : 'failed';
const clone = (v) => JSON.parse(JSON.stringify(v));
const stamp = () => new Date().toISOString();
export function createAgentState(
  task,
  {
    maxRetries = 2,
    maxSteps = 10,
    taskType = 'unknown',
    mode = 'orchestrator',
    ownerId = null,
    sessionId = globalThis.crypto.randomUUID(),
    now = stamp(),
  } = {},
) {
  for (const [key, value, min, max] of [
    ['maxSteps', maxSteps, 1, 50],
    ['maxRetries', maxRetries, 0, 10],
  ]) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  }
  return {
    schemaVersion: 1,
    sessionId,
    ownerId,
    task: String(task || '').trim(),
    mode,
    taskType,
    phase: 'idle',
    plan: [],
    currentStepIndex: 0,
    observations: [],
    attempts: [],
    retryCount: 0,
    maxRetries,
    maxSteps,
    stepCount: 0,
    verdict: null,
    errors: [],
    revision: 0,
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}
function record(state, patch, type, now = stamp()) {
  return {
    ...state,
    ...clone(patch),
    revision: state.revision + 1,
    updatedAt: now,
    events: [
      ...state.events,
      {
        sequence: state.revision + 1,
        type,
        from: state.phase,
        to: patch.phase || state.phase,
        timestamp: now,
      },
    ],
  };
}
export function transition(state, phase, patch = {}) {
  if (!TRANSITIONS[state.phase]?.includes(phase))
    throw new Error(`Illegal transition: ${state.phase} -> ${phase}`);
  const permitted =
    phase === 'plan'
      ? ['plan', 'currentStepIndex']
      : phase === 'act' && state.phase === 'waiting_confirmation'
        ? ['confirmationId']
        : phase === 'act' && state.phase === 'awaiting_app_choice'
          ? ['choiceId', 'candidateId']
          : phase === 'awaiting_app_choice'
            ? ['pendingTask', 'verdict', 'reason']
            : ['verdict', 'reason'];
  if (Object.keys(patch).some((k) => !permitted.includes(k)))
    throw new Error('Protected state field in transition');
  if (phase === 'act') {
    if (isStepBudgetExhausted(state)) throw new Error('Step budget exhausted');
    const confirming =
      state.phase === 'waiting_confirmation' &&
      patch.confirmationId &&
      patch.confirmationId === currentStep(state)?.observation?.confirmationId;
    // An application choice is answered by candidate id: it must be the open question's id and one of the options that were offered.
    const asked = state.pendingTask;
    const choosing =
      state.phase === 'awaiting_app_choice' &&
      !!patch.choiceId &&
      patch.choiceId === currentStep(state)?.observation?.choiceId &&
      patch.choiceId === asked?.choiceId &&
      Array.isArray(asked.candidates) &&
      asked.candidates.some((c) => c.id === patch.candidateId);
    if (currentStep(state)?.status !== 'pending' && !confirming && !choosing)
      throw new Error('No pending step, matching confirmation or app choice');
    const identity = {
      requestId: `${state.sessionId}:request:${state.stepCount + 1}`,
      idempotencyKey: confirming
        ? `${state.sessionId}:confirm:${patch.confirmationId}`
        : choosing
          ? `${state.sessionId}:choose:${patch.choiceId}`
          : `${state.sessionId}:call:${state.stepCount + 1}`,
    };
    const pending = clone(currentStep(state));
    if (pending.params?.targetFromStep) {
      const ref = pending.params.targetFromStep;
      const source = state.plan.slice(0, state.currentStepIndex).find((s) => s.toolCallId === ref);
      if (
        pending.tool !== 'app' ||
        pending.action !== 'openWithTarget' ||
        source?.tool !== 'app' ||
        source?.action !== 'resolveTarget' ||
        source.status !== 'done' ||
        source.observation?.success !== true ||
        source.observation?.data?.status !== 'TARGET_RESOLVED' ||
        !source.observation.data.target
      )
        throw new Error('Invalid target step dependency');
      const { targetFromStep, ...params } = pending.params;
      pending.params = {
        ...params,
        target: clone(source.observation.data.target),
      };
      pending.targetSourceStep = ref;
    }
    const request = {
      ...pending,
      ...identity,
      ...(confirming ? { confirmationId: patch.confirmationId } : {}),
      ...(choosing ? { choiceId: patch.choiceId, candidateId: patch.candidateId } : {}),
    };
    // Binding the candidate moves the pending task to execution; the choice is recorded on it, not scattered over the state.
    const binding = choosing
      ? {
          pendingTask: {
            ...clone(asked),
            phase: 'executing',
            selectedCandidateId: patch.candidateId,
            selectedAt: stamp(),
          },
        }
      : {};
    patch = {
      ...(choosing ? {} : patch),
      ...binding,
      stepCount: state.stepCount + 1,
      plan: state.plan.map((s, i) =>
        i === state.currentStepIndex ? { ...request, status: 'running', observation: null } : s,
      ),
      attempts: [
        ...state.attempts,
        {
          attemptId: `${state.sessionId}:${state.stepCount + 1}`,
          request,
          observation: null,
        },
      ],
    };
  }
  if (phase === 'replan') {
    if (!canReplan(state) || isStepBudgetExhausted(state))
      throw new Error('Retry or step budget exhausted');
    patch = { ...patch, retryCount: state.retryCount + 1 };
  }
  if (phase === 'observe' && currentStep(state)?.status !== 'running')
    throw new Error('No running step');
  if (phase === 'decide' && !currentStep(state)?.observation)
    throw new Error('Missing observation');
  if (phase === 'plan' && patch.plan) patch = preparePlan(state, patch);
  if (phase === 'verify' && state.plan.some((s) => s.status !== 'done'))
    throw new Error('Incomplete plan cannot verify');
  if (phase === 'waiting_confirmation' && !currentStep(state)?.observation?.needsConfirmation)
    throw new Error('Missing confirmation request');
  if (phase === 'awaiting_app_choice') {
    const asked = currentStep(state)?.observation,
      task = patch.pendingTask;
    if (!asked?.needsAppChoice) throw new Error('Missing app choice request');
    if (
      !task ||
      task.choiceId !== asked.choiceId ||
      !Array.isArray(task.candidates) ||
      !task.candidates.length
    )
      throw new Error('Invalid pending app task');
  }
  if (
    phase === 'done' &&
    (patch.verdict?.success !== true || state.plan.some((s) => s.status !== 'done'))
  )
    throw new Error('Success requires completed steps and strict verdict');
  if (['error', 'cancelled', 'waiting_confirmation', 'awaiting_app_choice'].includes(phase))
    patch = {
      ...patch,
      verdict: {
        summary: patch.reason || phase,
        recommendation: '',
        ...patch.verdict,
        success: false,
      },
    };
  return record(state, { ...patch, phase }, 'transition');
}
function preparePlan(state, patch) {
  if (state.phase === 'decide' && currentStep(state)?.status !== 'done')
    throw new Error('Failed step requires replan');
  const seen = new Set(state.attempts.map((a) => a.request.toolCallId));
  const withinPlan = new Set();
  patch = {
    ...patch,
    plan: patch.plan.map((s, i) => {
      const toolCallId =
        s.toolCallId ?? s.id ?? `${state.sessionId}:plan${state.revision + 1}:${i}`;
      if (typeof toolCallId !== 'string' || !toolCallId || withinPlan.has(toolCallId))
        throw new Error('Invalid or duplicate tool-call identity');
      withinPlan.add(toolCallId);
      if (
        s.status === 'done' &&
        !state.plan.some(
          (old) => old.status === 'done' && serializeState(old) === serializeState(s),
        )
      )
        throw new Error('Cannot manufacture completed work');
      if (s.status && !['pending', 'done'].includes(s.status))
        throw new Error('New steps must be pending');
      if (s.status !== 'done' && seen.has(toolCallId))
        throw new Error('Duplicate tool-call identity');
      seen.add(toolCallId);
      return {
        ...s,
        toolCallId,
        index: i,
        status: s.status || 'pending',
        observation: s.observation || null,
      };
    }),
  };
  return patch;
}
export function assignPlan(state, steps, currentStepIndex = 0) {
  if (state.phase !== 'plan' || state.plan.some((s) => s.status === 'pending'))
    throw new Error('Plan cannot be replaced here');
  return record(state, preparePlan(state, { plan: steps, currentStepIndex }), 'plan_assigned');
}

export const currentStep = (s) => s.plan[s.currentStepIndex] ?? null;
export const isPlanExhausted = (s) => s.currentStepIndex >= s.plan.length;
export const isStepBudgetExhausted = (s) => s.stepCount >= s.maxSteps;
export const canReplan = (s) => s.retryCount < s.maxRetries;
export function updateCurrentStep(state, status, observation) {
  const step = currentStep(state);
  if (state.phase !== 'observe' || step?.status !== 'running' || !observation)
    throw new Error('Observation outside running attempt');
  if (observation.toolCallId !== step.toolCallId) throw new Error('Tool-call identity mismatch');
  if (status !== observationStatus(observation)) throw new Error('Status contradicts observation');
  return record(
    state,
    {
      plan: state.plan.map((s, i) =>
        i === state.currentStepIndex ? { ...s, status, observation } : s,
      ),
      observations: [...state.observations, observation],
      attempts: state.attempts.map((a, i) =>
        i === state.attempts.length - 1 ? { ...a, observation } : a,
      ),
      // The paused task finishes with the call that carried the user's answer (or is replaced by a fresh question).
      ...(state.pendingTask?.phase === 'executing' && !observation.needsConfirmation
        ? {
            pendingTask: {
              ...state.pendingTask,
              phase: observation.needsAppChoice
                ? 'superseded'
                : observation.success === true
                  ? 'resolved'
                  : 'failed',
            },
          }
        : {}),
    },
    'observation',
  );
}
export function advanceStep(state) {
  if (state.phase !== 'decide' || currentStep(state)?.status !== 'done')
    throw new Error('Cannot advance incomplete step');
  return record(state, { currentStepIndex: state.currentStepIndex + 1 }, 'advance');
}
/** Audited token replacement is not an execution attempt or an approval. */
export function renewStateConfirmation(state, renewal) {
  const step = currentStep(state);
  if (
    state.phase !== 'waiting_confirmation' ||
    !step?.observation?.needsConfirmation ||
    renewal?.previousId !== step.observation.confirmationId ||
    typeof renewal.confirmationId !== 'string' ||
    !renewal.confirmationId ||
    renewal.confirmationId === renewal.previousId ||
    !Number.isFinite(renewal.expiresAt)
  )
    throw new Error('Invalid confirmation renewal');
  const observation = {
    ...step.observation,
    confirmationId: renewal.confirmationId,
    confirmationMessage: renewal.message || step.observation.confirmationMessage,
    confirmationExpiresAt: renewal.expiresAt,
  };
  return record(
    state,
    {
      plan: state.plan.map((s, i) => (i === state.currentStepIndex ? { ...s, observation } : s)),
      confirmationRenewals: [...(state.confirmationRenewals || []), clone(renewal)],
    },
    'confirmation_renewed',
  );
}
export function summariseState(s) {
  const {
    sessionId,
    phase,
    taskType,
    currentStepIndex,
    stepCount,
    retryCount,
    updatedAt,
    revision,
  } = s;
  return {
    sessionId,
    phase,
    taskType,
    currentStepIndex,
    stepCount,
    retryCount,
    updatedAt,
    revision,
    totalSteps: s.plan.length,
    verdictSuccess: s.verdict?.success ?? null,
  };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const serializeState = (state) => JSON.stringify(canonical(state));
export function checkpoint(state) {
  return {
    schemaVersion: 1,
    kind: 'agent-checkpoint',
    revision: state.revision,
    recovery:
      state.phase === 'act' || state.phase === 'observe'
        ? 'reconcile-before-resume'
        : 'manual-resume-only',
    state: clone(state),
  };
}
export function restoreCheckpoint(value) {
  const c = typeof value === 'string' ? JSON.parse(value) : clone(value);
  const s = c.state;
  if (
    c.schemaVersion !== 1 ||
    c.kind !== 'agent-checkpoint' ||
    !s ||
    s.schemaVersion !== 1 ||
    c.revision !== s.revision ||
    !TRANSITIONS[s.phase] ||
    s.stepCount > s.maxSteps ||
    s.retryCount > s.maxRetries ||
    s.attempts.length !== s.stepCount ||
    s.events.length !== s.revision
  )
    throw new Error('Invalid checkpoint');
  for (const key of [
    'stepCount',
    'retryCount',
    'revision',
    'currentStepIndex',
    'maxRetries',
    'maxSteps',
  ]) {
    if (!Number.isInteger(s[key]) || s[key] < 0) throw new Error('Invalid checkpoint counters');
  }
  if (s.maxSteps < 1 || s.maxSteps > 50 || s.maxRetries > 10 || s.currentStepIndex > s.plan.length)
    throw new Error('Invalid checkpoint limits');
  if (
    s.phase === 'done' &&
    (s.verdict?.success !== true || s.plan.some((p) => p.status !== 'done'))
  )
    throw new Error('Invalid checkpoint success');
  if (
    ['error', 'cancelled', 'waiting_confirmation', 'awaiting_app_choice'].includes(s.phase) &&
    s.verdict?.success !== false
  )
    throw new Error('Invalid checkpoint failure');
  if (
    s.phase === 'awaiting_app_choice' &&
    !(
      s.pendingTask?.choiceId &&
      Array.isArray(s.pendingTask.candidates) &&
      s.pendingTask.candidates.length
    )
  )
    throw new Error('Invalid checkpoint app choice');
  let phase = 'idle';
  s.events.forEach((event, i) => {
    if (
      event.sequence !== i + 1 ||
      event.from !== phase ||
      (event.type === 'transition' && !TRANSITIONS[phase]?.includes(event.to)) ||
      (event.type !== 'transition' && event.to !== phase)
    )
      throw new Error('Invalid checkpoint event sequence');
    phase = event.to;
  });
  if (phase !== s.phase) throw new Error('Checkpoint phase does not match event history');
  return s; // Inspection only; never automatically re-execute an in-flight call.
}
