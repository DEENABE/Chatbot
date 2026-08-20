import { Router } from 'express';
import { getDocuments, deleteDocument } from '../services/documentsStore.js';
import { listIndexedDocuments } from '../services/vectorService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireUuidParam } from '../lib/validate.js';

export const documentsRouter = Router();

documentsRouter.use(requireAuth);

documentsRouter.get('/', async (request, response, next) => {
  try {
    const userId = request.userId;

    const [stored, indexed] = await Promise.all([
      getDocuments(userId),
      listIndexedDocuments(userId)
    ]);

    const merged = new Map(indexed.map((doc) => [doc.id, doc]));
    stored.forEach((doc) => {
      const existing = merged.get(doc.id) || {};
      merged.set(doc.id, { ...existing, ...doc });
    });

    response.json({ documents: [...merged.values()] });
  } catch (error) {
    next(error);
  }
});

documentsRouter.delete('/:documentId', requireUuidParam('documentId'), async (request, response, next) => {
  try {
    const userId = request.userId;
    const documentId = request.params.documentId;

    await deleteDocument(documentId, userId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
