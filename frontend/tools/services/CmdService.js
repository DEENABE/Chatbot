/**
 * @fileoverview CMD execution tool service for the Tool Engine.
 * Provides actions for running Windows Command Prompt commands
 * and batch files with configurable timeouts.
 *
 * @module tools/services/CmdService
 */

import { spawn } from 'child_process';
import path from 'path';
import { BaseToolService } from '../BaseToolService.js';

/** Default execution timeout in milliseconds. */
const DEFAULT_TIMEOUT = 30_000;

/**
 * CmdService provides Windows CMD execution as tool actions.
 *
 * @extends BaseToolService
 */
export class CmdService extends BaseToolService {
  constructor(confirmationGate) {
    super('cmd', confirmationGate);
  }

  /**
   * Returns the action definitions for this service.
   *
   * @returns {Object} Map of action names to their configuration.
   */
  get actions() {
    return {
      execute: {
        handler: this.runCmd.bind(this),
        schema: {
          command: { type: 'string', required: true, minLength: 1 },
          timeout: { type: 'number', required: false }
        },
        destructive: true,
        description: 'Execute a CMD command'
      },
      executeBatch: {
        handler: this.executeBatch.bind(this),
        schema: {
          scriptPath: { type: 'path', required: true },
          args: { type: 'array', required: false },
          timeout: { type: 'number', required: false }
        },
        destructive: true,
        description: 'Execute a batch file (.bat / .cmd)'
      }
    };
  }

  /**
   * Returns the confirmation message for destructive actions.
   *
   * @param {string} action - The action name.
   * @param {Object} params - The action parameters.
   * @returns {string|null} Confirmation message or null if not destructive.
   */
  getConfirmationMessage(action, params) {
    switch (action) {
      case 'execute':
        return `Execute CMD command: ${params.command}?`;
      case 'executeBatch':
        return `Execute batch file: ${params.scriptPath}?`;
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Executes a CMD command string.
   *
   * @param {Object} params
   * @param {string} params.command - The command to execute.
   * @param {number} [params.timeout=30000] - Timeout in milliseconds.
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, timedOut: boolean}>}
   */
  async runCmd(params) {
    const timeout = params.timeout || DEFAULT_TIMEOUT;

    return this._runCommand('cmd.exe', ['/c', params.command], { timeout });
  }

  /**
   * Executes a batch file with optional arguments.
   *
   * @param {Object} params
   * @param {string} params.scriptPath - Path to the .bat or .cmd file.
   * @param {string[]} [params.args=[]] - Arguments to pass to the batch file.
   * @param {number} [params.timeout=30000] - Timeout in milliseconds.
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, timedOut: boolean}>}
   */
  async executeBatch(params) {
    const scriptPath = path.resolve(params.scriptPath);
    const args = params.args || [];
    const timeout = params.timeout || DEFAULT_TIMEOUT;

    return this._runCommand('cmd.exe', ['/c', scriptPath, ...args], { timeout });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Spawns a child process and captures its output with timeout support.
   *
   * @param {string} cmd - The executable to run.
   * @param {string[]} args - Arguments for the executable.
   * @param {Object} options
   * @param {number} options.timeout - Timeout in milliseconds.
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, timedOut: boolean}>}
   * @private
   */
  _runCommand(cmd, args, { timeout }) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const proc = spawn(cmd, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        // Force kill after a grace period
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }, 2000);
      }, timeout);

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to spawn process: ${err.message}`));
        }
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve({ stdout, stderr, exitCode, timedOut });
        }
      });
    });
  }
}

export default CmdService;

