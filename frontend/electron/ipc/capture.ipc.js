import { ipcMain } from 'electron';
import * as ScreenCapture from '../services/ScreenCapture.js';

export function registerCaptureIPCHandlers() {
  ipcMain.handle("capture-screen", async () => {
    return ScreenCapture.captureScreen();
  });

  ipcMain.handle("get-screen-sources", async () => {
    return ScreenCapture.getScreenSources();
  });
}
