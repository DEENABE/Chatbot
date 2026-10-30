import fs from 'node:fs';
import path from 'node:path';

/**
 * Crash diagnostics for the packaged app. Before this, Electron-side failures only
 * went to console.log, which a packaged Windows app has nowhere to show: the window
 * just vanished with nothing in backend.log.
 *
 * - Writes every main-process exception, renderer crash, hang and GPU/utility
 *   process death to <userData>/electron.log.
 * - Reloads the window when the renderer dies instead of leaving a dead window.
 * - When the GPU process dies (a laptop GPU shared with a large Ollama model runs
 *   out of VRAM), the next launch turns hardware acceleration off. Delete
 *   <userData>/gpu-safe-mode or set CHANAKYA_GPU=on to turn it back on;
 *   CHANAKYA_GPU=off forces it off.
 */
const SAFE_MODE_FILE = 'gpu-safe-mode';

const logFile = (app) => path.join(app.getPath('userData'), 'electron.log');

export function crashLog(app, ...parts) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((part) =>
      part instanceof Error
        ? part.stack || part.message
        : typeof part === 'string'
          ? part
          : JSON.stringify(part),
    )
    .join(' ')}\n`;
  try {
    const file = logFile(app);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Keep the log small: start over past 2 MB.
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.writeFileSync(file, '');
    fs.appendFileSync(file, line);
  } catch {
    /* Logging must never be the thing that crashes the app. */
  }
  console.error('[electron CRASH]', line.trim());
}

/** Must run before app 'ready'. */
export function applyGpuSafeMode(app) {
  const choice = String(process.env.CHANAKYA_GPU || '').toLowerCase();
  let safe = choice === 'off';
  if (!safe && choice !== 'on') {
    try {
      safe = fs.existsSync(path.join(app.getPath('userData'), SAFE_MODE_FILE));
    } catch {
      safe = false;
    }
  }
  if (safe) {
    app.disableHardwareAcceleration();
    crashLog(app, 'Hardware acceleration is off (GPU safe mode).');
  }
  return safe;
}

export function installCrashGuard(app, { getWindow } = {}) {
  process.on('uncaughtException', (error) => crashLog(app, 'uncaughtException:', error));
  process.on('unhandledRejection', (reason) => crashLog(app, 'unhandledRejection:', reason));

  const reloads = [];
  app.on('render-process-gone', (_event, webContents, details) => {
    crashLog(app, 'renderer gone:', details);
    if (details?.reason === 'clean-exit') return;
    const window = getWindow?.();
    if (!window || window.isDestroyed() || window.webContents !== webContents) return;
    // Reload at most 3 times a minute so a crash loop cannot spin forever.
    const now = Date.now();
    while (reloads.length && now - reloads[0] > 60000) reloads.shift();
    if (reloads.length >= 3) {
      crashLog(app, 'renderer keeps crashing; not reloading again.');
      return;
    }
    reloads.push(now);
    setTimeout(() => {
      if (!window.isDestroyed()) window.webContents.reload();
    }, 1000);
  });

  app.on('child-process-gone', (_event, details) => {
    crashLog(app, 'child process gone:', details);
    if (details?.type === 'GPU' && details.reason !== 'clean-exit') {
      try {
        fs.writeFileSync(
          path.join(app.getPath('userData'), SAFE_MODE_FILE),
          `GPU process ${details.reason} at ${new Date().toISOString()}\n`,
        );
        crashLog(app, 'GPU safe mode will be used from the next launch.');
      } catch {
        /* ignore */
      }
    }
  });

  app.on('browser-window-created', (_event, window) => {
    window.on('unresponsive', () => crashLog(app, 'window unresponsive'));
    window.on('responsive', () => crashLog(app, 'window responsive again'));
    window.webContents.on('preload-error', (_e, preloadPath, error) =>
      crashLog(app, 'preload error:', preloadPath, error),
    );
  });
}
