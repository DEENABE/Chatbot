/**
 * @module services/indictransProcess
 * @description Best-effort auto-start for the local IndicTrans2 translation
 * microservice (indictrans-service/) — treated the same way this app
 * already treats Ollama: a persistent local service, not tied to THIS
 * backend process's own lifecycle. Two things follow from that:
 *
 *   1. Never blocks or fails backend startup. A machine that hasn't done
 *      the one-time IndicTrans2 setup just gets the existing "not
 *      reachable, see README" warning (server.js's checkIndicTransHealth)
 *      — unchanged from before this module existed.
 *   2. The spawned process is detached and unref()'d, and is deliberately
 *      NOT killed when this backend restarts or exits. That matters
 *      specifically for `node --watch`: every file save restarts the
 *      backend, and re-spawning (with ~6GB of model weights taking
 *      8-10s to reload) on every single save would make active
 *      development miserable. Start it once, leave it running in the
 *      background — same tradeoff this app already accepts for Ollama,
 *      which it also never auto-starts *or* kills.
 *
 * Where the service is looked for (first folder that is complete wins; a folder is complete when it has
 * app/main.py, models/ and a Python interpreter):
 *   1. INDICTRANS_SERVICE_DIR (explicit choice, e.g. written by setup-translator.cmd)
 *   2. ../indictrans-service next to backend/ (a development checkout)
 *   3. <folder of the application exe>/translator and <that folder>/resources/translator
 *      (a portable "translator pack" copied next to an installed or unpacked app, see scripts/build-translator-pack.mjs)
 *   4. <per-user app data>/translator
 * Folders that ANY local user could create (such as C:\ProgramData) are deliberately not searched: this module runs
 * the Python interpreter it finds, so it only trusts places the signed-in person or an administrator controls.
 *
 * A pack carries its own Python (python/python.exe), so the PC needs no Python installation. A development
 * checkout keeps using its .venv exactly as before.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Same directory this app already uses for db.sqlite/uploads/etc.
const pidFilePath = path.join(path.dirname(config.dbFile), '.indictrans-service.pid');
const logFilePath = path.join(path.dirname(config.dbFile), 'indictrans.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
let ownedChild = null;

export function stopOwnedIndicTrans() {
  const child = ownedChild;
  if (!child || child.exitCode !== null) return;
  ownedChild = null;
  try {
    if (process.platform === 'win32' && Number.isSafeInteger(child.pid))
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
    else child.kill();
  } catch {
    child.kill();
  }
  try {
    if (fs.readFileSync(pidFilePath, 'utf8').trim() === String(child.pid))
      fs.unlinkSync(pidFilePath);
  } catch {
    /* No PID file or another owner. */
  }
}

const PYTHON_IN_SERVICE = {
  // A pack's own interpreter first, then a development virtualenv.
  win32: ['python/python.exe', '.venv/Scripts/python.exe'],
  other: ['python/bin/python3', '.venv/bin/python'],
};

