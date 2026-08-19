import { app, session } from 'electron';
import * as WindowManager from './managers/WindowManager.js';
import * as BackendManager from './managers/BackendManager.js';
import * as WakewordManager from './managers/WakewordManager.js';
import * as ClipboardManager from './managers/ClipboardManager.js';
import * as ShortcutManager from './managers/ShortcutManager.js';
import { waitForBackend } from './services/BackendHealth.js';
import { HEALTH_CHECK_URL, BACKEND_PORT } from './utils/constants.js';
import { logger } from './utils/logger.js';

// IPC registration
import { registerWindowIPCHandlers } from './ipc/window.ipc.js';
import { registerSystemIPCHandlers } from './ipc/system.ipc.js';
import { registerCaptureIPCHandlers } from './ipc/capture.ipc.js';
import { registerToolIPCHandlers } from './ipc/tool.ipc.js';
import { registerAuthIPCHandlers } from './ipc/auth.ipc.js';

// Without this, launching the app a second time (double-clicking the icon
// again, or a previous window surviving a crash) spawns a second, fully
// independent Electron process — a second GUI window AND a second attempt
// at owning the backend, racing over the same port with no coordination.
// Only the first instance keeps running; anything after it exits immediately
// and hands off to the first instance instead of starting its own world.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const mainWindow = WindowManager.getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Permission handling
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        callback(permission === 'media');
      }
    );

    // Register IPC Handlers
    registerWindowIPCHandlers();
    registerSystemIPCHandlers();
    registerCaptureIPCHandlers();
    registerToolIPCHandlers();
    registerAuthIPCHandlers();

    // Previously: probe the health endpoint and, if anything answered,
    // silently reuse it instead of spawning our own backend. That let an
    // orphaned backend from a killed/crashed previous launch keep serving
    // every future launch indefinitely, even across full rebuilds, because
    // nothing ever verified it was running the CURRENT build's code —
    // including, in practice, an old pre-migration backend that was still
    // reading/writing the old JSON-file "database" instead of real SQLite,
    // so accounts existed on one side and not the other depending on which
    // stale process happened to answer. With the single-instance lock
    // above, there's no legitimate reason for anything else to be on this
    // port by the time we get here — reclaim it and always start fresh.
    BackendManager.ensurePortFree(BACKEND_PORT);
    BackendManager.startBackend(app);

    try {
      await waitForBackend(HEALTH_CHECK_URL, 15000);
      logger.log('Backend is ready');
    } catch (err) {
      logger.warn('Backend health check timed out:', err.message);
    }

    // Create main window
    const mainWindow = WindowManager.createWindow();

    // Start background services
    WakewordManager.startWakeWordDetector((parsed) => {
      if (mainWindow) {
        mainWindow.webContents.send('wakeword-detected', parsed);
      }
    });

    ClipboardManager.startClipboardPolling((text) => {
      if (mainWindow) {
        mainWindow.webContents.send('clipboard-changed', text);
      }
    });

    ShortcutManager.registerGlobalShortcuts(() => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
  });
}

// App Quit lifecycle hook
app.on('window-all-closed', () => {
  cleanUpProcesses();
  app.quit();
});

app.on('before-quit', () => {
  cleanUpProcesses();
});

app.on('will-quit', () => {
  ShortcutManager.unregisterGlobalShortcuts();
});

function cleanUpProcesses() {
  BackendManager.killBackend();
  WakewordManager.killWakeWordDetector();
  ClipboardManager.stopClipboardPolling();
}
