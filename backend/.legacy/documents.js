import { Router } from 'express';
import { getDocuments, deleteDocument } from '../services/documentsStore.js';
import { listIndexedDocuments } from '../services/vectorService.js';

export const documentsRouter = Router();

documentsRouter.get('/', async (request, response, next) => {
  try {
    const userId = request.headers['x-user-id'] || '';
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }

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

documentsRouter.delete('/:documentId', async (request, response, next) => {
  try {
    const userId = request.headers['x-user-id'] || '';
    const documentId = request.params.documentId;
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }

    await deleteDocument(documentId, userId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
