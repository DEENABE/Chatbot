import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getBackendPath, isPacked } from '../utils/pathHelper.js';
import { logger } from '../utils/logger.js';
import { prepareRuntimeStorage } from '../utils/runtimeStorage.js';
import { setBackendEndpoint, setApiClientKey } from '../utils/runtimeEndpoint.js';
import { redactDiagnostics } from '../utils/redactDiagnostics.js';

let backendProcess = null;
let stopping = false;
let logStream = null;

/** Own backend always binds an OS-assigned loopback port. Never kill a port owner. */
export async function startBackend(app, toolBridge) {
  if (backendProcess && backendProcess.exitCode === null)
    throw new Error('The local backend is already starting or running.');
  stopping = false;
  const serverPath = getBackendPath();
  const apiClientKey = randomBytes(32).toString('hex');
  setApiClientKey(apiClientKey);
  const env = {
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    CHANAKYA_DESKTOP_CHILD: '1',
    CHANAKYA_CLIENT_SECRET: apiClientKey,
    ELECTRON_RUN_AS_NODE: '1',
  };
  delete env.TOOL_ENGINE_INTERNAL_URL;
  delete env.TOOL_ENGINE_SESSION_SECRET;
  if (toolBridge) {
    env.TOOL_ENGINE_INTERNAL_URL = toolBridge.url;
    env.TOOL_ENGINE_SESSION_SECRET = toolBridge.secret;
  }
  if (isPacked) {
    env.NODE_ENV = 'production';
    const runtime = await prepareRuntimeStorage(app.getPath('userData'), [
      path.join(app.getPath('userData'), 'storage'),
      path.join(process.resourcesPath, 'backend', 'storage'),
    ]);
    env.APP_DATA_PATH = runtime.dataRoot;
    env.FRONTEND_DIST_PATH = path.join(app.getAppPath(), 'dist');
    if (runtime.migrated) logger.log('Legacy local data copied to the per-user data directory.');
  }
  env.NODE_PATH = isPacked
    ? path.join(process.resourcesPath, 'backend', 'node_modules')
    : path.resolve(path.dirname(serverPath), '..', '..', 'node_modules');
  const child = spawn(process.execPath, [serverPath], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env,
    cwd: path.resolve(path.dirname(serverPath), '..'),
  });
  backendProcess = child;
  const logPath = path.join(app.getPath('userData'), 'backend.log');
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.on('error', (error) => logger.warn('Backend diagnostic log unavailable:', error.code));
  logStream.write(`\n[${new Date().toISOString()}] === backend starting ===\n`);
  let ready = false;
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('The local service did not become ready in time. See diagnostics.'));
      killBackend();
    }, 30000);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.stdout.on('data', (data) => {
      logStream?.write(`[STDOUT] ${redactDiagnostics(data, [toolBridge?.secret, apiClientKey])}`);
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      // A malformed/unbounded child log cannot grow the readiness buffer forever.
      if (buffer.length > 65536) buffer = buffer.slice(-65536);
      for (const line of lines) {
        if (!line.startsWith('CHANAKYA_BACKEND_READY ')) continue;
        try {
          const endpoint = JSON.parse(line.slice('CHANAKYA_BACKEND_READY '.length));
          if (endpoint.pid !== child.pid || ready) continue;
          const apiBaseUrl = setBackendEndpoint(endpoint.port);
          ready = true;
          clearTimeout(timer);
          resolve({ process: child, apiBaseUrl });
        } catch {
          fail(new Error('The local service returned an invalid startup response.'));
          killBackend();
        }
      }
    });
    child.stderr.on('data', (data) =>
      logStream?.write(`[STDERR] ${redactDiagnostics(data, [toolBridge?.secret, apiClientKey])}`),
    );
    child.once('error', (error) =>
      fail(new Error(`Could not start the local service (${error.code || 'process error'}).`)),
    );
    child.once('exit', (code) => {
      logStream?.end(`[${new Date().toISOString()}] backend exited (${code})\n`);
      logStream = null;
      if (backendProcess === child) backendProcess = null;
      if (!ready)
        fail(new Error(`The local service exited during startup (${code}). See diagnostics.`));
      else if (!stopping) logger.error('The local backend exited unexpectedly:', code);
    });
  });
}

export function killBackend() {
  const child = backendProcess;
  if (!child || child.exitCode !== null) return;
  stopping = true;
  const pid = child.pid;
  if (process.platform === 'win32' && Number.isSafeInteger(pid) && pid > 0) {
    try {
      // Only a child created by this manager; no port/PID-file lookup is used.
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000,
      });
    } catch {
      child.kill();
    }
  } else child.kill();
}
