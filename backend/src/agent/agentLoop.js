/** API compatibility surface; control is delegated to AgentState. */
import { AGENT_DEFAULT_MODEL } from './agentBrain.js';
import { runLegacyExecution } from '../orchestrator/LegacyExecutionAdapter.js';
import { isSpoolerIntent, runWindowsRepair } from '../orchestrator/WindowsRepairCapability.js';

export async function runAgent({ goal, model = AGENT_DEFAULT_MODEL, maxSteps = 10, maxRetries = 2, signal, userId, onEvent = () => {}, dependencies }) {
  if(isSpoolerIntent(goal))return runWindowsRepair({goal,userId,signal,onEvent,dependencies});
  const result = await runLegacyExecution({ goal, model, maxSteps, maxRetries, signal, userId, onEvent, dependencies });
  onEvent({ type: 'final', payload: { answer: result.answer, success: result.success, stopped: result.stopped, phase: result.state.phase } });
  return { ...result, steps: result.steps.length };
}
export default runAgent;
