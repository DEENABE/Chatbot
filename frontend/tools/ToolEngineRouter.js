/**
 * @module ToolEngineRouter
 * @description Central dispatcher for the Tool Engine.
 * Routes incoming `{ tool, action, params }` requests to the appropriate
 * service, handles the confirmation flow for destructive actions, and
 * exposes an introspection API for listing all available tools and actions.
 */

import { ConfirmationGate } from './ConfirmationGate.js';

// ─── Service imports (will be implemented in separate files) ──────────
import { FileService } from './services/FileService.js';
import { PowerShellService } from './services/PowerShellService.js';
import { CmdService } from './services/CmdService.js';
import { WinServicesService } from './services/WinServicesService.js';
import { RegistryService } from './services/RegistryService.js';
import { HardwareService } from './services/HardwareService.js';
import { ProcessService } from './services/ProcessService.js';
import { NetworkService } from './services/NetworkService.js';

/**
 * @typedef {Object} ToolRequest
 * @property {string} tool - The tool name (e.g., 'file', 'powershell') or '_system' for internal commands.
 * @property {string} action - The action to perform (e.g., 'read', 'confirm').
 * @property {Object} params - Parameters for the action.
 */

/**
 * @typedef {Object} ToolResponse
 * @property {boolean} success - Whether the operation succeeded.
 * @property {*} [data] - Response payload (on success).
 * @property {boolean} [needsConfirmation] - True if the action is awaiting user confirmation.
 * @property {string} [confirmationId] - The confirmation ID (when needsConfirmation is true).
 * @property {string} [message] - Human-readable message (confirmation prompt or info).
 * @property {{code: string, message: string}} [error] - Error details (on failure).
 */

/**
 * Service registry entry — maps a tool name to its constructor.
 * @type {Array<[string, typeof import('./BaseToolService.js').BaseToolService]>}
 */
const SERVICE_REGISTRY = [
  ['file', FileService],
  ['powershell', PowerShellService],
  ['cmd', CmdService],
  ['services', WinServicesService],
  ['registry', RegistryService],
  ['hardware', HardwareService],
  ['process', ProcessService],
  ['network', NetworkService],
];

export class ToolEngineRouter {
  /**
   * Create a new ToolEngineRouter.
   * Instantiates a shared {@link ConfirmationGate} and all 8 tool services.
   */
  constructor() {
    /** @type {ConfirmationGate} */
    this.gate = new ConfirmationGate();

    /** @type {Map<string, import('./BaseToolService.js').BaseToolService>} */
    this.services = new Map();

    for (const [name, ServiceClass] of SERVICE_REGISTRY) {
      this.services.set(name, new ServiceClass(this.gate));
    }
  }

  /**
   * Dispatch a tool request to the appropriate service.
   *
   * Special handling for `_system` tool:
   * - `confirm` action: resolves a pending confirmation and executes the original action.
   *
   * @param {ToolRequest} request - The incoming tool request.
   * @param {import('electron').WebContents} [sender] - Electron WebContents for pushing
   *   confirmation-required events to the renderer process.
   * @returns {Promise<ToolResponse>} The tool response envelope.
   */
  async dispatch(request, sender) {
    try {
      const { tool, action, params } = request || {};

      // ── System commands ──────────────────────────────────────────
      if (tool === '_system') {
        if (action === 'confirm') {
          return await this._handleConfirmation(params);
        }
        if (action === 'cancel') {
          const result = this.gate.cancel(params?.confirmationId);
          return result.success
            ? { success: true }
            : ToolEngineRouter._errorEnvelope('CONFIRMATION_FAILED', result.error);
        }
        if (action === 'getTools') {
          // Return the raw tool map — the renderer maps it to the model's
          // tool schema. (This is what lets the AI actually call tools.)
          return this.getTools();
        }
        return ToolEngineRouter._errorEnvelope('UNKNOWN_SYSTEM_ACTION', `Unknown system action: '${action}'`);
      }

      // ── Look up the service ────────────────────────────────────
      const service = this.services.get(tool);
      if (!service) {
        return ToolEngineRouter._errorEnvelope(
          'TOOL_NOT_FOUND',
          `Unknown tool: '${tool}'`
        );
      }

      // ── Execute the action ─────────────────────────────────────
      const result = await service.execute(action, params);

      // If the action requires confirmation, notify the renderer
      if (result.needsConfirmation && sender && typeof sender.send === 'function') {
        sender.send('tool:confirmation-required', {
          confirmationId: result.confirmationId,
          message: result.message,
          tool,
          action,
        });
      }

      return result;
    } catch (err) {
      return ToolEngineRouter._errorFromException(err);
    }
  }

  /**
   * Return a map of all registered tools and their action lists.
   * Useful for introspection, help commands, and auto-generating UI.
   *
   * @returns {Object<string, Array<{action: string, description: string, destructive: boolean}>>}
   */
  getTools() {
    const tools = {};
    for (const [name, service] of this.services) {
      tools[name] = service.getActionList();
    }
    return tools;
  }

  // ─── Private helpers ────────────────────────────────────────────────

  /**
   * Handle a `_system.confirm` request: look up the pending confirmation,
   * confirm it through the gate, then execute the original action.
   *
   * @param {Object} params - Must contain `{ confirmationId }`.
   * @returns {Promise<ToolResponse>}
   * @private
   */
  async _handleConfirmation(params) {
    const { confirmationId } = params || {};

    if (!confirmationId) {
      return ToolEngineRouter._errorEnvelope(
        'MISSING_CONFIRMATION_ID',
        'params.confirmationId is required for _system.confirm'
      );
    }

    // Confirm through the gate — returns { success, metadata } or { success: false, error }
    const gateResult = this.gate.confirm(confirmationId);

    if (!gateResult.success) {
      return ToolEngineRouter._errorEnvelope(
        'CONFIRMATION_FAILED',
        gateResult.error
      );
    }

    const { tool, action, params: originalParams } = gateResult.metadata;

    // Look up the service and execute the confirmed action
    const service = this.services.get(tool);
    if (!service) {
      return ToolEngineRouter._errorEnvelope(
        'TOOL_NOT_FOUND',
        `Service '${tool}' not found when executing confirmed action`
      );
    }

    try {
      const result = await service.executeConfirmed(action, originalParams);
      return result;
    } catch (err) {
      return ToolEngineRouter._errorFromException(err);
    }
  }

  /**
   * Build a standardised error response envelope.
   *
   * @param {string} code - Machine-readable error code.
   * @param {string} message - Human-readable error message.
   * @returns {ToolResponse}
   * @private
   */
  static _errorEnvelope(code, message) {
    return {
      success: false,
      error: { code, message },
    };
  }

  /**
   * Convert a thrown exception into a standardised error envelope.
   *
   * @param {Error & {code?: string, errors?: Array}} err - The caught exception.
   * @returns {ToolResponse}
   * @private
   */
  static _errorFromException(err) {
    const envelope = {
      success: false,
      error: {
        code: err.code || 'INTERNAL_ERROR',
        message: err.message || 'An unexpected error occurred',
      },
    };

    // Attach validation details if present
    if (err.errors) {
      envelope.error.validationErrors = err.errors;
    }

    return envelope;
  }
}
