import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { chunkText, MAX_CHUNKS } from '../lib/chunkText.js';
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
        // The file on disk is only ever needed transiently, to extract its
        // text once — nothing in this app re-reads or re-serves the raw
        // upload afterward (see documentsStore.deleteDocument, which only
        // ever removes the DB row and vector chunks). Left in place, every
        // upload — including ones the user later "deletes" through the API
        // — would sit in storage/uploads forever, an unbounded disk-space
        // leak and a copy of supposedly-deleted content that outlives the
        // delete. Removing it here, unconditionally, after this file is
        // done (success or failure), means there's nothing left to leak.
        try {
          if (file.originalname.length > MAX_ORIGINAL_NAME_LENGTH) {
            skipped.push({ name: file.originalname.slice(0, 80) + '…', reason: 'Filename too long.' });
            continue;
          }
          let text;
          try {
            text = await extractDocument(file);
          } catch (error) {
            // A parser throwing on a corrupt-but-signature-valid file (a
            // truncated PDF, a malformed workbook) is exactly as expected a
            // failure as ValidationError — both mean "skip this one file",
            // not "abort the whole batch and 500 the request", which is
            // what happened before for anything the parser itself rejected.
            if (!(error instanceof ValidationError)) {
              console.error(`[upload] ${file.originalname} failed to parse:`, error.message);
            }
            skipped.push({ name: file.originalname, reason: error instanceof ValidationError ? error.message : 'Could not be parsed.' });
            continue;
          }
          const chunks = chunkText(text);
          if (!chunks.length) {
            skipped.push({ name: file.originalname, reason: 'No extractable text.' });
            continue;
          }
          if (chunks.length > MAX_CHUNKS) {
            skipped.push({ name: file.originalname, reason: 'Document is too large to index safely.' });
            continue;
          }
          const documentId = randomUUID();
          let chunkCount;
          try {
            chunkCount = await indexChunks(
              { documentId, filename: file.originalname, chunks },
              userId
            );
          } catch (error) {
            // Embedding can fail for reasons that have nothing to do with
            // this specific file (e.g. Ollama unreachable) — but treating it
            // as a batch-abort was worse: any file already indexed earlier
            // in this same loop would have real vector chunks in LanceDB
            // with no corresponding row in the documents table at all,
            // because appendDocuments() used to run once, after the loop,
            // for every file at once. Persisting each document's metadata
            // immediately below (instead of batching) plus treating this
            // like any other per-file failure closes both problems together.
            console.error(`[upload] ${file.originalname} failed to index:`, error.message);
            skipped.push({ name: file.originalname, reason: 'Could not be indexed.' });
            continue;
          }
          const doc = {
            id: documentId,
            name: file.originalname,
            size: file.size,
            characters: text.length,
            chunks: chunkCount,
            uploadedAt: new Date().toISOString()
          };
          await appendDocuments([doc], userId);
          documents.push(doc);
        } finally {
          await fs.rm(file.path, { force: true }).catch(() => {});
        }
      }

      response.status(201).json({ documents, skipped });
    } catch (error) {
      next(error);
    }
  }
);
