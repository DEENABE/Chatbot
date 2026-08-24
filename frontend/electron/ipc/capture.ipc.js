import { ipcMain } from 'electron';
import * as ScreenCapture from '../services/ScreenCapture.js';
import { isTrustedSender } from '../utils/ipcTrust.js';

export function registerCaptureIPCHandlers() {
  // Screen capture from an untrusted sender is a silent-surveillance risk,
  // not just a privilege issue — worth the same sender check as the tool
  // engine and the session token.
  ipcMain.handle("capture-screen", async (event) => {
    if (!isTrustedSender(event)) return null;
    return ScreenCapture.captureScreen();
  });

  ipcMain.handle("get-screen-sources", async (event) => {
    if (!isTrustedSender(event)) return [];
    return ScreenCapture.getScreenSources();
  });
}
