import { createAgentState, transition, assignPlan, currentStep, updateCurrentStep, advanceStep, isTerminalState, checkpoint, restoreCheckpoint, renewStateConfirmation } from './AgentState.js';
import { normaliseObservation } from './ObservationHandler.js';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Mode adapters supply transport and persistence; execution admission lives here. */
export class ExecutionController {
  constructor(task, options = {}) {
    this.state = freeze(options.checkpoint ? restoreCheckpoint(options.checkpoint) : createAgentState(task, options));
    this.save = options.save || (() => {});
    this.onEvent = options.onEvent || (() => {});
    if (!options.checkpoint) this.save(checkpoint(this.state));
  }
  commit(next) {
    this.save(checkpoint(next)); // Fail closed before side effects if persistence fails.
    this.state = freeze(next);
    this.onEvent({ type: 'state_transition', payload: { phase: next.phase, revision: next.revision, sessionId: next.sessionId, event: next.events.at(-1) } });
  }
  move(phase, patch) {
    this.commit(transition(this.state, phase, patch));
    this.onEvent({ type: 'phase_transition', payload: { phase, sessionId: this.state.sessionId, revision: this.state.revision } });
  }
  get stopped() { return isTerminalState(this.state) || this.state.phase === 'waiting_confirmation'; }
  plan(steps) {
    const keep = this.state.plan.filter(s => s.status === 'done');
    if (this.state.phase === 'plan') this.commit(assignPlan(this.state, [...keep, ...steps], keep.length));
    else this.move('plan', { plan: [...keep, ...steps], currentStepIndex: keep.length });
  }
  async execute(executor, { signal, confirmationId } = {}) {
    if (signal?.aborted) { this.stop('cancelled', 'aborted'); return null; }
    this.move('act', confirmationId ? { confirmationId } : {});
    const step = currentStep(this.state);
    this.onEvent({ type: 'step_start', payload: { ...step, stepIndex: step.index } });
    let raw;
    try { raw = await executor(step, { signal, ownerId: this.state.ownerId, admission:{sessionId:this.state.sessionId,revision:this.state.revision,taskType:this.state.taskType} }); }
    catch (error) { raw = { success: false, error: { code: this.state.mode === 'orchestrator' ? 'EXECUTION_UNCERTAIN' : 'EXECUTION_ERROR', message: error.message } }; }
    if (this.state.mode === 'orchestrator' && ['EXECUTION_UNCERTAIN', 'BRIDGE_NETWORK_ERROR'].includes(raw?.error?.code)) {
      this.onEvent({ type: 'recovery_required', payload: { sessionId: this.state.sessionId, requestId: step.requestId, reason: raw.error.message } });
      throw Object.assign(new Error(raw.error.message), { recoveryRequired: true });
    }
    if (['requestId', 'idempotencyKey'].some(key => raw?.[key] != null && raw[key] !== step[key])) raw = { success: false, error: { code: 'IDENTITY_MISMATCH', message: 'Response belongs to another execution attempt.' } };
    this.move('observe');
    const observation = { ...normaliseObservation(raw, step.index, step.toolCallId), requestId: step.requestId, idempotencyKey: step.idempotencyKey };
    this.commit(updateCurrentStep(this.state, observation.needsConfirmation ? 'confirmation_required' : observation.success ? 'done' : 'failed', observation));
    this.move('decide');
    if (signal?.aborted) this.stop('cancelled', 'aborted');
    else if (observation.needsConfirmation) {
      this.stop('waiting_confirmation', 'confirmation_required');
      this.onEvent({ type: 'confirmation_required', payload: { ...observation, message: observation.confirmationMessage } });
    }
    return observation;
  }
  advance() { this.commit(advanceStep(this.state)); }
  renewConfirmation(renewal) { this.commit(renewStateConfirmation(this.state, renewal)); }
  recover() { this.move('replan'); }
  stop(phase = 'error', reason = 'execution_failed') { if (!isTerminalState(this.state)) this.move(phase, { reason }); }
  finish(verdict) {
    if (this.state.phase !== 'verify') this.move('verify');
    this.move(verdict.success === true ? 'done' : 'error', { verdict });
  }
}
