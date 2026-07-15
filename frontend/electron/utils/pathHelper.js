import path from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Since pathHelper.js is in electron/utils, root of frontend is ../../
export const rootDir = path.resolve(__dirname, '..', '..');

export const isPacked = app.isPackaged;

export function getBackendPath() {
  if (isPacked) {
    return path.join(process.resourcesPath, 'backend', 'src', 'server.js');
  }
  return path.join(rootDir, '..', 'backend', 'src', 'server.js');
}

export function getWakewordScriptPath() {
  if (isPacked) {
    return path.join(process.resourcesPath, 'backend', 'scripts', 'wakeword.ps1');
  }
  return path.join(rootDir, '..', 'backend', 'scripts', 'wakeword.ps1');
}

export function getPreloadPath() {
  return path.join(rootDir, 'electron', 'preload.cjs');
}
