import { Router } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { ValidationError } from '../lib/validate.js';
import { isValidUuid } from '../lib/validateUuid.js';
import { executionRequestSignal } from '../orchestrator/requestSignal.js';
import { indexDocumentFiles } from '../services/documentIngestionService.js';
import { db } from '../services/db.js';

const storage = multer.diskStorage({
  destination: config.uploadDir,
  filename: (_request, file, callback) =>
    callback(null, `${Date.now()}-${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});
const uploader = multer({
  storage,
  limits: { fileSize: config.maxFileSize, files: 500, fields: 5, fieldSize: 256 * 1024 },
});
// Composer files can upload separately for individual progress/cancellation.
// They must not consume the chat/repair request allowance.
const uploadLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (request) => request.userId,
  handler: (_request, response) =>
    response.status(429).json({ error: 'Too many uploads. Wait a minute and try again.' }),
});
export const uploadRouter = Router();
uploadRouter.post(
  '/',
  requireAuth,
  uploadLimiter,
  uploader.array('documents', 500),
  async (request, response, next) => {
    const files = request.files || [];
    const signal = executionRequestSignal(request, response);
    try {
      const purpose = request.body?.purpose || 'knowledge';
      if (!['attachment', 'knowledge', 'workspace'].includes(purpose))
        throw new ValidationError('Invalid upload purpose.');
      if (!files.length) throw new ValidationError('Select at least one file.');
      if (purpose === 'attachment' && files.length > 20)
        throw new ValidationError('Attach at most 20 files to one message.');
      const workspaceId = request.body?.workspaceId || null;
      if (request.body?.relativePaths) {
        let relativePaths;
        try {
          relativePaths = JSON.parse(request.body.relativePaths);
        } catch {
          throw new ValidationError('Folder paths are invalid.');
        }
        if (!Array.isArray(relativePaths) || relativePaths.length !== files.length)
          throw new ValidationError('Folder paths do not match the selected files.');
        relativePaths.forEach((item, index) => {
          if (
            typeof item !== 'string' ||
            item.length > 2048 ||
            /^[\\/]|^[a-z]:/i.test(item) ||
            item.includes('\0')
          )
            throw new ValidationError('Folder path is unsafe.');
          const parts = item.replace(/\\/g, '/').split('/');
          if (parts.some((part) => !part || part === '..' || part === '.'))
            throw new ValidationError('Folder path is unsafe.');
          files[index].relativePath = parts.join('/');
        });
      }
      if (purpose === 'workspace') {
        if (!isValidUuid(workspaceId))
          throw new ValidationError('Select a workspace before importing files.');
        let ownsWorkspace = false;
        try {
          ownsWorkspace = !!db
            .prepare('SELECT id FROM workspaces WHERE id=? AND userId=?')
            .get(workspaceId, request.userId);
        } catch {}
        if (!ownsWorkspace) throw new ValidationError('Workspace not found.');
      }
      const result = await indexDocumentFiles(files, request.userId, {
        purpose,
        workspaceId: purpose === 'workspace' ? workspaceId : null,
        signal,
        cleanupFiles: true,
      });
      if (!signal.aborted) response.status(201).json(result);
    } catch (error) {
      await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
      if (!signal.aborted) next(error);
    }
  },
);
