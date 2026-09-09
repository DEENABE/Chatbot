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

// The pid file's own path is shared per-machine (same storage directory
// regardless of PORT — see server.js), so a bare "is this PID alive and a
// node.exe" check isn't enough by itself: running a SECOND instance on a
// DIFFERENT port (e.g. a one-off test on PORT=13005 while the real dev
// server is still legitimately running on 3001) would otherwise read the
// real server's pid, see it's alive, see it's node.exe, and kill it —
// even though it was never actually competing for the port this instance
// is about to bind. Confirmed this exact failure mode happened once during
// testing. The fix: only ever reclaim a pid that is *itself* the one
// LISTENING on the specific port we're about to bind — verified via
// netstat, not assumed from the file alone.
function isListeningOnPort(pid, port) {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.includes(`:${port} `) && !trimmed.includes(`:${port}\t`)) continue;
      if (!/LISTENING/.test(trimmed)) continue;
      if (trimmed.trim().endsWith(` ${pid}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * If `pidFilePath` names a still-alive node.exe process that is ITSELF
 * listening on `port` (i.e. a previous run of this script, on this same
 * port, that didn't shut down cleanly), terminate its whole tree before we
 * try to bind. Safe to call unconditionally on every startup — a missing,
 * stale, or port-mismatched file is a normal no-op, not an error.
 */
export function reclaimStalePort(pidFilePath, port) {
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
  if (!isListeningOnPort(previousPid, port)) {
    // Alive, and a node.exe — but not actually on the port we care about
    // (e.g. someone's other Node process, or an instance intentionally
    // running on a different port). Never touch it.
    return;
  }
  console.log(`Reclaiming port ${port} from a previous dev session (PID ${previousPid}, left running from an unclean shutdown)...`);
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