/** Folders to look in, in order, with a human-readable reason (used in the "not found" log line). */
export function translatorCandidates({
  env = process.env,
  execPath = process.execPath,
  appDataPath = config.appDataPath,
  backendDir = backendRoot,
} = {}) {
  const list = [];
  if (env.INDICTRANS_SERVICE_DIR)
    list.push({ dir: env.INDICTRANS_SERVICE_DIR, source: 'INDICTRANS_SERVICE_DIR' });
  list.push({
    dir: path.resolve(backendDir, '..', 'indictrans-service'),
    source: 'development checkout',
  });
  if (execPath) {
    const exeDir = path.dirname(execPath);
    list.push({ dir: path.join(exeDir, 'translator'), source: 'next to the application' });
    list.push({
      dir: path.join(exeDir, 'resources', 'translator'),
      source: 'application resources',
    });
  }
  if (appDataPath)
    list.push({ dir: path.join(appDataPath, 'translator'), source: 'per-user data folder' });
  const seen = new Set();
  return list.filter(({ dir }) => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @returns {{ service: null | { dir: string, source: string, pythonExe: string, bundledPython: boolean, modelsDir: string },
 *   checked: Array<{ dir: string, source: string, missing: string }> }}
 */
export function locateTranslatorService({
  platform = process.platform,
  exists = fs.existsSync,
  ...candidateOptions
} = {}) {
  const pythons = platform === 'win32' ? PYTHON_IN_SERVICE.win32 : PYTHON_IN_SERVICE.other;
  const checked = [];
  for (const candidate of translatorCandidates(candidateOptions)) {
    const { dir } = candidate;
    const modelsDir = path.join(dir, 'models');
    if (!exists(path.join(dir, 'app', 'main.py'))) {
      checked.push({ ...candidate, missing: 'app/main.py' });
      continue;
    }
    if (!exists(modelsDir)) {
      checked.push({ ...candidate, missing: 'models' });
      continue;
    }
    const relative = pythons.find((item) => exists(path.join(dir, item)));
    if (!relative) {
      checked.push({ ...candidate, missing: 'python' });
      continue;
    }
    return {
      service: {
        ...candidate,
        pythonExe: path.join(dir, relative),
        bundledPython: relative.startsWith('python/'),
        modelsDir,
      },
      checked,
    };
  }
  return { service: null, checked };
}

const envFileSetsModelPath = (dir, readFile) => {
  try {
    return /^\s*INDICTRANS_MODEL_PATH\s*=\s*\S+/m.test(readFile(path.join(dir, '.env'), 'utf8'));
  } catch {
    return false;
  }
};

/** The exact process to start for a located service (pure: nothing is spawned here). */
export function planTranslatorLaunch(
  service,
  { serviceUrl = config.translate.serviceUrl, env = process.env, readFile = fs.readFileSync } = {},
) {
  const url = new URL(serviceUrl);
  const childEnv = { ...env };
  // A pack has no .env of the machine it was built on. An explicit setting (environment or the folder's own .env) wins.
  if (!childEnv.INDICTRANS_MODEL_PATH && !envFileSetsModelPath(service.dir, readFile))
    childEnv.INDICTRANS_MODEL_PATH = service.modelsDir;
  if (service.bundledPython) {
    // The pack must behave the same on every PC: ignore packages in the user's own Python folders and never reach
    // for the network (all three models are local).
    childEnv.PYTHONNOUSERSITE = '1';
    childEnv.HF_HUB_OFFLINE = '1';
    childEnv.TRANSFORMERS_OFFLINE = '1';
  }
  return {
    command: service.pythonExe,
    args: ['-m', 'uvicorn', 'app.main:app', '--host', url.hostname, '--port', url.port],
    cwd: service.dir,
    env: childEnv,
  };
}

async function isReachable(url, timeoutMs = 2000) {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isPythonProcessAlive(pid) {
  if (process.platform !== 'win32') return true; // best-effort elsewhere — this app ships Windows-only today
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    return /^"python\.exe"/i.test(out);
  } catch {
    return false;
  }
}

// The service's own output, kept where the app keeps its other data, so "translation unavailable" on another PC can be
// diagnosed. Best effort: if the file cannot be opened the service simply runs without a log.
function openServiceLog() {
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    try {
      if (fs.statSync(logFilePath).size > MAX_LOG_BYTES) fs.truncateSync(logFilePath, 0);
    } catch {
      /* No log yet. */
    }
    const fd = fs.openSync(logFilePath, 'a');
    fs.writeSync(fd, `\n[${new Date().toISOString()}] === translator starting ===\n`);
    return fd;
  } catch {
    return null;
  }
}

/**
 * Called once at backend startup. Safe to call on every restart — it
 * always checks reachability (and, failing that, a live previous-spawn
 * pid) before ever spawning, so repeated `node --watch` restarts during
 * active development never pile up duplicate instances or duplicate
 * ~10s model loads.
 */
export async function ensureIndicTransRunning() {
  if (process.env.INDICTRANS_AUTOSTART === '0') return;
  const serviceUrl = config.translate.serviceUrl;
  if (await isReachable(serviceUrl)) return;

  // A pid file naming a still-alive python.exe means a previous spawn —
  // quite possibly from a --watch restart moments ago — is already
  // loading its models. Never spawn a second one on top of it: that's
  // wasted work at best (another ~10s load) and a port clash inside the
  // Python process at worst. Only a dead/missing pid means starting one
  // is actually needed.
  let previousPid;
  try {
    previousPid = fs.readFileSync(pidFilePath, 'utf8').trim();
  } catch {
    // no pid file yet — nothing in flight
  }
  if (previousPid && isPythonProcessAlive(previousPid)) return;

  const { service, checked } = locateTranslatorService();
  if (!service) {
    // Not set up on this machine — server.js's own health-check warning explains what to do; this line adds where
    // the app looked, which is what matters when a packaged install is missing its translator folder.
    console.warn(
      `[translate] No translator found. Looked in: ${checked
        .map((item) => `${item.dir} (${item.source}; no ${item.missing})`)
        .join('; ')}`,
    );
    return;
  }

  const plan = planTranslatorLaunch(service, { serviceUrl });
  console.log(
    `[translate] Starting IndicTrans2 service from ${service.dir} (${service.source}${service.bundledPython ? ', bundled Python' : ''}; models take ~10s to load)...`,
  );

  const logFd = openServiceLog();
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    // On Windows a detached console program gets its own visible console window and Node then ignores windowsHide.
    // The child outlives this process anyway (Windows does not kill children), so it is simply not detached there.
    detached: false,
    stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
    windowsHide: true,
  });
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* The child holds its own copy. */
    }
  }
  ownedChild = child;
  child.on('error', (err) => {
    console.warn(`[translate] Failed to start IndicTrans2 service: ${err.message}`);
  });
  try {
    fs.writeFileSync(pidFilePath, String(child.pid));
  } catch {
    // Non-fatal — worst case, a future restart can't tell this instance
    // is already loading and may (harmlessly, if slowly) try again.
  }
  child.unref();
}
