/**
 * @fileoverview Windows Services management tool service for the Tool Engine.
 * Provides actions for listing, querying, starting, stopping, and restarting
 * Windows services via PowerShell commands.
 *
 * @module tools/services/WinServicesService
 */

import { spawn } from 'child_process';
import { BaseToolService } from '../BaseToolService.js';

/** Regex pattern for valid Windows service names. */
const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9_.\-]+$/;

/** Default timeout for PowerShell commands (ms). */
const DEFAULT_PS_TIMEOUT = 30_000;

/**
 * WinServicesService provides Windows service management as tool actions.
 * All operations are executed via PowerShell commands under the hood.
 *
 * @extends BaseToolService
 */
export class WinServicesService extends BaseToolService {
  constructor(confirmationGate) {
    super('services', confirmationGate);
  }

  /**
   * Returns the action definitions for this service.
   *
   * @returns {Object} Map of action names to their configuration.
   */
  get actions() {
    return {
      list: {
        handler: this.list.bind(this),
        schema: {},
        destructive: false,
        description: 'List all Windows services'
      },
      getStatus: {
        handler: this.getStatus.bind(this),
        schema: {
          name: { type: 'string', required: true }
        },
        destructive: false,
        description: 'Get the status of a specific Windows service'
      },
      start: {
        handler: this.start.bind(this),
        schema: {
          name: { type: 'string', required: true }
        },
        destructive: true,
        description: 'Start a Windows service'
      },
      stop: {
        handler: this.stop.bind(this),
        schema: {
          name: { type: 'string', required: true }
        },
        destructive: true,
        description: 'Stop a Windows service'
      },
      restart: {
        handler: this.restart.bind(this),
        schema: {
          name: { type: 'string', required: true }
        },
        destructive: true,
        description: 'Restart a Windows service'
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
      case 'start':
        return `Start Windows service: ${params.name}?`;
      case 'stop':
        return `Stop Windows service: ${params.name}? Dependent services may also stop.`;
      case 'restart':
        return `Restart Windows service: ${params.name}?`;
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Lists all Windows services with their name, display name, status, and start type.
   *
   * @returns {Promise<{services: Array}>}
   */
  async list() {
    const command =
      'Get-Service | Select-Object Name, DisplayName, Status, StartType | ConvertTo-Json';

    const output = await this._runPS(command);
    const services = JSON.parse(output);

    return {
      services: Array.isArray(services) ? services : [services]
    };
  }

  /**
   * Gets detailed status of a specific Windows service.
   *
   * @param {Object} params
   * @param {string} params.name - The service name.
   * @returns {Promise<Object>} Service status object.
   */
  async getStatus(params) {
    const name = this._sanitizeServiceName(params.name);

    const command =
      `Get-Service -Name '${name}' | Select-Object Name, DisplayName, Status, StartType, DependentServices, ServicesDependedOn | ConvertTo-Json`;

    const output = await this._runPS(command);
    return JSON.parse(output);
  }

  /**
   * Starts a Windows service and returns its new status.
   *
   * @param {Object} params
   * @param {string} params.name - The service name.
   * @returns {Promise<Object>} Updated service status.
   */
  async start(params) {
    const name = this._sanitizeServiceName(params.name);

    await this._runPS(`Start-Service -Name '${name}'`);

    return this.getStatus({ name });
  }

  /**
   * Stops a Windows service (with -Force) and returns its new status.
   *
   * @param {Object} params
   * @param {string} params.name - The service name.
   * @returns {Promise<Object>} Updated service status.
   */
  async stop(params) {
    const name = this._sanitizeServiceName(params.name);

    await this._runPS(`Stop-Service -Name '${name}' -Force`);

    return this.getStatus({ name });
  }

  /**
   * Restarts a Windows service and returns its new status.
   *
   * @param {Object} params
   * @param {string} params.name - The service name.
   * @returns {Promise<Object>} Updated service status.
   */
  async restart(params) {
    const name = this._sanitizeServiceName(params.name);

    await this._runPS(`Restart-Service -Name '${name}'`);

    return this.getStatus({ name });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Validates and sanitizes a Windows service name to prevent command injection.
   *
   * @param {string} name - The service name to validate.
   * @returns {string} The validated service name.
   * @throws {Error} If the service name contains invalid characters.
   * @private
   */
  _sanitizeServiceName(name) {
    if (!name || typeof name !== 'string') {
      throw new Error('Service name is required and must be a non-empty string.');
    }

    const trimmed = name.trim();

    if (!SERVICE_NAME_PATTERN.test(trimmed)) {
      throw new Error(
        `Invalid service name: "${trimmed}". ` +
        `Service names may only contain letters, digits, underscores, dots, and hyphens.`
      );
    }

    return trimmed;
  }

  /**
   * Executes a PowerShell command and returns the stdout output.
   *
   * @param {string} command - The PowerShell command to run.
   * @param {number} [timeout=30000] - Timeout in milliseconds.
   * @returns {Promise<string>} The stdout output from the command.
   * @throws {Error} If the command fails, times out, or produces no output.
   * @private
   */
  _runPS(command, timeout = DEFAULT_PS_TIMEOUT) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const proc = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', command
      ], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
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
          reject(new Error(`Failed to spawn PowerShell: ${err.message}`));
        }
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;

        if (timedOut) {
          reject(new Error(`PowerShell command timed out after ${timeout}ms: ${command}`));
          return;
        }

        if (exitCode !== 0) {
          reject(new Error(
            `PowerShell command failed (exit code ${exitCode}): ${stderr || stdout}`
          ));
          return;
        }

        resolve(stdout.trim());
      });
    });
  }
}

export default WinServicesService;

