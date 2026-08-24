import { ipcMain } from 'electron';
import { ToolEngineRouter } from '../../tools/ToolEngineRouter.js';
import { logger } from '../utils/logger.js';
import { requireTrustedSender } from '../utils/ipcTrust.js';

let toolEngine = null;

export function registerToolIPCHandlers() {
  toolEngine = new ToolEngineRouter();

  // This is the single highest-privilege IPC channel in the app — it's the
  // entry point to PowerShell/CMD/process/service/registry/file access
  // (Phase 4). Every one of those already carries its own schema
  // validation, danger-pattern blocking, and confirmation gate; sender
  // verification is an additional, independent layer in front of all of
  // it, not a replacement for any of it.
  ipcMain.handle('tool:execute', requireTrustedSender(async (event, request) => {
    try {
      const result = await toolEngine.dispatch(request, event.sender);
      return result;
    } catch (err) {
      logger.error('[ToolEngine] Unhandled error:', err);
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: err.message || 'An unexpected error occurred'
        }
      };
    }
  }));
}
