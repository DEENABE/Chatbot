import { runWindowsRepair } from '../orchestrator/WindowsRepairCapability.js';
import { repairTask } from '../orchestrator/RepairTask.js';
import { runDiagnosticRepair } from '../orchestrator/DiagnosticRepair.js';
/** Auto Repair is an adapter to the sole AgentState controller. No command fallback. */
export async function runRepair(options) {
  const task = repairTask(options.goal);
  if (task && task.domain !== 'spooler') return runDiagnosticRepair({ ...options, domain: task.domain });
  return runWindowsRepair(options);
}
