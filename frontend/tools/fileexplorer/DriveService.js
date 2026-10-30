import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { explorerError, humanSize } from './errors.js';

const execFile = promisify(execFileCallback);
// Fixed command: no model- or user-supplied text is ever interpolated into it.
const CIM_COMMAND =
  'Get-CimInstance -ClassName Win32_LogicalDisk | Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace,DriveType | ConvertTo-Json -Compress';
const TYPES = { 2: 'removable', 3: 'fixed', 4: 'network', 5: 'optical', 6: 'ramdisk' };
const withTimeout = (promise, ms, code) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(explorerError(code)), ms).unref?.()),
  ]);

/** Discovers volumes at call time. Nothing is hard-coded and nothing is scanned. */
export class DriveService {
  constructor({
    run = (file, args, options) => execFile(file, args, options),
    fsImpl = fs,
    platform = process.platform,
    env = process.env,
    commandTimeoutMs = 8000,
    probeTimeoutMs = 2500,
  } = {}) {
    Object.assign(this, { run, fsImpl, platform, env, commandTimeoutMs, probeTimeoutMs });
  }
  async #accessible(root) {
    try {
      await withTimeout(
        this.fsImpl.access(root, constants.R_OK),
        this.probeTimeoutMs,
        'PROBE_TIMEOUT',
      );
      return { accessible: true };
    } catch (error) {
      return {
        accessible: false,
        error: error.code === 'PROBE_TIMEOUT' ? 'NOT_RESPONDING' : error.code || 'UNAVAILABLE',
      };
    }
  }
  async #fromWindows() {
    const exe = path.win32.join(
      this.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const { stdout } = await this.run(
      exe,
      ['-NoProfile', '-NonInteractive', '-Command', CIM_COMMAND],
      {
        timeout: this.commandTimeoutMs,
        windowsHide: true,
        maxBuffer: 256 * 1024,
        shell: false,
        encoding: 'utf8',
      },
    );
    const parsed = JSON.parse(String(stdout).trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((disk) =>
      /^[A-Za-z]:$/.test(disk?.DeviceID || ''),
    );
  }
  async #fromProbe() {
    const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    const found = await Promise.all(
      letters.map(async (letter) => {
        const root = `${letter}:\\`;
        const probe = await this.#accessible(root);
        return probe.accessible || probe.error === 'NOT_RESPONDING' || probe.error === 'EACCES'
          ? { DeviceID: `${letter}:`, probed: true }
          : null;
      }),
    );
    return found.filter(Boolean);
  }
  async list({ signal } = {}) {
    const warnings = [];
    let disks;
    let source = 'windows-cim';
    if (this.platform === 'win32') {
      try {
        disks = await this.#fromWindows();
      } catch (error) {
        warnings.push(
          `Volume query failed (${error.code || error.message}); probed drive letters instead.`,
        );
        disks = await this.#fromProbe();
        source = 'probe';
      }
    } else {
      const root = path.parse(process.cwd()).root;
      disks = [{ DeviceID: root, DriveType: 3, probed: true }];
      source = 'posix-root';
    }
    if (signal?.aborted) throw explorerError('CANCELLED', 'The operation was cancelled.');
    const drives = await Promise.all(
      disks.map(async (disk) => {
        const root = /^[A-Za-z]:$/.test(disk.DeviceID) ? `${disk.DeviceID}\\` : disk.DeviceID;
        const probe = await this.#accessible(root);
        const total = Number.isFinite(Number(disk.Size)) ? Number(disk.Size) : null;
        const free = Number.isFinite(Number(disk.FreeSpace)) ? Number(disk.FreeSpace) : null;
        return {
          letter: /^[A-Za-z]:$/.test(disk.DeviceID) ? disk.DeviceID[0].toUpperCase() : null,
          root,
          label: disk.VolumeName || '',
          fileSystem: disk.FileSystem || null,
          type: TYPES[disk.DriveType] || 'unknown',
          totalBytes: total,
          freeBytes: free,
          total: humanSize(total),
          free: humanSize(free),
          ...probe,
        };
      }),
    );
    drives.sort((a, b) => a.root.localeCompare(b.root));
    return { drives, source, warnings };
  }
}
