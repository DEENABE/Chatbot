import {computerTask} from '../../../backend/src/orchestrator/ComputerTaskPolicy.js';
import {applicationGoalVerdict} from '../../../backend/src/orchestrator/ApplicationGoal.js';
import {genericDesktopTask,desktopCompletion} from '../../../backend/src/orchestrator/GenericDesktopTask.js';
import {compoundAppTask} from '../../../backend/src/orchestrator/ComputerTaskPolicy.js';
import {verifyCapabilities} from '../../../backend/src/orchestrator/CapabilityContracts.js';
import { ExecutionController } from '../../../backend/src/orchestrator/ExecutionController.js';
import { canReplan, isStepBudgetExhausted, serializeState } from '../../../backend/src/orchestrator/AgentState.js';
import { modelPolicy } from '../../tools/repair/contract.js';

/** Chat is a mode using the same control plane, with IPC as its transport. */
export function createChatExecution(task, options = {}) {
  return new ExecutionController(task, { mode: 'chat', maxSteps: 10, maxRetries: 2,
    save: value => localStorage.setItem(`agent-checkpoint:${value.state.sessionId}`, serializeState(value)), ...options });
}
export async function executeChatCall(c, call, tools, execute, signal) {
  if (isStepBudgetExhausted(c.state)) { c.stop('error', 'Step budget exhausted.'); return null; }
  if (c.state.phase === 'decide' && c.state.observations.at(-1)?.success !== true) {
    if (!canReplan(c.state)) { c.stop('error', 'Retry budget exhausted.'); return null; }
    c.recover();
  }
  const name = call.function?.name;
  const allowed = tools.some(t => t.function?.name === name);
  const separator = typeof name === 'string' ? name.indexOf('_') : -1;
  let params = call.function?.arguments ?? {};
  let invalid = null;
  try {
    if (typeof params === 'string') params = JSON.parse(params);
    if (!params || Array.isArray(params) || typeof params !== 'object') throw new Error('Tool arguments must be an object.');
  } catch (error) { invalid = error.message; params = {}; }
  const step = { toolCallId: call.id, rawToolCall: call, tool: separator > 0 ? name.slice(0, separator) : '',
    action: separator > 0 ? name.slice(separator + 1) : '', params, description: name || 'Invalid tool call' };
  c.plan([step]);
  return c.execute(s => {
    if (!allowed || separator < 1) return { success: false, error: { code: 'TOOL_NOT_ALLOWED', message: `Unknown tool: ${name}` } };
    if (invalid) return { success: false, error: { code: 'VALIDATION_ERROR', message: invalid } };
    if(['powershell','cmd','services','process','_system','windowsRepair'].includes(s.tool)) {
      const denied=modelPolicy(s.tool,s.action,s.params);
      if(denied || s.tool==='windowsRepair')return {success:false,error:{code:'MODEL_CAPABILITY_DENIED',message:'Use the owned typed repair session or an allowlisted safe capability.'}};
    }
    return execute(s.tool, s.action, s.params, s.toolCallId, { requestId: s.requestId, idempotencyKey: s.idempotencyKey, signal });
  }, { signal });
}
export async function executeCancellableTool(engine, tool, action, params, toolCallId, identity = {}) {
  const cancel = () => { Promise.resolve(engine.cancelRequest(identity.requestId)).catch(() => {}); };
  if (identity.signal?.aborted) { cancel(); return { success: false, error: { code: 'CANCELLED', message: 'Request cancelled.' } }; }
  identity.signal?.addEventListener('abort', cancel, { once: true });
  try { return tool === '_system' && action === 'confirm'
    ? await engine.confirm(params.confirmationId, { ...identity, toolCallId })
    : await engine.execute(tool, action, params, toolCallId, identity); }
  finally { identity.signal?.removeEventListener('abort', cancel); }
}
export function finishChat(c) {
  if (c.stopped) return;
  if (c.state.phase === 'idle') c.plan([]);
  if (c.state.plan.some(s => s.status !== 'done')) c.stop('error', 'Chat ended with incomplete tool work.');
  else if(computerTask(c.state.task)?.genericDesktop)c.finish({success:desktopCompletion(c.state.plan.at(-1)?.observation?.data,c.state.task),summary:'Generic desktop goal checked against fresh UI evidence.',recommendation:''});
  else if(compoundAppTask(c.state.task)) {
    const checked=verifyCapabilities(c.state.plan);
    const verdict=applicationGoalVerdict(compoundAppTask(c.state.task),c.state.plan);
    c.finish({...verdict,success:checked?.success===true && verdict.success});
  }
  else if(computerTask(c.state.task)?.requiresBrowser){const checked=verifyCapabilities(c.state.plan);c.finish({success:checked?.success===true&&c.state.plan.some(s=>s.tool==='browser'),summary:checked?.summary||'Browser goal not verified.',recommendation:''});}
  else c.finish({ success: true, summary: 'Chat turn completed.', recommendation: '', scope: 'execution' });
}
