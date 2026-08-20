import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { chunkText } from '../lib/chunkText.js';
import { extractDocument, isSupportedDocument } from '../services/documentService.js';
import { indexChunks } from '../services/vectorService.js';
import { appendDocuments } from '../services/documentsStore.js';
import { requireAuth } from '../middleware/auth.js';
import { ValidationError } from '../lib/validate.js';

const MAX_ORIGINAL_NAME_LENGTH = 255; // common filesystem filename limit

const storage = multer.diskStorage({
  destination: config.uploadDir,
  filename: (_request, file, callback) =>
    callback(
      null,
      `${Date.now()}-${randomUUID()}${path.extname(file.originalname).toLowerCase()}`
    )
});

const uploader = multer({
  storage,
  limits: { fileSize: config.maxFileSize, files: 500 },
  fileFilter: (_request, file, callback) => {
    // Skip unsupported files silently instead of failing the whole request.
    // This lets folder uploads (which always contain mixed file types) index
    // the supported documents rather than aborting on the first stray file.
    callback(null, isSupportedDocument(file.originalname));
  }
});

export const uploadRouter = Router();

uploadRouter.post(
  '/',
  // Auth runs before multer so an unauthenticated request is rejected
  // before any file is written to disk, not after.
  requireAuth,
  uploader.array('documents', 500),
  async (request, response, next) => {
    try {
      const userId = request.userId;

      const files = request.files;
      if (!files?.length) {
        return response.status(400).json({ error: 'Select at least one document.' });
      }

      // Per-file tolerance, not batch-abort: a folder upload always contains
      // a mix of files, and one bad one (wrong content for its extension, no
      // extractable text, a pathological filename) shouldn't sink every
      // other legitimate file in the same request — same reasoning as the
      // fileFilter above, extended to checks that only become possible once
      // the file's actual bytes are on disk.
      const documents = [];
      const skipped = [];
      for (const file of files) {
        if (file.originalname.length > MAX_ORIGINAL_NAME_LENGTH) {
          skipped.push({ name: file.originalname.slice(0, 80) + '…', reason: 'Filename too long.' });
          continue;
        }
        let text;
        try {
          text = await extractDocument(file);
        } catch (error) {
          if (error instanceof ValidationError) {
            skipped.push({ name: file.originalname, reason: error.message });
            continue;
          }
          throw error;
        }
        const chunks = chunkText(text);
        if (!chunks.length) {
          skipped.push({ name: file.originalname, reason: 'No extractable text.' });
          continue;
        }
        const documentId = randomUUID();
        const chunkCount = await indexChunks(
          { documentId, filename: file.originalname, chunks },
          userId
        );
        documents.push({
          id: documentId,
          name: file.originalname,
          size: file.size,
          characters: text.length,
          chunks: chunkCount,
          uploadedAt: new Date().toISOString()
        });
      }

      await appendDocuments(documents, userId);
      response.status(201).json({ documents, skipped });
    } catch (error) {
      next(error);
    }
  }
);
