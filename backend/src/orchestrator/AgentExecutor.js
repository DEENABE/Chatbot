/**
 * @module orchestrator/AgentExecutor
 * @description Executes a single plan step by calling the ToolEngine via the
 * ToolEngineBridge. Returns the raw ToolResponse.
 *
 * SECURITY CONTRACT:
 * - This module NEVER calls child_process, powershell, spawn, or exec directly.
 * - All execution goes through ToolEngineBridge → Electron ToolEngineRouter.
 * - dangerGuard, ConfirmationGate, and InputValidator all remain active.
 * - This module validates the plan step against the Milestone 1 manifest
 *   (ALLOWED_ACTIONS) before forwarding, providing a second independent check.
 */

import { callTool } from './ToolEngineBridge.js';
import { validateCapability } from './CapabilityContracts.js';
import { ALLOWED_ACTIONS } from './OrchestratorPlanner.js';
import { validateRepair } from './WindowsRepairContract.js';
export function toolRequestForStep(step) {
  return {
    tool: step.confirmationId ? '_system' : step.tool,
    action: step.confirmationId ? 'confirm' : step.action,
    params: step.confirmationId ? { confirmationId: step.confirmationId } : (step.params ?? {}),
    toolCallId: step.toolCallId,
    requestId: step.requestId,
    idempotencyKey: step.idempotencyKey,
  };
}

// Build a fast lookup: "tool.action" → AllowedAction
const ALLOWED_LOOKUP = new Map(ALLOWED_ACTIONS.map((a) => [`${a.tool}.${a.action}`, a]));

/**
 * Execute a single plan step.
 *
 * @param {import('./AgentState.js').PlanStep} step
 * @returns {Promise<import('./ToolEngineBridge.js').ToolResponse>}
 */
export async function executeStep(step, { signal, ownerId, admission } = {}) {
  const { tool, action, params } = step;
  if (tool === 'windowsRepair') {
    const invalid = validateRepair(action, params);
    if (invalid || admission?.taskType !== 'windows_repair_print_spooler_start')
      return {
        success: false,
        error: {
          code: 'REPAIR_ADMISSION_REQUIRED',
          message: invalid || 'Typed repair session required.',
        },
      };
    return callTool(
      { ...toolRequestForStep(step), admission },
      { signal, ownerId, humanApproved: !!step.confirmationId },
    );
  }

  // Independent security check: ensure this tool/action is in the allowed manifest.
  // The LLM plan has already been validated by OrchestratorPlanner, but a second
  // check here means even a bug in the planner cannot result in arbitrary tool calls.
  const key = `${tool}.${action}`;
  if (!ALLOWED_LOOKUP.has(key)) {
    return {
      success: false,
      error: {
        code: 'TOOL_NOT_ALLOWED',
        message:
          `Tool action '${key}' is not in the Milestone 1 allowed manifest. ` +
          `Execution blocked by AgentExecutor security check.`,
      },
    };
  }

  const invalid = validateCapability(tool, action, params ?? {});
  if (invalid)
    return {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: invalid },
    };
  return callTool(
    { ...toolRequestForStep(step), admission },
    { signal, ownerId, humanApproved: !!step.confirmationId },
  );
}
