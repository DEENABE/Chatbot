import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import {
  activateWorkspace,
  getWorkspaceForUser,
  listWorkspaces,
  saveWorkspace,
  setWorkspaceIndexState,
} from '../services/workspaceService.js';
import {
  enumerateWorkspace,
  resolveWorkspaceFile,
  SUPPORTED_WORKSPACE_EXTENSIONS,
} from '../services/workspacePaths.js';
import { getDocuments, deleteDocument } from '../services/documentsStore.js';
import { indexDocumentFiles } from '../services/documentIngestionService.js';
import path from 'node:path';
import { chooseFolderNative } from '../services/folderPicker.js';

export const workspaceRouter = Router();
workspaceRouter.use(requireAuth);
const jobs = new Map();
const key = (userId, id) => `${userId}:${id}`;
const route = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};
workspaceRouter.get(
  '/',
  route(async (req, res) => res.json({ workspaces: await listWorkspaces(req.userId) })),
);
// Browser (localhost) folder picker: opens a native Windows dialog on this PC.
workspaceRouter.post(
  '/choose-directory',
  route(async (req, res) => {
    const result = await chooseFolderNative();
    if (result.unsupported)
      return res.status(501).json({
        cancelled: true,
        error: 'The folder picker needs Windows. Type the full folder path instead.',
      });
    res.json(result);
  }),
);
workspaceRouter.post(
  '/',
  route(async (req, res) =>
    res.status(201).json({ workspace: await saveWorkspace(req.userId, req.body || {}) }),
  ),
);
workspaceRouter.patch(
  '/:id',
  route(async (req, res) => {
    if (jobs.has(key(req.userId, req.params.id)))
      return res.status(409).json({ error: 'Pause indexing before changing the directory.' });
    res.json({
      workspace: await saveWorkspace(req.userId, req.body || {}, req.params.id),
    });
  }),
);
workspaceRouter.post(
  '/:id/activate',
  route(async (req, res) => res.json({ workspace: activateWorkspace(req.userId, req.params.id) })),
);
workspaceRouter.get(
  '/:id/files',
  route(async (req, res) => {
    const workspace = getWorkspaceForUser(req.userId, req.params.id);
    const scan = await enumerateWorkspace(workspace.root);
    const job = jobs.get(key(req.userId, workspace.id));
    res.json({ ...scan, workspace, progress: job?.progress || null });
  }),
);
workspaceRouter.get(
  '/:id/status',
  route(async (req, res) => {
    const workspace = getWorkspaceForUser(req.userId, req.params.id);
    const job = jobs.get(key(req.userId, workspace.id));
    res.json({ workspace, progress: job?.progress || null });
  }),
);
workspaceRouter.post(
  '/:id/pause',
  route(async (req, res) => {
    const workspace = getWorkspaceForUser(req.userId, req.params.id);
    jobs.get(key(req.userId, workspace.id))?.controller.abort();
    setWorkspaceIndexState(req.userId, workspace.id, 'paused');
    res.json({ paused: true });
  }),
);
workspaceRouter.post(
  '/:id/index',
  route(async (req, res) => {
    const workspace = getWorkspaceForUser(req.userId, req.params.id);
    const jobKey = key(req.userId, workspace.id);
    if (jobs.has(jobKey))
      return res.status(409).json({ error: 'This workspace is already indexing.' });
    if (jobs.size >= 2)
      return res.status(429).json({
        error: 'Indexing is busy. Try again when another workspace finishes.',
      });
    const controller = new AbortController();
    const job = {
      controller,
      progress: { completed: 0, total: 0, status: 'scanning' },
    };
    jobs.set(jobKey, job);
    req.once('aborted', () => controller.abort());
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', disconnected);
    setWorkspaceIndexState(req.userId, workspace.id, 'indexing');
    try {
      let selected = req.body?.relativePaths;
      if (
        selected !== undefined &&
        (!Array.isArray(selected) ||
          selected.length > 500 ||
          selected.some((p) => typeof p !== 'string'))
      )
        return res.status(400).json({ error: 'Select at most 500 workspace files.' });
      const scan = await enumerateWorkspace(workspace.root, {
        signal: controller.signal,
        onProgress: (p) => {
          job.progress = { ...p, status: 'scanning' };
        },
      });
      const current = await getDocuments(req.userId, {
        purpose: 'workspace',
        workspaceId: workspace.id,
      });
      if (selected === undefined)
        selected = scan.entries
          .filter((entry) => entry.supported)
          .map((entry) => entry.relativePath)
          .slice(0, 500);
      const files = [],
        skipped = [];
      for (const relativePath of selected) {
        try {
          const file = await resolveWorkspaceFile(workspace.root, relativePath);
          if (!SUPPORTED_WORKSPACE_EXTENSIONS.has(path.extname(file.originalname).toLowerCase()))
            throw new Error('Unsupported file format.');
          if (file.size > config.maxFileSize)
            throw new Error('File exceeds the upload size limit.');
          const prior = current.find((doc) => doc.relativePath === file.relativePath);
          if (prior && !req.body?.reindex) continue;
          files.push({ ...file, ...(prior ? { documentId: prior.id } : {}) });
        } catch (error) {
          skipped.push({ name: relativePath, reason: error.message });
        }
      }
      const result = await indexDocumentFiles(files, req.userId, {
        purpose: 'workspace',
        workspaceId: workspace.id,
        signal: controller.signal,
        cleanupFiles: false,
        onProgress: (p) => {
          job.progress = p;
        },
      });
      setWorkspaceIndexState(req.userId, workspace.id, 'ready');
      res.json({
        ...result,
        skipped: [...skipped, ...(result.skipped || [])],
        scan: {
          files: scan.files,
          supportedFiles: scan.supportedFiles,
          errors: scan.errors,
          truncated: scan.truncated,
        },
        limited: scan.supportedFiles > 500,
      });
    } catch (error) {
      setWorkspaceIndexState(
        req.userId,
        workspace.id,
        controller.signal.aborted ? 'paused' : 'error',
      );
      if (controller.signal.aborted) {
        if (!res.headersSent && !res.destroyed)
          res.status(409).json({
            error: 'Indexing paused. Completed files remain indexed.',
          });
      } else throw error;
    } finally {
      res.removeListener('close', disconnected);
      jobs.delete(jobKey);
      if (getWorkspaceForUser(req.userId, workspace.id).indexState === 'indexing')
        setWorkspaceIndexState(req.userId, workspace.id, 'idle');
    }
  }),
);
workspaceRouter.delete(
  '/:id/index',
  route(async (req, res) => {
    const workspace = getWorkspaceForUser(req.userId, req.params.id);
    if (jobs.has(key(req.userId, workspace.id)))
      return res.status(409).json({ error: 'Pause indexing before removing an index.' });
    const documents = await getDocuments(req.userId, {
      purpose: 'workspace',
      workspaceId: workspace.id,
    });
    for (const document of documents) await deleteDocument(document.id, req.userId);
    setWorkspaceIndexState(req.userId, workspace.id, 'idle');
    res.json({ removed: documents.length, originalsPreserved: true });
  }),
);
