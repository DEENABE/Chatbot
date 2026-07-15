import { ipcMain } from 'electron';
import { ToolEngineRouter } from '../../tools/ToolEngineRouter.js';
import { logger } from '../utils/logger.js';

let toolEngine = null;

export function registerToolIPCHandlers() {
  toolEngine = new ToolEngineRouter();

  ipcMain.handle('tool:execute', async (event, request) => {
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
  });
}
