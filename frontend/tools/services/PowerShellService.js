/**
 * @fileoverview PowerShell execution tool service for the Tool Engine.
 * Provides actions for running PowerShell commands and scripts with
 * configurable timeouts and process management.
 *
 * @module tools/services/PowerShellService
 */

import { spawn } from 'child_process';
import path from 'path';
import { BaseToolService } from '../BaseToolService.js';
import { isBlockedCommand } from '../dangerGuard.js';

/** Default execution timeout in milliseconds. */
const DEFAULT_TIMEOUT = 30_000;

/**
 * PowerShellService provides PowerShell execution as tool actions.
 *
 * @extends BaseToolService
 */
export class PowerShellService extends BaseToolService {
  constructor(confirmationGate) {
    super('powershell', confirmationGate);
  }

  /**
   * Returns the action definitions for this service.
   *
   * @returns {Object} Map of action names to their configuration.
   */
  get actions() {
    return {
      execute: {
        handler: this.runPS.bind(this),
        schema: {
          command: { type: 'string', required: true, minLength: 1 },
          timeout: { type: 'number', required: false }
        },
        destructive: true,
        description: 'Execute a PowerShell command'
      },
      executeScript: {
        handler: this.executeScript.bind(this),
        schema: {
          scriptPath: { type: 'path', required: true },
          args: { type: 'array', required: false },
          timeout: { type: 'number', required: false }
        },
        destructive: true,
        description: 'Execute a PowerShell script file'
      },
      getVersion: {
        handler: this.getVersion.bind(this),
        schema: {},
        destructive: false,
        description: 'Get the installed PowerShell version'
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
        return `Execute PowerShell command: ${params.command}?`;
      case 'executeScript':
        return `Execute PowerShell script: ${params.scriptPath}?`;
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Executes a PowerShell command string.
   *
   * @param {Object} params
   * @param {string} params.command - The PowerShell command to execute.
   * @param {number} [params.timeout=30000] - Timeout in milliseconds.
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, timedOut: boolean}>}
   */
  async runPS(params) {
    // Checked here — the one place every execute() AND every confirmed
    // executeConfirmed() call funnels through before a process is ever
    // spawned — rather than at request time, so it can't be skipped by
    // going through the post-confirmation path. dangerGuard's own docstring
    // already claimed this ran "even after the user has confirmed the
    // action"; it didn't actually get called anywhere until now.
    if (isBlockedCommand(params.command)) {
      const error = new Error('This command is irreversible or session-disrupting and is blocked regardless of confirmation.');
      error.code = 'COMMAND_BLOCKED';
      throw error;
    }

    const timeout = params.timeout || DEFAULT_TIMEOUT;

    return this._runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', params.command
    ], { timeout });
  }

  /**
   * Executes a PowerShell script file.
   *
   * @param {Object} params
   * @param {string} params.scriptPath - Path to the .ps1 script.
   * @param {string[]} [params.args=[]] - Arguments to pass to the script.
   * @param {number} [params.timeout=30000] - Timeout in milliseconds.
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, timedOut: boolean}>}
   */
  async executeScript(params) {
    const scriptPath = path.resolve(params.scriptPath);
    const args = params.args || [];
    const timeout = params.timeout || DEFAULT_TIMEOUT;

    return this._runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      ...args
    ], { timeout });
  }

  /**
   * Retrieves the installed PowerShell version information.
   *
   * @returns {Promise<Object>} Parsed PSVersionTable object.
   */
  async getVersion() {
    const result = await this._runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command', '$PSVersionTable | ConvertTo-Json'
    ], { timeout: 10_000 });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get PowerShell version: ${result.stderr}`);
    }

    try {
      return JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(`Failed to parse PowerShell version output: ${err.message}`);
    }
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

export default PowerShellService;

