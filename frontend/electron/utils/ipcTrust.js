/**
 * @module electron/utils/ipcTrust
 * @description Verifies an IPC event actually came from this app's own
 * window, not just that the channel name was known.
 *
 * This app has exactly one legitimate webContents for its entire lifetime
 * — one BrowserWindow, no <webview>, no BrowserView, and (Phase 6) no way
 * for the renderer to spawn a second window or navigate this one to
 * different content. So "trusted sender" reduces to a single equality
 * check against the one window WindowManager tracks. Cheap, and correct
 * for as long as that single-window architecture holds — if the app ever
 * legitimately gains a second window, this needs to become an allowlist.
 */
import * as WindowManager from '../managers/WindowManager.js';

/**
 * @param {Electron.IpcMainInvokeEvent} event
 * @returns {boolean}
 */
export function isTrustedSender(event) {
  const mainWindow = WindowManager.getMainWindow();
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

/**
 * Wrap an ipcMain.handle listener so it never runs for an untrusted sender.
 * Returns the same shape every real handler already returns on failure
 * (`{ success: false, error }`), so callers don't need special-casing.
 *
 * @param {(event: Electron.IpcMainInvokeEvent, ...args: any[]) => any} handler
 */
export function requireTrustedSender(handler) {
  return (event, ...args) => {
    if (!isTrustedSender(event)) {
      return { success: false, error: { code: 'UNTRUSTED_SENDER', message: 'This request did not originate from the application window.' } };
    }
    return handler(event, ...args);
  };
}
