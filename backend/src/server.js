import path from 'node:path';
import { app } from './app.js';
import { config } from './config.js';
import { getDb } from './db/connection.js';
import { reclaimStalePort, recordOwnPid, clearOwnPid } from './lib/portGuard.js';
import { ensureIndicTransRunning } from './services/indictransProcess.js';

// Initialize JSON database
getDb();

const port = config.port;

// Same directory this app already uses for db.sqlite/uploads/etc — a
// previous run's PID lives here so THIS run can tell "my own leftover
// process from an unclean shutdown" apart from anything else that might be
// on the port. See lib/portGuard.js for why this is safe to do
// unconditionally (it never touches a process it can't verify is ours).
const pidFilePath = path.join(path.dirname(config.dbFile), '.dev-server.pid');
reclaimStalePort(pidFilePath);

const server = app.listen(port, config.host, () => {
  recordOwnPid(pidFilePath);
  console.log(`Local AI assistant server running on http://${config.host}:${port}`);
  console.log(`Default model: ${config.defaultModel} | Embed model: ${config.embeddingModel}`);
  checkIndicTransHealth();
});

// EADDRINUSE is the exact "port already in use" failure this whole file
// exists to handle clearly. Without this listener, Node's default behavior
// is to throw an uncaught 'error' event and crash with a stack trace that
// never says WHAT is on the port or how to find out — the #1 cause of the
// confusing "sometimes npm run dev just doesn't start" experience when an
// old `node --watch` process from a previous terminal, or a second dev
// session, is still holding the port.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${port} is already in use on ${config.host} — this backend cannot start.\n\n` +
        `reclaimStalePort() already checked for (and would have closed) a leftover instance of\n` +
        `this app's own dev server, so this is something else — most likely the packaged\n` +
        `Chanakya AI.exe is currently running, or another program is using this port.\n` +
        `To find out what and stop it on Windows:\n\n` +
        `  netstat -ano | findstr :${port}          (last column is the PID)\n` +
        `  tasklist /FI "PID eq <that PID>"          (confirm what it actually is first)\n` +
        `  taskkill /PID <that PID> /F\n\n` +
        `Then re-run "npm run dev". If you intentionally want a different port, set PORT in\n` +
        `backend/.env (or the PORT environment variable) and restart.\n`
    );
    process.exitCode = 1;
    return;
  }
  console.error('Server failed to start:', error);
  process.exitCode = 1;
});

// Graceful shutdown: let in-flight requests finish (server.close() stops
// accepting new connections but waits for existing ones) instead of the
// process vanishing mid-request. Verified this actually fires for Ctrl+C in
// an interactive terminal — Windows wires that specific case through to a
// real 'SIGINT' event. It's a best-effort courtesy elsewhere, not the fix
// for port conflicts: Windows has no true POSIX signals, so a kill sent
// from another process (task manager, `node --watch`'s own restart,
// taskkill, this app's ensurePortFree) terminates the process immediately
// regardless of any handler here. That's fine for port availability
// specifically — confirmed empirically that Windows releases a listening
// socket the instant its owning process dies, graceful or not, so the next
// instance can always bind right away either way.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down (releasing port ${port})...`);
  const forceExitTimer = setTimeout(() => {
    console.warn('Graceful shutdown timed out after 5s — forcing exit.');
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();
  clearOwnPid(pidFilePath);
  server.close((err) => {
    clearTimeout(forceExitTimer);
    if (err) {
      console.error('Error while closing server:', err);
      process.exit(1);
    }
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Last-resort safety net: log the real cause instead of the process dying
// silently (or hanging) with no trace of why the port never got released.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// One-time, non-blocking, non-fatal check that the IndicTrans2 translation
// service is reachable — mirrors the fact that Ollama itself isn't
// health-checked at Node startup either (this app fails per-request, not
// at boot, when an optional local AI backend isn't running). Translation
// requests will simply fail with a clear error until the service is up;
// this only saves a trip to the logs to find out why.
async function checkIndicTransHealth(isRetry = false) {
  if (!isRetry) await ensureIndicTransRunning();
  try {
    const response = await fetch(`${config.translate.serviceUrl}/health`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    console.log(`[translate] IndicTrans2 service reachable (device=${body.device}, models=${JSON.stringify(body.models_loaded)})`);
  } catch (error) {
    if (!isRetry) {
      // A just-auto-started service takes ~10s to load its models — the
      // 3s probe above almost always lands before that finishes. One
      // delayed follow-up avoids logging a misleading "not started"
      // warning for a service that's actually mid-startup; this retry
      // itself never spawns anything (ensureIndicTransRunning already ran
      // above), so it costs nothing if IndicTrans2 genuinely isn't set up.
      setTimeout(() => checkIndicTransHealth(true), 12_000).unref();
      return;
    }
    console.warn(
      `[translate] IndicTrans2 service not reachable at ${config.translate.serviceUrl} — ` +
        `translation requests will fail until it is started. See indictrans-service/README.md. (${error.message})`
    );
  }
}
