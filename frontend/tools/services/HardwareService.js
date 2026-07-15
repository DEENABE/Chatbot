/**
 * @fileoverview Hardware Service for system hardware information.
 * Combines the Node.js `os` module with PowerShell `Get-CimInstance` queries
 * to provide comprehensive hardware details.  All actions are read-only.
 *
 * @module HardwareService
 */

import os from 'os';
import { execFile } from 'child_process';
import { BaseToolService } from '../BaseToolService.js';

/**
 * Service providing read-only hardware and system information.
 *
 * @extends BaseToolService
 */
export class HardwareService extends BaseToolService {
  constructor(confirmationGate) {
    super('hardware', confirmationGate);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** @override */
  get actions() {
    return {
      systemInfo: {
        handler: this.systemInfo.bind(this),
        schema: {},
        destructive: false,
        description: 'Retrieve general system information (hostname, OS, CPU, memory)',
      },
      cpuUsage: {
        handler: this.cpuUsage.bind(this),
        schema: {},
        destructive: false,
        description: 'Measure current CPU usage over a 1-second sampling interval',
      },
      memoryUsage: {
        handler: this.memoryUsage.bind(this),
        schema: {},
        destructive: false,
        description: 'Return current system memory utilisation',
      },
      diskInfo: {
        handler: this.diskInfo.bind(this),
        schema: {},
        destructive: false,
        description: 'List logical disk drives with capacity and free space',
      },
      gpuInfo: {
        handler: this.gpuInfo.bind(this),
        schema: {},
        destructive: false,
        description: 'List GPU adapters and driver information',
      },
      batteryInfo: {
        handler: this.batteryInfo.bind(this),
        schema: {},
        destructive: false,
        description: 'Retrieve battery status (laptops / tablets)',
      },
      networkAdapters: {
        handler: this.networkAdapters.bind(this),
        schema: {},
        destructive: false,
        description: 'List active network adapters with IP configuration',
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Execute a PowerShell command and return its parsed JSON output.
   *
   * @param {string} command - PowerShell command string.
   * @returns {Promise<*>} Parsed JSON result.
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
            // Return raw text when JSON parsing fails
            resolve(stdout.trim());
          }
        },
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  /**
   * Gather general system information.
   *
   * @returns {Promise<Object>} System details.
   */
  async systemInfo() {
    const cpus = os.cpus();
    const userInfo = os.userInfo();

    return {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptime: os.uptime(),
      cpuModel: cpus[0]?.model ?? 'unknown',
      cpuCores: cpus.length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      userInfo: {
        username: userInfo.username,
        homedir: userInfo.homedir,
      },
    };
  }

  /**
   * Measure CPU usage over a 1-second interval.
   *
   * @returns {Promise<{ usagePercent: number, perCore: Array<{ core: number, usagePercent: number }> }>}
   */
  async cpuUsage() {
    /**
     * Snapshot current CPU times.
     * @returns {{ idle: number, total: number }[]}
     */
    const snapshot = () =>
      os.cpus().map((cpu) => {
        const { user, nice, sys, idle, irq } = cpu.times;
        const total = user + nice + sys + idle + irq;
        return { idle, total };
      });

    const start = snapshot();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const end = snapshot();
    let totalIdle = 0;
    let totalDelta = 0;

    const perCore = start.map((s, i) => {
      const e = end[i];
      const idleDelta = e.idle - s.idle;
      const totalD = e.total - s.total;
      totalIdle += idleDelta;
      totalDelta += totalD;
      const usage = totalD === 0 ? 0 : ((totalD - idleDelta) / totalD) * 100;
      return { core: i, usagePercent: Math.round(usage * 100) / 100 };
    });

    const overall =
      totalDelta === 0
        ? 0
        : ((totalDelta - totalIdle) / totalDelta) * 100;

    return {
      usagePercent: Math.round(overall * 100) / 100,
      perCore,
    };
  }

  /**
   * Return current memory usage statistics.
   *
   * @returns {Promise<{ total: number, free: number, used: number, usagePercent: number }>}
   */
  async memoryUsage() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const usagePercent = Math.round((used / total) * 10000) / 100;

    return { total, free, used, usagePercent };
  }

  /**
   * List logical disk drives.
   *
   * @returns {Promise<{ drives: Array }>}
   */
  async diskInfo() {
    const raw = await this._runPS(
      'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, VolumeName, FileSystem, Size, FreeSpace | ConvertTo-Json',
    );

    const drives = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    return { drives };
  }

  /**
   * List GPU adapters.
   *
   * @returns {Promise<{ gpus: Array }>}
   */
  async gpuInfo() {
    const raw = await this._runPS(
      'Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterRAM, VideoProcessor | ConvertTo-Json',
    );

    const gpus = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    return { gpus };
  }

  /**
   * Retrieve battery status information.
   *
   * @returns {Promise<{ battery: Object|null, message?: string }>}
   */
  async batteryInfo() {
    const raw = await this._runPS(
      'Get-CimInstance Win32_Battery | Select-Object Name, EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json',
    );

    if (raw == null || (Array.isArray(raw) && raw.length === 0)) {
      return { battery: null, message: 'No battery detected' };
    }

    return { battery: Array.isArray(raw) ? raw : [raw] };
  }

  /**
   * List active network adapters with IP configuration.
   *
   * @returns {Promise<{ adapters: Array }>}
   */
  async networkAdapters() {
    const raw = await this._runPS(
      'Get-CimInstance Win32_NetworkAdapterConfiguration | Where-Object { $_.IPEnabled } | Select-Object Description, MACAddress, IPAddress, DefaultIPGateway, DHCPEnabled | ConvertTo-Json',
    );

    const adapters = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    return { adapters };
  }
}

export default HardwareService;

