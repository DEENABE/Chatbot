import { dialog } from 'electron';
import fs from 'fs';
import { logger } from '../utils/logger.js';

export async function saveBase64File(parentWindow, name, base64) {
  try {
    const { filePath } = await dialog.showSaveDialog(parentWindow, {
      defaultPath: name,
      properties: ["showOverwriteConfirmation"]
    });
    if (!filePath) return { success: false, cancelled: true };
    const buffer = Buffer.from(base64, 'base64');
    await fs.promises.writeFile(filePath, buffer);
    return { success: true, filePath };
  } catch (err) {
    logger.error("Save file failed:", err);
    throw err;
  }
}
