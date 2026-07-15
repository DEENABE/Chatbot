import { globalShortcut } from 'electron';
import { logger } from '../utils/logger.js';

export function registerGlobalShortcuts(onToggleCallback) {
  try {
    globalShortcut.register("CommandOrControl+Space", () => {
      onToggleCallback();
    });
    logger.log('Global shortcut Ctrl+Space registered successfully');
  } catch (err) {
    logger.error('Failed to register global shortcuts:', err);
  }
}

export function unregisterGlobalShortcuts() {
  globalShortcut.unregisterAll();
  logger.log('All global shortcuts unregistered');
}
