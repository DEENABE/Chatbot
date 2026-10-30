import path from 'node:path';
import { app } from './app.js';
import { config } from './config.js';
import { getDb } from './db/connection.js';
import { recordOwnPid, clearOwnPid } from './lib/portGuard.js';
import { ensureIndicTransRunning, stopOwnedIndicTrans } from './services/indictransProcess.js';
import { logStartupDiagnostics, logDatabaseInitialized } from './lib/storageDiagnostics.js';
import { getHardwareProfile } from './services/gpuProfile.js';
import { listLoadedModels } from './services/ollamaService.js';

// Printed before the database is even opened, so the path is on record
// even if getDb() itself fails — "where is this trying to read/write"
// should never depend on startup succeeding.
logStartupDiagnostics();

// Initialize JSON database
getDb();
logDatabaseInitialized();

const port = config.port;

// Same directory this app already uses for db.sqlite/uploads/etc — a
// previous run's PID lives here so THIS run can tell "my own leftover
// process from an unclean shutdown" apart from anything else that might be
// on the port. See lib/portGuard.js for why this is safe to do
// unconditionally (it never touches a process it can't verify is ours).
const pidFilePath = path.join(path.dirname(config.dbFile), '.dev-server.pid');

const server = app.listen(port, config.host, () => {
  recordOwnPid(pidFilePath);
  const actualPort = server.address().port;
  if (process.env.CHANAKYA_DESKTOP_CHILD === '1')
    console.log(`CHANAKYA_BACKEND_READY ${JSON.stringify({ port: actualPort, pid: process.pid })}`);
  console.log(`Local AI assistant server running on http://${config.host}:${actualPort}`);
  console.log(
    `Chat models: discovered from local Ollama at run time${config.defaultModel ? ` (DEFAULT_MODEL=${config.defaultModel})` : ''} | Embed model: ${config.embeddingModel}`,
  );
  checkIndicTransHealth();
  // Detect this host on every launch without delaying the desktop readiness handshake.
  getHardwareProfile({ residency: listLoadedModels })
    .then((hardware) => {
      console.log(
        `Automatic hardware: ${hardware.cpu.logicalCores} CPU threads, ${Math.round(hardware.memory.totalBytes / 1024 ** 3)} GB RAM, ${hardware.gpus.map((gpu) => gpu.name).join(', ') || 'CPU-safe mode'}; Ollama placement: ${hardware.acceleration.mode}.`,
      );
    })
    .catch(() =>
      console.warn(
        'Hardware discovery is unavailable; conservative CPU-safe settings remain active.',
      ),
    );
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
        `No existing process was terminated. Select a different port or close your own previous server.\n` +
        `If you intentionally want a different port, set PORT in\n` +
        `backend/.env (or the PORT environment variable) and restart.\n`,
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
  stopOwnedIndicTrans();
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
if (process.env.CHANAKYA_DESKTOP_CHILD === '1') {
  process.stdin.resume();
  process.stdin.once('end', () => shutdown('desktop parent disconnected'));
}

// Last-resort safety net: log the real cause instead of the process dying
// silently (or hanging) with no trace of why the port never got released.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// Non-blocking readiness check for the IndicTrans2 translation service —
// mirrors the fact that Ollama itself isn't health-checked at Node startup
// either (this app fails per-request, not at boot, when an optional local
// AI backend isn't running). Never blocks the HTTP server from accepting
// requests; only affects what gets logged and when.
//
// This polls rather than checking once, because a single delayed retry
// (the previous version of this function) had a real gap: model loading
// is ~10s on a warm disk cache but can run past that on a cold one (first
// launch after a reboot, or a large first-time page-in of ~6GB across
// three checkpoints), so a fixed one-shot retry sometimes fired its
// "not reachable" warning for a service that was still legitimately
// loading and became reachable moments later — a false alarm, not a real
// failure. Polling every 5s for up to 90s removes that false-alarm window
// while still giving up (and logging plainly) if the service genuinely
// isn't running.
async function checkIndicTransHealth() {
  if (process.env.INDICTRANS_AUTOSTART === '0') return;
  await ensureIndicTransRunning();

  const pollIntervalMs = 5000;
  const maxWaitMs = 90_000;
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const response = await fetch(`${config.translate.serviceUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      console.log(
        `[translate] IndicTrans2 service reachable (device=${body.device}, models=${JSON.stringify(body.models_loaded)})`,
      );
      return;
    } catch (error) {
      if (Date.now() + pollIntervalMs >= deadline) {
        console.warn(
          `[translate] IndicTrans2 service not reachable at ${config.translate.serviceUrl} after ` +
            `${Math.round(maxWaitMs / 1000)}s (${attempt} attempts) — translation requests will fail ` +
            `until it is started. See indictrans-service/README.md. (${error.message})`,
        );
        return;
      }
      // Quiet on early attempts — a service that was just auto-started is
      // *expected* to be unreachable for the first several seconds while
      // its models load; logging that as a warning every 5s would just be
      // noise for the normal case.
      if (attempt === 1) {
        console.log(
          '[translate] Waiting for IndicTrans2 service to become reachable (loading models)...',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
