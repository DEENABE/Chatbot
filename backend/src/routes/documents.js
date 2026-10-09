import { Router } from 'express';
import { getDocuments, deleteDocument } from '../services/documentsStore.js';
import { listIndexedDocuments } from '../services/vectorService.js';
import { documentStructureStats } from '../docqa/structuredStore.js';
import { requireAuth } from '../middleware/auth.js';
import { requireUuidParam } from '../lib/validate.js';
import { ValidationError } from '../lib/validate.js';
import { isValidUuid } from '../lib/validateUuid.js';

export const documentsRouter = Router();

documentsRouter.use(requireAuth);

documentsRouter.get('/', async (request, response, next) => {
  try {
    const userId = request.userId;

    const purpose = request.query.purpose || 'knowledge';
    if (!['knowledge', 'workspace', 'attachment'].includes(purpose))
      throw new ValidationError('Invalid document purpose.');
    if (request.query.workspaceId && !isValidUuid(request.query.workspaceId))
      throw new ValidationError('Invalid workspaceId.');
    if (
      request.query.conversationId &&
      (typeof request.query.conversationId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(request.query.conversationId))
    )
      throw new ValidationError('Invalid conversationId.');
    const stored = await getDocuments(userId, {
      purpose,
      workspaceId: request.query.workspaceId,
      conversationId: request.query.conversationId,
    });
    // Metadata defines document scope. Orphan/legacy vector entries must not
    // accidentally make a conversation attachment visible in Knowledge.
    const ids = new Set(stored.map((doc) => doc.id));
    const indexed = (await listIndexedDocuments(userId)).filter((doc) => ids.has(doc.id));

    const merged = new Map(indexed.map((doc) => [doc.id, doc]));
    stored.forEach((doc) => {
      const existing = merged.get(doc.id) || {};
      merged.set(doc.id, { ...existing, ...doc });
    });

    // Spreadsheet stats (sheets / rows) for the knowledge-base list.
    let stats = new Map();
    try {
      stats = documentStructureStats(userId);
    } catch (error) {
      console.error('[docqa] stats failed:', error.message);
    }
    const documents = [...merged.values()].map((doc) => {
      const s = stats.get(doc.id);
      return s ? { ...doc, sheets: s.tables, rows: s.rows } : doc;
    });

    response.json({ documents });
  } catch (error) {
    next(error);
  }
});

documentsRouter.delete(
  '/:documentId',
  requireUuidParam('documentId'),
  async (request, response, next) => {
    try {
      const userId = request.userId;
      const documentId = request.params.documentId;

      await deleteDocument(documentId, userId);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);
