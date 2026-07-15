import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { dialog } from 'electron';
import { getBackendPath, isPacked } from '../utils/pathHelper.js';
import { logger } from '../utils/logger.js';

let backendProcess = null;

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
