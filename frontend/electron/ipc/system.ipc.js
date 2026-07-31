import { ipcMain } from 'electron';
import * as NotificationManager from '../managers/NotificationManager.js';
import * as FileService from '../services/FileService.js';
import * as WindowManager from '../managers/WindowManager.js';
import * as TextToSpeech from '../services/TextToSpeech.js';

export function registerSystemIPCHandlers() {
  ipcMain.on("show-notification", (event, { title, body }) => {
    NotificationManager.showNotification(title, body);
  });

  // Speech goes through the Windows engine: Electron's Web Speech API reports
  // no voices here, so speechSynthesis silently drops every utterance.
  ipcMain.handle("speak-text", (event, { text, rate, volume } = {}) =>
    TextToSpeech.speak(text, { rate, volume })
  );

  ipcMain.on("stop-speaking", () => TextToSpeech.stop());

  ipcMain.handle("save-file", async (event, { name, base64 }) => {
    const mainWin = WindowManager.getMainWindow();
    return FileService.saveBase64File(mainWin, name, base64);
  });
}
