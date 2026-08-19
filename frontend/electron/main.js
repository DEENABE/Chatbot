import { app, session } from 'electron';
import * as WindowManager from './managers/WindowManager.js';
import * as BackendManager from './managers/BackendManager.js';
import * as WakewordManager from './managers/WakewordManager.js';
import * as ClipboardManager from './managers/ClipboardManager.js';
import * as ShortcutManager from './managers/ShortcutManager.js';
import { waitForBackend } from './services/BackendHealth.js';
import { HEALTH_CHECK_URL } from './utils/constants.js';
import { logger } from './utils/logger.js';

// IPC registration
import { registerWindowIPCHandlers } from './ipc/window.ipc.js';
import { registerSystemIPCHandlers } from './ipc/system.ipc.js';
import { registerCaptureIPCHandlers } from './ipc/capture.ipc.js';
import { registerToolIPCHandlers } from './ipc/tool.ipc.js';
import { registerAuthIPCHandlers } from './ipc/auth.ipc.js';

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

  // Try to see if backend is already running
  let backendAlreadyRunning = false;
  try {
    await waitForBackend(HEALTH_CHECK_URL, 500);
    backendAlreadyRunning = true;
    logger.log('Backend is already running. Skipping startup.');
  } catch (err) {
    BackendManager.startBackend(app);
  }

  // Wait for backend to be fully online (if not already running)
  if (!backendAlreadyRunning) {
    try {
      await waitForBackend(HEALTH_CHECK_URL, 15000);
      logger.log('Backend is ready');
    } catch (err) {
      logger.warn('Backend health check timed out:', err.message);
    }
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
