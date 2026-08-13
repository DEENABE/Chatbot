/**
 * @module agents/AgentRegistry
 * @description Maps a domain to its specialized agent instance. The general
 * WindowsRepairAgent is the fallback for anything unrecognized.
 */

import { BluetoothAgent } from './BluetoothAgent.js';
import { NetworkAgent } from './NetworkAgent.js';
import { PerformanceAgent } from './PerformanceAgent.js';
import { FileRepairAgent } from './FileRepairAgent.js';
import { SecurityAgent } from './SecurityAgent.js';
import { WindowsRepairAgent } from './WindowsRepairAgent.js';
import { AutomationAgent } from './AutomationAgent.js';

const registry = {
  bluetooth: new BluetoothAgent(),
  network: new NetworkAgent(),
  performance: new PerformanceAgent(),
  file: new FileRepairAgent(),
  security: new SecurityAgent(),
  windows: new WindowsRepairAgent(),
  automation: new AutomationAgent()
};

/**
 * Resolve the agent for a domain (falls back to the general Windows agent).
 * @param {string} domain
 * @returns {import('./BaseAgent.js').BaseAgent}
 */
export function getAgent(domain) {
  return registry[domain] || registry.windows;
}

export { registry };
