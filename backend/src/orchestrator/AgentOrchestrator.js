import {computerTask} from './ComputerTaskPolicy.js';
import { ExecutionController } from './ExecutionController.js';
import {genericDesktopTask} from './GenericDesktopTask.js';
import {nextDesktopDecision} from './GenericAppPlanner.js';
import { createCheckpointStore } from './CheckpointStore.js';
import { routeTask } from './TaskRouter.js';
import { createOrchestratorPlan } from './OrchestratorPlanner.js';
import { executeStep } from './AgentExecutor.js';
import { decide } from './DecisionEngine.js';
import { verifyOutcome } from './Verifier.js';
import { replan } from './Replanner.js';
import { createSessionLogger } from './orchestratorLogger.js';

import { currentStep } from './AgentState.js';
import { claimSession } from './ExecutionSessions.js';
import { loadResumeController, reconcileCheckpoint } from './CheckpointRecovery.js';
import { driveWindowsRepair, runWindowsRepair, REPAIR_TASK, isSpoolerIntent } from './WindowsRepairCapability.js';

function dependencies(overrides) {
  return { routeTask, createOrchestratorPlan, executeStep, verifyOutcome, replan,nextDesktopDecision,
    createLogger: createSessionLogger, save: createCheckpointStore(), ...overrides };
}
function result(c) {
  return { sessionId: c.state.sessionId, success: c.state.phase === 'done',
    summary: c.state.verdict?.summary || c.state.reason || c.state.phase,
    recommendation: c.state.verdict?.recommendation || '', stopped: c.state.phase === 'error' && c.state.stepCount >= c.state.maxSteps ? 'max_steps' : c.state.reason || c.state.phase,
    phase: c.state.phase, stepCount: c.state.stepCount, retryCount: c.state.retryCount };
}
async function drive(c, deps, { model, signal, onEvent, confirmationId }) {
  if(c.state.taskType===REPAIR_TASK) return driveWindowsRepair(c,deps,{signal,onEvent,confirmationId});
  const task = c.state.task;
  if (c.state.phase === 'waiting_confirmation') {
    if (!confirmationId || confirmationId !== currentStep(c.state)?.observation?.confirmationId)
      throw Object.assign(new Error('Explicit matching confirmation is required.'), { status: 409 });
    await c.execute(deps.executeStep, { signal, confirmationId });
  }
  while (!c.stopped) {
    if (signal?.aborted) { c.stop('cancelled', 'aborted'); break; }
    const phase = c.state.phase;
    if (phase === 'idle') {
      const route = await deps.routeTask(task, { model, signal });
      if (route.mode === 'simple') c.stop('error', 'Use chat mode for this request.');
      else c.move('plan');
    } else if (phase === 'plan' && !c.state.plan.length || phase === 'replan') {
      const plan = phase === 'replan'
        ? await deps.replan({ task, state: c.state, model, signal })
        : await deps.createOrchestratorPlan({ task, model, signal });
      if (!plan.steps.length) { c.stop('error', 'Empty plan.'); break; }
      c.plan(plan.steps);
      onEvent({ type: 'plan', payload: plan });
    } else if (phase === 'plan' || phase === 'decide' && currentStep(c.state)?.status === 'pending') {
      const observation = await c.execute(deps.executeStep, { signal });
      if (observation) onEvent({ type: 'step_result', payload: observation });
    } else if (phase === 'decide') {
      if(computerTask(task)?.genericDesktop){
        const evidence=c.state.attempts.filter(a=>a.observation).map(a=>({...a.observation,toolName:`${a.request.tool}_${a.request.action}`}));
        const decision=await deps.nextDesktopDecision({task,evidence,model,signal,intent:computerTask(task)?.genericDesktop});
        if(decision.call){
          if(c.state.stepCount>=c.state.maxSteps){c.stop('error','Step budget exhausted.');continue;}
          if(currentStep(c.state)?.status!=='done')c.recover();
          c.plan([{...decision.call,description:'Observe and execute one grounded desktop step'}]);
        }else if(decision.success===true)c.finish({success:true,summary:decision.message,recommendation:'',scope:'visible_ui_evidence'});
        else c.stop('error',decision.message||'The requested desktop outcome is not verified.');
        continue;
      }
      if (currentStep(c.state)?.observation?.reconciliation?.disposition === 'abandon') {
        c.stop('cancelled', 'Abandoned after manual review.');
        continue;
      }
      const decision = decide(c.state);
      onEvent({ type: 'decision', payload: decision });
      if (decision.decision === 'success') c.move('verify');
      else if (decision.decision === 'continue') c.advance();
      else if (decision.decision === 'replan') c.recover();
      else if (decision.decision === 'confirm') c.stop('waiting_confirmation', 'confirmation_required');
      else c.stop('error', decision.reason);
    } else if (phase === 'verify') {
      const verdict = await deps.verifyOutcome({ task, steps: c.state.plan, attempts: c.state.attempts, model, signal });
      onEvent({ type: 'verify', payload: { ...verdict, verified: verdict.success === true } });
      if (signal?.aborted) c.stop('cancelled', 'aborted');
      else c.finish(verdict);
    } else throw new Error('Checkpoint requires reconciliation before execution.');
  }
  const final = result(c);
  onEvent({ type: 'final', payload: final });
  return final;
}

