import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function ensureOcrLanguageFile() {
  try {
    await fs.mkdir(config.ocrDir, { recursive: true });
    const localFile = path.join(config.ocrDir, 'eng.traineddata.gz');
    if (existsSync(localFile)) {
      console.log('[ocr] Language file eng.traineddata.gz found locally.');
      return;
    }

    // Try to copy from pre-bundled assets in the extraResources package directory
    // Relative from backend/src/lib/ocrHelper.js is ../../storage/ocr/... (in source tree)
    // Relative from backend/dist/lib/ocrHelper.js is ../../storage/ocr/... (in packaged build)
    const bundledFile = path.resolve(__dirname, '..', '..', 'storage', 'ocr', 'eng.traineddata.gz');
    if (existsSync(bundledFile)) {
      console.log('[ocr] Pre-bundled language file found. Copying to writable storage...');
      await fs.copyFile(bundledFile, localFile);
      console.log('[ocr] eng.traineddata.gz copied successfully.');
      return;
    }

    console.log('[ocr] Downloading eng.traineddata.gz for offline OCR...');
    const res = await fetch('https://tessdata.projectnaptha.com/4.0.0_best/eng.traineddata.gz');
    if (!res.ok) {
      throw new Error(`HTTP status ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(localFile, buffer);
    console.log('[ocr] eng.traineddata.gz downloaded successfully.');
  } catch (err) {
    console.error('[ocr] Failed to ensure OCR language file:', err.message);
    console.warn('[ocr] Offline OCR will not work if the language file is missing and there is no internet.');
  }
}
