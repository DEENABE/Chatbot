import path from 'node:path';
import { config } from '../config.js';
import { OriginalStore } from './stores.js';
import { formatOf } from './formats.js';

/**
 * Read-only copies of uploaded documents (storage/docintel/originals/<id>/).
 * Kept so exact operations can use real sheet rows and formulas, and so
 * conversions/edits can work from the real file. Retention: chat attachments
 * 7 days, knowledge-base documents 30 days; removed when the document is deleted.
 */
export const originals = new OriginalStore(
  path.join(config.appDataPath, 'storage', 'docintel', 'originals'),
);

/** Best effort: never fails an upload. */
export async function keepOriginal(userId, document, sourcePath) {
  if (!document?.id || !formatOf(document.name) || document.kind === 'image') return null;
  try {
    return await originals.keepCopy(userId, document.id, sourcePath, {
      name: document.name,
      mime: document.mimeType,
      purpose:
        document.purpose === 'knowledge' || document.purpose === 'workspace'
          ? 'knowledge'
          : 'attachment',
    });
  } catch (error) {
    console.warn('[docintel] could not keep the original file:', error.message);
    return null;
  }
}

export async function forgetOriginal(userId, documentId) {
  try {
    await originals.remove(userId, documentId);
  } catch {
    /* already gone */
  }
}
