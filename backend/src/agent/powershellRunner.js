/**
 * @module agent/powershellRunner
 * @description Backend-native PowerShell executor for the autonomous agent.
 * Self-contained (no Electron dependency) so the whole agent loop can run
 * headless from the API process or the CLI test harness.
 */

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT = 60_000;
const MAX_OUTPUT_CHARS = 6_000;

function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[output truncated, ${text.length - MAX_OUTPUT_CHARS} more chars]`;
}

/**
 * Run a single PowerShell command and capture its output.
 *
 * @param {string} command - The PowerShell command to execute.
 * @param {Object} [options]
 * @param {number} [options.timeout=60000] - Kill the process after this many ms.
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, timedOut: boolean}>}
 */
export function runPowerShell(command, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
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
      if (!settled) {
        settled = true;
        resolve({
          stdout: truncate(stdout.trim()),
          stderr: truncate(stderr.trim()),
          exitCode,
          timedOut,
        });
      }
    });
  });
}

export default runPowerShell;