/** AgentState remains the sole admission and transition authority. */
export async function runOrchestrator({ task, model, maxSteps = 10, maxRetries = 2, signal, userId, onEvent = () => {}, dependencies: overrides = {} }) {
  if(isSpoolerIntent(task)) return runWindowsRepair({goal:task,userId,signal,onEvent,dependencies:overrides});
  const deps = dependencies(overrides);
  const c = new ExecutionController(task, { ownerId: userId ?? null, maxSteps, maxRetries, onEvent, save: deps.save });
  const lease = claimSession(c, signal);
  const logger = deps.createLogger(c.state.sessionId, task);
  const send = onEvent;
  onEvent = event => { logger.log(event.type, event.payload); send(event); };
  c.onEvent = onEvent;
  try {
    const route = await deps.routeTask(task, { model, signal: lease.signal });
    onEvent({ type: 'router_decision', payload: route });
    if (lease.signal.aborted) c.stop('cancelled', 'aborted');
    else if (route.mode === 'simple') c.stop('error', 'Use chat mode for this request.');
    else {
      c.move('plan');
      const plan = await deps.createOrchestratorPlan({ task, taskType: route.taskType, model, signal: lease.signal });
      if (!plan.steps.length) c.stop('error', 'Empty plan.');
      else { c.plan(plan.steps); onEvent({ type: 'plan', payload: { ...plan, sessionId: c.state.sessionId } }); }
    }
    return await drive(c, deps, { model, signal: lease.signal, onEvent });
  } catch (error) {
    if (error.recoveryRequired) {
      const final = { ...result(c), stopped: 'recovery_required', summary: error.message };
      onEvent({ type: 'final', payload: final }); return final;
    }
    c.stop(lease.signal.aborted ? 'cancelled' : 'error', error.message);
    const final = result(c); onEvent({ type: 'final', payload: final }); return final;
  } finally { lease.release(); }
}

export async function resumeOrchestrator({ sessionId, userId, expectedRevision, confirmationId, model, signal, onEvent = () => {}, dependencies: overrides = {} }) {
  const deps = dependencies(overrides);
  const c = loadResumeController(deps.save, sessionId, userId, expectedRevision, onEvent);
  const lease = claimSession(c, signal);
  try {
    await reconcileCheckpoint(c, deps.inspectToolCall);
    // A crash may have saved decide immediately after a confirmation response.
    if (c.state.phase === 'decide' && currentStep(c.state)?.observation?.needsConfirmation) c.stop('waiting_confirmation', 'confirmation_required');
    return await drive(c, deps, { model, signal: lease.signal, onEvent, confirmationId });
  } catch (error) {
    if (!error.recoveryRequired) throw error;
    const final = { ...result(c), stopped: 'recovery_required', summary: error.message };
    onEvent({ type: 'final', payload: final });
    return final;
  } finally { lease.release(); }
}
