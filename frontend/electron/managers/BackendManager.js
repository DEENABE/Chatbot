import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { dialog } from 'electron';
import { getBackendPath, isPacked } from '../utils/pathHelper.js';
import { logger } from '../utils/logger.js';

let backendProcess = null;

/**
 * Terminate whatever is already listening on `port`, if anything.
 *
 * Why this exists: startup used to just probe the health endpoint and, if
 * anything answered, silently reuse it instead of spawning our own backend.
 * That let an orphaned backend from a PREVIOUS launch — e.g. one whose
 * Electron GUI process was killed externally, leaving its spawned backend
 * child running — keep serving every future launch indefinitely, even
 * across full rebuilds, because nothing ever verified it was actually
 * running the current build's code. One real instance of this: an orphaned
 * pre-migration backend kept answering on 3001 for hours, still reading the
 * old JSON-file "database" instead of real SQLite, so accounts registered
 * against the current build were invisible to it and vice versa — same
 * symptom as a genuine password mismatch, but nothing to do with hashing.
 *
 * With the single-instance lock in main.js, by the time this runs we are
 * always the sole legitimate instance — so anything already on this port is
 * by definition a leftover, never a peer to cooperate with.
 */
export function ensurePortFree(port) {
  if (process.platform !== 'win32') {
    // This app currently ships Windows-only (electron-builder --win); a
    // cross-platform equivalent (lsof, etc.) isn't needed until that changes.
    return;
  }
  try {
    const output = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' });
    const pids = new Set();
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.includes(`:${port} `) && !trimmed.includes(`:${port}\t`)) continue;
      const match = trimmed.match(/LISTENING\s+(\d+)\s*$/);
      if (match) pids.add(match[1]);
    }
    for (const pid of pids) {
      if (pid === String(process.pid)) continue; // never self-kill
      logger.warn(`Port ${port} was already held by PID ${pid} (leftover from a previous run) — terminating it before starting a fresh backend.`);
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      } catch {
        // Already exited, or we lack permission — either way, the upcoming
        // spawn will surface a clear EADDRINUSE if the port is still held.
      }
    }
  } catch {
    // netstat/parsing failing here just means we couldn't confirm the port
    // is free — not worth blocking startup over; proceed as before.
  }
}

export function startBackend(app) {
  const serverPath = getBackendPath();
  const env = { ...process.env };

  if (isPacked) {
    env.NODE_ENV = 'production';
    env.APP_DATA_PATH = app.getPath('userData');
  }

  // Unified Node Environment loading:
  // Execute via Electron's own executable as Node.js process using ELECTRON_RUN_AS_NODE=1
  env.ELECTRON_RUN_AS_NODE = '1';
  
  // Resolve the BACKEND's own dependencies. When packed they live in
  // resources/backend/node_modules (bundled by scripts/prepare-backend.cjs).
  const appNodeModules = isPacked
    ? path.join(process.resourcesPath, 'backend', 'node_modules')
    : path.join(path.resolve(path.dirname(serverPath), '..', '..', 'frontend'), 'node_modules') + path.delimiter + path.resolve(path.dirname(serverPath), '..');
  env.NODE_PATH = appNodeModules;

  const cmd = process.execPath;
  const args = [serverPath];

  logger.log(`Spawning backend at path: ${serverPath}`);
  backendProcess = spawn(cmd, args, {
    shell: false,
    stdio: 'pipe',
    env,
    cwd: isPacked
      ? path.join(process.resourcesPath, 'backend')
      : path.resolve(path.dirname(serverPath), '..')
  });

  const logPath = path.join(app.getPath('userData'), 'backend.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });

  backendProcess.stdout?.on('data', (data) => {
    const text = data.toString();
    console.log(`[backend] ${text.trim()}`);
    logStream.write(`[STDOUT] ${text}`);
  });

  backendProcess.stderr?.on('data', (data) => {
    const text = data.toString();
    console.error(`[backend] ${text.trim()}`);
    logStream.write(`[STDERR] ${text}`);
  });

  backendProcess.on('error', (err) => {
    logger.error('Failed to start backend:', err.message);
    dialog.showErrorBox('Failed to Start Backend', `Could not launch backend process: ${err.message}`);
  });

  backendProcess.on('exit', (code) => {
    logger.log(`Backend exited with code ${code}`);
    if (code !== 0 && code !== null) {
      dialog.showErrorBox(
        'Backend Server Error',
        `The backend process exited unexpectedly with code ${code}.\nThis usually happens if port 3001 is already in use by another process.`
      );
    }
  });

  return backendProcess;
}

export function killBackend() {
  if (backendProcess && !backendProcess.killed) {
    logger.log('Terminating backend process...');
    backendProcess.kill();
    backendProcess = null;
  }
}
