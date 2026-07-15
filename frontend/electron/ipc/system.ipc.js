import { ipcMain } from 'electron';
import * as NotificationManager from '../managers/NotificationManager.js';
import * as FileService from '../services/FileService.js';
import * as WindowManager from '../managers/WindowManager.js';

export function registerSystemIPCHandlers() {
  ipcMain.on("show-notification", (event, { title, body }) => {
    NotificationManager.showNotification(title, body);
  });

  ipcMain.handle("save-file", async (event, { name, base64 }) => {
    const mainWin = WindowManager.getMainWindow();
    return FileService.saveBase64File(mainWin, name, base64);
  });
}
