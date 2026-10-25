// Must run before any module that starts a child process.
import './utils/hideConsoles.js';
import { app, session, dialog } from 'electron';
import * as WindowManager from './managers/WindowManager.js';
import * as BackendManager from './managers/BackendManager.js';
import * as WakewordManager from './managers/WakewordManager.js';
import * as ClipboardManager from './managers/ClipboardManager.js';
import * as ShortcutManager from './managers/ShortcutManager.js';
import { waitForBackend } from './services/BackendHealth.js';
import { logger } from './utils/logger.js';

// Allows isolated QA profiles without touching the user's installed app data.
if (process.env.CHANAKYA_USER_DATA_DIR) app.setPath('userData', process.env.CHANAKYA_USER_DATA_DIR);

// IPC registration
import { registerWindowIPCHandlers } from './ipc/window.ipc.js';
import { registerSystemIPCHandlers } from './ipc/system.ipc.js';
import { registerWorkspaceIPCHandlers } from './ipc/workspace.ipc.js';
import { registerCaptureIPCHandlers } from './ipc/capture.ipc.js';
import {
  registerToolIPCHandlers,
  startInternalToolServer,
  stopInternalToolServer,
} from './ipc/tool.ipc.js';
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
    // Permission handling. Scoped to the app's own loaded page, not just the
    // permission type — this session is shared by any webContents that ever
    // exists in this process, so without the origin check a page this app
    // never intended to load (see the navigation guards in WindowManager.js)
    // could still silently receive mic/camera access just by asking.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const ownWindow = WindowManager.getMainWindow();
      const isOwnPage =
        ownWindow &&
        !ownWindow.isDestroyed() &&
        ownWindow.webContents === webContents &&
        webContents.getURL().startsWith('file://');
      callback(isOwnPage && permission === 'media');
    });

    // Register IPC Handlers
    registerWindowIPCHandlers();
    registerSystemIPCHandlers();
    registerWorkspaceIPCHandlers();
    registerCaptureIPCHandlers();
    registerToolIPCHandlers();
    registerAuthIPCHandlers();

    // Start the internal loopback HTTP server so the backend Orchestrator can
    // call ToolEngine actions directly without going through the renderer.
    // The loopback URL and per-launch secret are passed only to the backend child.
    const toolBridge = await startInternalToolServer(app).catch((err) => {
      logger.warn('Internal tool server failed to start:', err.message);
    });

    try {
      const backend = await BackendManager.startBackend(app, toolBridge);
      await waitForBackend(`${backend.apiBaseUrl}/health`, 15000);
      logger.log('Backend is ready');
    } catch (err) {
      logger.error('Local service startup failed:', err.message);
      dialog.showErrorBox('Chanakya AI could not start', err.message);
      cleanUpProcesses();
      app.quit();
      return;
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
  stopInternalToolServer();
  BackendManager.killBackend();
  WakewordManager.killWakeWordDetector();
  ClipboardManager.stopClipboardPolling();
}
