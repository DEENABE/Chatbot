import { dialog, ipcMain } from 'electron';
import { requireTrustedSender } from '../utils/ipcTrust.js';
import { getMainWindow } from '../managers/WindowManager.js';
import { getToken } from '../services/SessionStore.js';

export function registerWorkspaceIPCHandlers() {
  ipcMain.handle(
    'workspace:choose-directory',
    requireTrustedSender(async () => {
      if (!getToken())
        return {
          cancelled: true,
          error: 'Sign in before choosing a workspace.',
        };
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Choose workspace directory',
        properties: ['openDirectory', 'dontAddToRecent'],
      });
      return {
        cancelled: result.canceled,
        root: result.canceled ? null : result.filePaths[0],
      };
    }),
  );
}
