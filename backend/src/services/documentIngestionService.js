import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { MAX_CHUNKS } from '../lib/chunkText.js';
import { ValidationError } from '../lib/validate.js';
import {
  isSupportedDocument,
  sanitizeDocumentName,
  validateDocumentMime,
} from './documentService.js';
import { prepareDocument } from '../docqa/ingest.js';
import { saveDocumentStructure } from '../docqa/structuredStore.js';
import { indexChunks } from './vectorService.js';
import { appendDocuments, getDocument, deleteDocument } from './documentsStore.js';
import { discoverModels } from './modelRouter.js';
import {
  isSupportedChatImage,
  prepareImageAttachment,
  saveImageAttachment,
} from './imageAttachmentService.js';

// Bound overlapping parse/embedding work and queued requests.
let active = 0;
const waiting = [];
function acquire(signal) {
  signal?.throwIfAborted();
  if (active < 2) {
    active++;
    return Promise.resolve();
  }
  if (waiting.length >= 8)
    throw new ValidationError('Document processing is busy. Try again shortly.');
  return new Promise((resolve, reject) => {
    const entry = {
      resolve: () => {
        signal?.removeEventListener('abort', abort);
        active++;
        resolve();
      },
    };
    const abort = () => {
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
      reject(signal.reason);
    };
    waiting.push(entry);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function release() {
  active--;
  waiting.shift()?.resolve();
}

export async function indexDocumentFiles(
  files,
  userId,
  { purpose = 'knowledge', workspaceId = null, signal, onProgress, cleanupFiles = false } = {},
) {
  const documents = [],
    skipped = [],
    warnings = [];
  let acquired = false;
  try {
    if (!['knowledge', 'attachment', 'workspace'].includes(purpose))
      throw new ValidationError('Invalid upload purpose.');
    await acquire(signal);
    acquired = true;
    for (const original of files) {
      signal?.throwIfAborted();
      let documentId;
      let previousDocumentId;
      let stored = false;
      try {
        const name = sanitizeDocumentName(original.originalname);
        if (purpose === 'attachment' && isSupportedChatImage(name)) {
          const image = await prepareImageAttachment({ ...original, originalname: name });
          let installed;
          try {
            installed = await discoverModels();
          } catch {
            throw new ValidationError(
              'Image understanding is unavailable while the local model service is offline. Start Ollama and choose an installed vision model.',
            );
          }
          if (
            !installed.some(
              (model) =>
                model.capabilities.includes('vision') && model.capabilities.includes('completion'),
            )
          )
            throw new ValidationError(
              'No installed local model supports image understanding. Choose a local model with vision capability.',
            );
          signal?.throwIfAborted();
          documentId = randomUUID();
          const doc = {
            id: documentId,
            name,
            size: image.bytes.length,
            mimeType: image.mimeType,
            purpose,
            scope: purpose,
            workspaceId: null,
            kind: 'image',
            mediaType: 'image',
            width: image.width,
            height: image.height,
            status: 'ready',
            createdAt: new Date().toISOString(),
          };
          await appendDocuments([doc], userId);
          stored = true;
          saveImageAttachment(documentId, image);
          signal?.throwIfAborted();
          documents.push(doc);
          onProgress?.({
            completed: documents.length + skipped.length,
            total: files.length,
            name,
            status: 'processed',
          });
          continue;
        }
        if (!isSupportedDocument(name)) {
          throw new ValidationError(
            /\.(png|jpe?g|gif|webp|bmp|webm|mp4)$/i.test(name)
              ? 'Images and videos cannot be indexed as text documents. Use screen sharing with a compatible local vision model.'
              : 'Unsupported format. Use PDF, DOCX, TXT, Markdown, CSV or XLSX.',
          );
        }
        const stat = await fs.stat(original.path);
        if (!stat.isFile() || stat.size > config.maxFileSize)
          throw new ValidationError('File is larger than the allowed upload size.');
        const mimeType = validateDocumentMime(name, original.mimetype);
        const file = { ...original, originalname: name };
        onProgress?.({
          completed: documents.length + skipped.length,
          total: files.length,
          name,
          status: 'extracting',
        });
        const { text, chunks, tables } = await prepareDocument(file);
        signal?.throwIfAborted();
        if (!chunks.length) throw new ValidationError('No extractable text was found.');
        if (chunks.length > MAX_CHUNKS)
          throw new ValidationError('Document is too large to index safely.');
        // Reindex into a fresh staging identity. The previous usable index
        // remains available through extraction, embedding and cancellation.
        documentId = randomUUID();
        if (original.documentId) {
          const existing = getDocument(original.documentId, userId);
          if (!existing || existing.purpose !== purpose || existing.workspaceId !== workspaceId)
            throw new ValidationError('Document not found in this workspace.');
          previousDocumentId = existing.id;
        }
        saveDocumentStructure({ documentId, userId, filename: name, tables, chunks });
        stored = true;
        let keywordOnly = false;
        onProgress?.({
          completed: documents.length + skipped.length,
          total: files.length,
          name,
          status: 'indexing',
        });
        try {
          const embedSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000);
          await indexChunks({ documentId, filename: name, chunks }, userId, {
            signal: embedSignal,
          });
        } catch (error) {
          signal?.throwIfAborted();
          keywordOnly = true;
          warnings.push({
            name,
            message:
              'Ready for keyword search. Semantic search is unavailable until the local embedding model is running.',
          });
          console.warn('[documents] semantic indexing unavailable:', error.message);
        }
        const doc = {
          id: documentId,
          name,
          size: stat.size,
          mimeType,
          purpose,
          scope: purpose,
          workspaceId,
          status: keywordOnly ? 'keyword-ready' : 'ready',
          keywordOnly,
          characters: text.length,
          chunks: chunks.length,
          sheets: tables.length,
          rows: tables.reduce((n, t) => n + t.rows.length, 0),
          relativePath: original.relativePath || undefined,
          createdAt: new Date().toISOString(),
        };
        signal?.throwIfAborted();
        await appendDocuments([doc], userId);
        signal?.throwIfAborted();
        documents.push(doc);
        if (previousDocumentId) {
          // A fully usable replacement exists before the old index retires.
          // A cleanup error must not roll back the successful replacement.
          try {
            await deleteDocument(previousDocumentId, userId);
          } catch (error) {
            console.warn('[documents] previous index cleanup failed:', error.message);
          }
        }
      } catch (error) {
        if (stored) await deleteDocument(documentId, userId);
        signal?.throwIfAborted();
        skipped.push({
          name: String(original.originalname || 'File')
            .split(/[\\/]/)
            .at(-1)
            .slice(0, 255),
          reason:
            error instanceof ValidationError
              ? error.message
              : 'The document could not be read. It may be damaged or encrypted.',
        });
        if (!(error instanceof ValidationError))
          console.error('[documents] extraction failed:', error.message);
      }
      onProgress?.({
        completed: documents.length + skipped.length,
        total: files.length,
        status: 'processed',
      });
    }
    return { documents, skipped, warnings };
  } catch (error) {
    if (signal?.aborted && purpose === 'attachment') {
      for (const document of documents) await deleteDocument(document.id, userId);
    }
    throw error;
  } finally {
    if (acquired) release();
    if (cleanupFiles)
      await Promise.all(files.map((f) => fs.rm(f.path, { force: true }).catch(() => {})));
  }
}

export async function ingestWorkspaceFile(file, userId, options = {}) {
  return indexDocumentFiles([file], userId, {
    ...options,
    purpose: 'workspace',
    cleanupFiles: false,
  });
}
