/**
 * @module orchestrator/ObservationHandler
 * @description Normalises a raw ToolEngine response into a structured
 * Observation object that the rest of the orchestrator loop can reason about.
 *
 * The ToolEngine returns different shapes depending on success, validation
 * errors, confirmation-required, or bridge unavailability. This module
 * absorbs all those variations into one consistent shape.
 */

/**
 * Normalise a raw ToolEngine ToolResponse into an Observation.
 *
 * @param {import('./ToolEngineBridge.js').ToolResponse} toolResponse
 * @param {number} stepIndex
 * @returns {import('./AgentState.js').Observation}
 */
export function normaliseObservation(toolResponse, stepIndex, toolCallId = null) {
  toolResponse = toolResponse && typeof toolResponse === 'object' ? toolResponse : {};
  if (toolResponse.toolCallId != null && toolResponse.toolCallId !== toolCallId) {
    toolResponse = { success: false, error: { code: 'IDENTITY_MISMATCH', message: 'Response belongs to another tool call.' } };
  }
  const now = new Date().toISOString();
  const permission=toolResponse.permission ? {decision:toolResponse.permission.decision,risk:toolResponse.permission.risk,reasonCode:toolResponse.permission.reasonCode} : null;

  // Confirmation-required case: the action is waiting for user approval.
  if (toolResponse.needsConfirmation === true) {
    return {
      stepIndex,
      toolCallId,
      success: false,
      data: null,
      error: null,
      needsConfirmation: true,
      confirmationId: toolResponse.confirmationId || null,
      confirmationExpiresAt: toolResponse.expiresAt ?? null,
      confirmationMessage: toolResponse.message || 'This action requires your confirmation.',
      approvalDetails: toolResponse.approvalDetails ?? null,
      permission,
      timestamp: now,
    };
  }

  // Error case.
  if (toolResponse.success !== true) {
    const error = toolResponse.error || { code: 'UNKNOWN_ERROR', message: 'Tool returned failure with no details.' };
    return {
      stepIndex,
      toolCallId,
      success: false,
      data: toolResponse.data ?? null,
      error: {
        code: error.code || 'UNKNOWN_ERROR',
        ...(typeof error.retryable==='boolean'?{retryable:error.retryable}:{}),
        message: error.message || 'Unknown error',
        validationErrors: error.validationErrors || null,
      },
      permission,
      needsConfirmation: false,
      confirmationId: null,
      timestamp: now,
    };
  }

  // Success case.
  return {
    stepIndex,
    toolCallId,
    success: true,
    permission,
    data: toolResponse.data ?? null,
    error: null,
    needsConfirmation: false,
    confirmationId: null,
    timestamp: now,
  };
}

/**
 * Extract a human-readable summary from an Observation for use in
 * LLM prompts (Verifier, Replanner).
 *
 * @param {import('./AgentState.js').Observation} obs
 * @param {import('./AgentState.js').PlanStep} step
 * @returns {string}
 */
export function summariseObservation(obs, step) {
  const prefix = `Step ${obs.stepIndex + 1} [${step.tool}.${step.action}]:`;

  if (obs.needsConfirmation) {
    return `${prefix} AWAITING USER CONFIRMATION (id: ${obs.confirmationId})`;
  }

  if (!obs.success) {
    const { code, message } = obs.error || {};
    return `${prefix} FAILED — ${code}: ${message}`;
  }

  // Truncate data to avoid overwhelming LLM context.
  const dataStr = JSON.stringify(obs.data);
  const truncated = dataStr.length > 800
    ? dataStr.slice(0, 800) + '…[truncated]'
    : dataStr;

  return `${prefix} SUCCESS — ${truncated}`;
}

/**
 * Build a full transcript string for Verifier and Replanner prompts.
 *
 * @param {import('./AgentState.js').PlanStep[]} steps
 * @returns {string}
 */
export function buildTranscript(steps) {
  if (!steps.length) return '(no steps executed)';

  return steps.map((step) => {
    const obs = step.observation;
    if (!obs) {
      return `Step ${step.index + 1} [${step.tool}.${step.action}]: ${step.status.toUpperCase()} (no observation)`;
    }
    return summariseObservation(obs, step);
  }).join('\n');
}
