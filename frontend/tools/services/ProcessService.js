/**
 * @fileoverview Process Service for listing, inspecting, starting, and
 * terminating OS processes.  Uses PowerShell for queries and `taskkill` /
 * `child_process.spawn` for mutations.
 *
 * @module ProcessService
 */

import { execFile, spawn } from 'child_process';
import { BaseToolService } from '../BaseToolService.js';

/**
 * Service for OS-level process management.
 *
 * @extends BaseToolService
 */
export class ProcessService extends BaseToolService {
  constructor(confirmationGate) {
    super('process', confirmationGate);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** @override */
  get actions() {
    return {
      list: {
        handler: this.list.bind(this),
        schema: {
          sortBy: {
            type: 'enum',
            required: false,
            values: ['cpu', 'memory', 'name', 'pid'],
          },
          limit: { type: 'number', required: false },
        },
        destructive: false,
        description: 'List running processes with optional sorting and limit',
      },
      getProcess: {
        handler: this.getProcess.bind(this),
        schema: {
          pid: { type: 'number', required: false, integer: true },
          name: { type: 'string', required: false },
        },
        destructive: false,
        description: 'Retrieve detailed information about a specific process',
      },
      kill: {
        handler: this.kill.bind(this),
        schema: {
          pid: { type: 'number', required: true, integer: true },
          force: { type: 'boolean', required: false },
        },
        destructive: true,
        description: 'Terminate a process by PID',
      },
      startProcess: {
        handler: this.startProcess.bind(this),
        schema: {
          command: { type: 'string', required: true },
          args: { type: 'array', required: false },
          detached: { type: 'boolean', required: false },
        },
        destructive: true,
        description: 'Start a new process',
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Execute a PowerShell command and return parsed JSON.
   *
   * @param {string} command - PowerShell command string.
   * @returns {Promise<*>}
   */
  _runPS(command) {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`PowerShell error: ${stderr?.trim() || err.message}`));
            return;
          }
          try {
            const trimmed = stdout.trim();
            if (!trimmed) {
              resolve(null);
              return;
            }
            resolve(JSON.parse(trimmed));
          } catch {
            resolve(stdout.trim());
          }
        },
      );
    });
  }

  /**
   * Run `taskkill` with the given arguments.
   *
   * @param {string[]} args - Arguments for taskkill.
   * @returns {Promise<{ exitCode: number, output: string }>}
   */
  _runTaskkill(args) {
    return new Promise((resolve, reject) => {
      execFile('taskkill', args, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          // taskkill returns non-zero on failure but we still want the code
          if (err.code !== undefined) {
            resolve({ exitCode: err.code, output: stderr?.trim() || err.message });
            return;
          }
          reject(new Error(`taskkill error: ${stderr?.trim() || err.message}`));
          return;
        }
        resolve({ exitCode: 0, output: stdout.trim() });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  /**
   * List running processes.
   *
   * @param {{ sortBy?: string, limit?: number }} params
   * @returns {Promise<{ processes: Array, total: number }>}
   */
  async list(params = {}) {
    const { sortBy, limit = 50 } = params;

    const raw = await this._runPS(
      'Get-Process | Select-Object Id, ProcessName, CPU, WorkingSet64, Path, StartTime | ConvertTo-Json',
    );

    let processes = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    const total = processes.length;

    // Normalise field names for consistent output
    processes = processes.map((p) => ({
      pid: p.Id,
      name: p.ProcessName,
      cpu: p.CPU ?? 0,
      memoryBytes: p.WorkingSet64 ?? 0,
      path: p.Path ?? null,
      startTime: p.StartTime ?? null,
    }));

    // Sort
    if (sortBy) {
      const key =
        sortBy === 'cpu' ? 'cpu'
        : sortBy === 'memory' ? 'memoryBytes'
        : sortBy === 'name' ? 'name'
        : 'pid';

      processes.sort((a, b) => {
        if (key === 'name') {
          return (a.name || '').localeCompare(b.name || '');
        }
        // Descending for cpu / memory, ascending for pid
        return key === 'pid'
          ? (a[key] ?? 0) - (b[key] ?? 0)
          : (b[key] ?? 0) - (a[key] ?? 0);
      });
    }

    // Limit
    const cappedLimit = Math.max(1, Math.min(limit, processes.length));
    processes = processes.slice(0, cappedLimit);

    return { processes, total };
  }

  /**
   * Get detailed information about a specific process.
   *
   * @param {{ pid?: number, name?: string }} params - At least one must be provided.
   * @returns {Promise<Object>}
   */
  async getProcess(params) {
    const { pid, name } = params;

    if (pid == null && (!name || !name.trim())) {
      throw new Error('At least one of "pid" or "name" must be provided');
    }

    let psCommand;
    if (pid != null) {
      psCommand = `Get-Process -Id ${Number(pid)} -ErrorAction Stop | Select-Object Id, ProcessName, CPU, WorkingSet64, VirtualMemorySize64, HandleCount, Threads, Path, StartTime, Responding | ConvertTo-Json`;
    } else {
      // Sanitise process name: allow only word characters, dots, dashes
      const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '');
      psCommand = `Get-Process -Name '${safeName}' -ErrorAction Stop | Select-Object Id, ProcessName, CPU, WorkingSet64, VirtualMemorySize64, HandleCount, Threads, Path, StartTime, Responding | ConvertTo-Json`;
    }

    const raw = await this._runPS(psCommand);

    if (raw == null) {
      throw new Error(`Process not found (pid=${pid}, name=${name})`);
    }

    const list = Array.isArray(raw) ? raw : [raw];
    const mapped = list.map((p) => ({
      pid: p.Id,
      name: p.ProcessName,
      cpu: p.CPU ?? 0,
      memoryBytes: p.WorkingSet64 ?? 0,
      virtualMemoryBytes: p.VirtualMemorySize64 ?? 0,
      handleCount: p.HandleCount ?? 0,
      threadCount: p.Threads?.length ?? 0,
      path: p.Path ?? null,
      startTime: p.StartTime ?? null,
      responding: p.Responding ?? null,
    }));

    return mapped.length === 1 ? mapped[0] : { processes: mapped };
  }

  /**
   * Terminate a process by PID.
   *
   * @param {{ pid: number, force?: boolean }} params
   * @returns {Promise<{ killed: number, exitCode: number }>}
   */
  async kill(params) {
    const { pid, force = false } = params;

    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error('pid must be a positive integer');
    }

    const args = ['/PID', String(pid)];
    if (force) {
      args.push('/F');
    }

    const { exitCode } = await this._runTaskkill(args);
    return { killed: pid, exitCode };
  }

  /**
   * Start a new process.
   *
   * @param {{ command: string, args?: string[], detached?: boolean }} params
   * @returns {Promise<{ pid: number, command: string }>}
   */
  async startProcess(params) {
    const { command, args = [], detached = false } = params;

    if (!command || typeof command !== 'string') {
      throw new Error('command must be a non-empty string');
    }

    const spawnOpts = {
      windowsHide: true,
      detached: Boolean(detached),
      stdio: detached ? 'ignore' : 'pipe',
    };

    const child = spawn(command, args, spawnOpts);

    if (detached) {
      child.unref();
    }

    return { pid: child.pid, command };
  }
}

export default ProcessService;

