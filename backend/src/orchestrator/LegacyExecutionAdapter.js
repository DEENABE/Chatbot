import { ExecutionController } from './ExecutionController.js';
import { createCheckpointStore } from './CheckpointStore.js';
import { decideNextStep } from '../agent/agentBrain.js';
import { classifyCommand } from '../agent/dangerClassifier.js';
import { runPowerShell } from '../agent/powershellRunner.js';
import { isStepBudgetExhausted, canReplan } from './AgentState.js';
import { claimSession } from './ExecutionSessions.js';

/** Compatibility adapter only: command generation and Windows execution are unchanged. */
export async function runLegacyExecution({ goal, model, systemPrompt, maxSteps = 10, maxRetries = 2, signal, userId, title, mode = 'api-agent', deferVerification = false, onEvent = () => {}, dependencies = {} }) {
  const deps = { decideNextStep, classifyCommand, runPowerShell, save: createCheckpointStore(), ...dependencies };
  const c = new ExecutionController(goal, { mode, ownerId: userId ?? null, maxSteps, maxRetries, save: deps.save, onEvent });
  // Production model-originated shell execution is retired. Dependency injection
  // retains the old adapter's pure control-plane fixtures, never an API bypass.
  if(!Object.hasOwn(dependencies,'runPowerShell')) {
    c.stop('error','MODEL_CAPABILITY_DENIED: use an approved typed capability; generic PowerShell execution is unavailable.');
    onEvent({type:'blocked',payload:{reason:c.state.reason}});
    return {answer:c.state.reason,steps:[],stopped:'policy',success:false,readyToVerify:false,controller:c,state:c.state};
  }
  const lease = claimSession(c, signal);
  signal = lease.signal;
  const steps = [];
  let answer = null;
  let stopped = 'done';
  const emit = (type, payload) => onEvent({ type, payload: { ...(title ? { agent: title } : {}), ...payload } });
  try {
    while (!c.stopped) {
      if (signal?.aborted) { stopped = 'aborted'; c.stop('cancelled', stopped); break; }
      if (isStepBudgetExhausted(c.state)) {
        if (mode === 'api-agent') {
          const closing = await deps.decideNextStep({
            goal: `${goal}\n\n(You have reached the step limit. Summarize what you found and give the user a final recommendation.)`,
            steps, model, systemPrompt, signal,
          }).catch(() => null);
          answer = closing?.answer || 'Reached the maximum number of steps without a confirmed fix. See the diagnostics above and consider the recommendations.';
        }
        stopped = 'max-steps'; c.stop('error', answer || 'Step budget exhausted.'); break;
      }
      const decision = await deps.decideNextStep({ goal, steps, model, systemPrompt, signal });
      if (decision.thought) emit('thought', { text: decision.thought });
      if (signal?.aborted) { stopped = 'aborted'; c.stop('cancelled', stopped); break; }
      if (decision.done === true || !decision.command) {
        answer = decision.answer || decision.thought || 'No further action was determined.';
        if (c.state.phase === 'idle') c.plan([]);
        if (decision.done !== true || c.state.plan.some(s => s.status !== 'done')) { stopped = 'unconfirmed'; c.stop('error', answer); }
        else if (!deferVerification) c.finish({ success: true, summary: answer, recommendation: '', scope: 'execution' });
        break;
      }
      if (c.state.phase === 'decide' && c.state.observations.at(-1)?.success !== true) {
        if (!canReplan(c.state)) { stopped = 'retry_exhausted'; c.stop('error', 'Retry budget exhausted.'); break; }
        c.recover();
      }
      c.plan([{ tool: 'legacy-powershell', action: 'run', params: { command: decision.command }, description: decision.thought }]);
      const command = decision.command;
      await c.execute(async () => {
        const { level, reason } = deps.classifyCommand(command);
        emit('command', { command, level, reason });
        if (level === 'blocked') {
          emit('blocked', { command, reason });
          steps.push({ command, blocked: true, reason });
          return { success: false, error: { code: 'BLOCKED', message: reason } };
        }
        try {
          const result = await deps.runPowerShell(command, { timeout: 60_000, signal });
          steps.push({ command, ...result });
          emit('output', { command, ...result });
          return { success: result.exitCode === 0 && !result.timedOut, data: result,
            error: result.exitCode === 0 && !result.timedOut ? null : { code: result.timedOut ? 'TIMEOUT' : 'COMMAND_FAILED', message: result.stderr || 'Command failed.' } };
        } catch (error) {
          steps.push({ command, stdout: '', stderr: error.message, exitCode: null, timedOut: false });
          emit('error', { message: error.message });
          return { success: false, error: { code: 'EXECUTION_ERROR', message: error.message } };
        }
      }, { signal });
      if (c.state.observations.at(-1)?.error?.code === 'TIMEOUT' && !c.stopped) { stopped = 'timeout'; c.stop('error', 'Timed-out command requires review before retry.'); }
    }
  } catch (error) {
    stopped = signal?.aborted ? 'aborted' : 'execution_error';
    c.stop(signal?.aborted ? 'cancelled' : 'error', error.message);
    emit('error', { message: error.message });
  } finally { lease.release(); }
  if (c.state.phase === 'cancelled') { stopped = 'aborted'; emit('aborted', {}); }
  answer ||= c.state.verdict?.summary || 'Reached the maximum number of steps without a confirmed fix.';
  return { answer, steps, stopped, success: c.state.phase === 'done', readyToVerify: !c.stopped && stopped === 'done', controller: c, state: c.state };
}
