import { runWindowsRepair } from '../orchestrator/WindowsRepairCapability.js';
/** Auto Repair is an adapter to the sole AgentState controller. No command fallback. */
export async function runRepair(options) {
  return runWindowsRepair(options);
}
