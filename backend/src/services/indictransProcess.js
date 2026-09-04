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
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Same directory this app already uses for db.sqlite/uploads/etc.
const pidFilePath = path.join(path.dirname(config.dbFile), '.indictrans-service.pid');

function resolveServiceDir() {
  if (process.env.INDICTRANS_SERVICE_DIR) return process.env.INDICTRANS_SERVICE_DIR;
  // Portable default: indictrans-service/ is always a sibling of backend/
  // in this repo's own layout — true for every dev checkout, regardless of
  // where the repo lives on disk. NOT true for the packaged .exe, whose
  // resources/backend is copied away from the rest of the repo (by design
  // — the Python venv and ~6GB of model weights are never bundled into the
  // installer). There, this path simply won't exist and auto-start safely
  // no-ops; set INDICTRANS_SERVICE_DIR as an environment variable to opt a
  // packaged install into auto-start anyway (see indictrans-service/README.md).
  return path.resolve(backendRoot, '..', 'indictrans-service');
}

async function isReachable(url, timeoutMs = 2000) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

function isPythonProcessAlive(pid) {
  if (process.platform !== 'win32') return true; // best-effort elsewhere — this app ships Windows-only today
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' }).trim();
    return /^"python\.exe"/i.test(out);
  } catch {
    return false;
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

  const serviceDir = resolveServiceDir();
  const pythonExe = process.platform === 'win32'
    ? path.join(serviceDir, '.venv', 'Scripts', 'python.exe')
    : path.join(serviceDir, '.venv', 'bin', 'python');
  const modelsDir = path.join(serviceDir, 'models');

  if (!fs.existsSync(pythonExe) || !fs.existsSync(modelsDir)) {
    // Not set up on this machine — leave server.js's own health-check
    // warning to explain that; nothing more to do here.
    return;
  }

  const url = new URL(serviceUrl);
  console.log(`[translate] Starting IndicTrans2 service from ${serviceDir} (models take ~10s to load)...`);

  const child = spawn(
    pythonExe,
    ['-m', 'uvicorn', 'app.main:app', '--host', url.hostname, '--port', url.port],
    {
      cwd: serviceDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }
  );
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
