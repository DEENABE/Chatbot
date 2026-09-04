/**
 * @module lib/portGuard
 * @description Self-healing port reclaim for THIS process's own previous
 * run — the piece the plain `node src/server.js` / `node --watch` path was
 * missing. The packaged .exe already self-heals via Electron's
 * BackendManager.ensurePortFree(), which is safe there because it only
 * runs after app.requestSingleInstanceLock() has already proven nothing
 * legitimate can be sharing the port. This module gives dev/`npm start`
 * the same property without that lock, by being safe a different way:
 * it never kills "whatever happens to be on the port" — only a process it
 * can verify, by PID file *and* OS-reported image name, was a previous run
 * of this exact script. A different app, or the packaged .exe genuinely
 * running (image name "Chanakya AI.exe", not "node.exe"), is left alone —
 * the caller's own EADDRINUSE handler still reports those clearly instead
 * of this module silently fighting a real, intentional process for the
 * port.
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';

function isOurNodeProcess(pid) {
  if (process.platform !== 'win32') return true;
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' }).trim();
    // No match at all -> tasklist prints an "INFO: No tasks..." line instead
    // of a CSV row, which correctly fails this check (nothing to reclaim).
    return /^"node\.exe"/i.test(out);
  } catch {
    return false;
  }
}

/**
 * If `pidFilePath` names a still-alive node.exe process (i.e. a previous
 * run of this script that didn't shut down cleanly), terminate its whole
 * tree before we try to bind. Safe to call unconditionally on every
 * startup — a missing/stale file is a normal no-op, not an error.
 */
export function reclaimStalePort(pidFilePath) {
  if (process.platform !== 'win32') return;
  let previousPid;
  try {
    previousPid = fs.readFileSync(pidFilePath, 'utf8').trim();
  } catch {
    return;
  }
  if (!previousPid || previousPid === String(process.pid)) return;
  if (!isOurNodeProcess(previousPid)) {
    try { fs.unlinkSync(pidFilePath); } catch { /* already gone */ }
    return;
  }
  console.log(`Reclaiming the port from a previous dev session (PID ${previousPid}, left running from an unclean shutdown)...`);
  try {
    execSync(`taskkill /PID ${previousPid} /T /F`, { stdio: 'ignore' });
  } catch {
    // Exited between the read above and here — fine, nothing left to kill.
  }
}

export function recordOwnPid(pidFilePath) {
  try { fs.writeFileSync(pidFilePath, String(process.pid)); } catch { /* non-fatal — worst case, next run can't self-heal */ }
}

export function clearOwnPid(pidFilePath) {
  try { fs.unlinkSync(pidFilePath); } catch { /* already gone, or never written */ }
}
