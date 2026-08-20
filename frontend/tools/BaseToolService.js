/**
 * @module BaseToolService
 * @description Abstract base class that all tool services extend.
 * Provides the execute → validate → confirm/run lifecycle, integrating
 * {@link InputValidator} for parameter validation and
 * {@link ConfirmationGate} for destructive-action gating.
 */

import { InputValidator } from './InputValidator.js';

/**
 * @typedef {Object} ActionConfig
 * @property {Function} handler - Async handler `(params) => Promise<*>`.
 * @property {Object<string, import('./InputValidator.js').SchemaEntry>} [schema] - Parameter validation schema.
 * @property {boolean} [destructive=false] - Whether the action requires user confirmation.
 * @property {string} description - Human-readable description of the action.
 */

/**
 * @typedef {Object} ToolError
 * @property {string} code - Machine-readable error code.
 * @property {string} message - Human-readable error message.
 * @property {Array<{field: string, message: string}>} [errors] - Validation errors (for VALIDATION_ERROR).
 */

export class BaseToolService {
  /**
   * @param {string} name - The tool name (e.g., 'file', 'powershell').
   * @param {import('./ConfirmationGate.js').ConfirmationGate} confirmationGate - Shared confirmation gate instance.
   */
  constructor(name, confirmationGate) {
    if (new.target === BaseToolService) {
      throw new Error('BaseToolService is abstract and cannot be instantiated directly');
    }

    /** @type {string} */
    this.name = name;

    /** @type {import('./ConfirmationGate.js').ConfirmationGate} */
    this.confirmationGate = confirmationGate;
  }

  /**
   * Returns the action registry for this service.
   * Subclasses **must** override this getter to define their actions.
   *
   * @returns {Object<string, ActionConfig>} Map of action names to their configurations.
   *
   * @example
   * get actions() {
   *   return {
   *     read: {
   *       handler: this._read.bind(this),
   *       schema: { path: { type: 'path', required: true } },
   *       destructive: false,
   *       description: 'Read file contents',
   *     },
   *   };
   * }
   */
  get actions() {
    return {};
  }

  /**
   * Execute a named action with the given parameters.
   *
   * Flow:
   * 1. Look up action — throw `ACTION_NOT_FOUND` if missing.
   * 2. Validate params against schema — throw `VALIDATION_ERROR` if invalid.
   * 3. If destructive, return a confirmation prompt (no execution yet).
   * 4. Otherwise, run the handler and return the result.
   *
   * @param {string} action - The action name to execute.
   * @param {Object} params - The parameters for the action.
   * @returns {Promise<{success: boolean, data?: *, needsConfirmation?: boolean, confirmationId?: string, message?: string}>}
   * @throws {ToolError} On action-not-found or validation failure.
   */
  async execute(action, params) {
    const config = this.actions[action];

    // 1. Action lookup
    if (!config) {
      const error = new Error(`Action '${action}' not found on service '${this.name}'`);
      error.code = 'ACTION_NOT_FOUND';
      throw error;
    }

    // 2. Schema validation
    if (config.schema) {
      const result = InputValidator.validate(config.schema, params);
      if (!result.valid) {
        const error = new Error(`Validation failed for '${this.name}.${action}'`);
        error.code = 'VALIDATION_ERROR';
        error.errors = result.errors;
        throw error;
      }
    }

    // 3. Destructive action — request confirmation
    if (config.destructive) {
      return this._requestConfirmation(action, params, config.description);
    }

    // 4. Non-destructive — execute immediately
    const data = await config.handler(params);
    return { success: true, data };
  }

  /**
   * Execute an action that has already been confirmed.
   * Skips the destructive check and runs the handler directly.
   *
   * @param {string} action - The action name to execute.
   * @param {Object} params - The parameters for the action.
   * @returns {Promise<{success: boolean, data: *}>}
   * @throws {ToolError} On action-not-found.
   */
  async executeConfirmed(action, params) {
    const config = this.actions[action];

    if (!config) {
      const error = new Error(`Action '${action}' not found on service '${this.name}'`);
      error.code = 'ACTION_NOT_FOUND';
      throw error;
    }

    const data = await config.handler(params);
    return { success: true, data };
  }

  /**
   * Return a list of all actions this service exposes (for introspection / help).
   *
   * @returns {Array<{action: string, description: string, destructive: boolean}>}
   */
  getActionList() {
    return Object.entries(this.actions).map(([action, config]) => ({
      action,
      description: config.description,
      destructive: !!config.destructive,
      schema: config.schema || {}
    }));
  }

  // ─── Private helpers ────────────────────────────────────────────────

  /**
   * Create a confirmation request through the gate and return
   * the prompt immediately (non-blocking).
   *
   * The metadata stored in the gate includes the tool name, action, and
   * params so the router can replay execution after the user confirms.
   *
   * A human clicking "Allow Execution" on a generic message like "Execute a
   * PowerShell command" isn't actually confirming anything — they can't see
   * what they're approving. Services that define getConfirmationMessage()
   * (PowerShellService, CmdService, FileService, WinServicesService) built a
   * params-aware prompt specifically for this; it was previously never
   * called, so the whole engine fell back to the static description no
   * matter which service raised the request. Every destructive action now
   * shows the real target (the actual command, path, or service name) to
   * the person who has to approve it.
   *
   * @param {string} action - The action name.
   * @param {Object} params - The action parameters.
   * @param {string} description - Human-readable action description (fallback).
   * @returns {{success: boolean, needsConfirmation: boolean, confirmationId: string, message: string}}
   * @private
   */
  _requestConfirmation(action, params, description) {
    const metadata = {
      tool: this.name,
      action,
      params,
    };

    const { confirmationId } = this.confirmationGate.request(metadata);

    const specific = typeof this.getConfirmationMessage === 'function'
      ? this.getConfirmationMessage(action, params)
      : null;
    const message = specific || `Action '${action}' on '${this.name}' requires confirmation: ${description}`;

    return {
      success: true,
      needsConfirmation: true,
      confirmationId,
      message,
    };
  }
}
