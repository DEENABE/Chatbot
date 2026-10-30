import { ipcMain } from 'electron';
import * as WindowManager from '../managers/WindowManager.js';
import { isTrustedSender } from '../utils/ipcTrust.js';

export function registerWindowIPCHandlers() {
  ipcMain.handle('window-toggle-expand', (event, expand) => {
    return WindowManager.toggleExpand(expand);
  });

  ipcMain.handle('window-set-mode', (event, mode) => {
    if (!isTrustedSender(event)) return WindowManager.getWindowMode();
    return WindowManager.setWindowMode(mode);
  });

  ipcMain.handle('window-get-mode', () => {
    return WindowManager.getWindowMode();
  });

  ipcMain.handle('window-set-ocr-mode', (event, enable) => {
    return WindowManager.setOcrMode(enable);
  });

  ipcMain.handle('window-set-toolbar-mode', (event, enable) => {
    return WindowManager.setToolbarMode(enable);
  });

  ipcMain.on('window-drag-start', () => {
    WindowManager.handleDragStart();
  });

  ipcMain.on('window-drag-move', () => {
    WindowManager.handleDragMove();
  });

  ipcMain.on('window-drag-end', () => {
    WindowManager.handleDragEnd();
  });

  ipcMain.on('window-resize', (event, w, h) => {
    WindowManager.resizeWindow(w, h);
  });

  ipcMain.on('window-minimize', () => {
    WindowManager.minimizeWindow();
  });

  ipcMain.on('window-close', (event) => {
    if (!isTrustedSender(event)) return;
    WindowManager.closeWindow();
  });
}
