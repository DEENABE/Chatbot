import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { chunkText } from '../lib/chunkText.js';
import { extractDocument, isSupportedDocument } from '../services/documentService.js';
import { indexChunks } from '../services/vectorService.js';
import { appendDocuments } from '../services/documentsStore.js';

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
    const isSupported = isSupportedDocument(file.originalname);
    if (!isSupported) {
      return callback(
        new Error('Only PDF, DOCX, XLSX, CSV, TXT, and Markdown files are supported.')
      );
    }
    callback(null, true);
  }
});

export const uploadRouter = Router();

uploadRouter.post(
  '/',
  uploader.array('documents', 500),
  async (request, response, next) => {
    try {
      const userId = request.headers['x-user-id'] || '';
      if (!userId) {
        return response.status(401).json({ error: 'Authentication required' });
      }

      const files = request.files;
      if (!files?.length) {
        return response.status(400).json({ error: 'Select at least one document.' });
      }

      const documents = [];
      for (const file of files) {
        const text = await extractDocument(file);
        const chunks = chunkText(text);
        if (!chunks.length) {
          throw new Error(`${file.originalname} did not contain extractable text.`);
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
      response.status(201).json({ documents });
    } catch (error) {
      next(error);
    }
  }
);
