import { Router } from 'express';
import {
  getConversations,
  deleteConversation,
  updateConversation,
  getFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  searchChats
} from '../services/historyService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireString, optionalString, requireUuidParam, scalar } from '../lib/validate.js';

export const historyRouter = Router();

historyRouter.use(requireAuth);

// Get history (conversations & folders)
historyRouter.get('/', async (request, response, next) => {
  try {
    const userId = request.userId;
    const [conversations, folders] = await Promise.all([
      getConversations(userId),
      getFolders(userId)
    ]);
    response.json({ conversations, folders });
  } catch (error) {
    next(error);
  }
});

// Search history. Query length is capped (Step 2: oversized strings) and a
// repeated ?q=a&q=b collapses to one value (Step 11: HTTP parameter
// pollution) rather than being passed to the DB layer as an array, which
// better-sqlite3 would reject as an unbindable parameter type.
historyRouter.get('/search', async (request, response, next) => {
  try {
    const userId = request.userId;
    const query = optionalString(scalar(request.query.q), 'q', { max: 200 }) || '';
    const results = await searchChats(query, userId);
    response.json({ results });
  } catch (error) {
    next(error);
  }
});

// Delete a conversation
historyRouter.delete('/:conversationId', requireUuidParam('conversationId'), async (request, response, next) => {
  try {
    const userId = request.userId;
    const conversationId = request.params.conversationId;
    await deleteConversation(conversationId, userId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Update a conversation (rename, pin, bookmark, folder assignment)
historyRouter.patch('/:conversationId', requireUuidParam('conversationId'), async (request, response, next) => {
  try {
    const userId = request.userId;
    const conversationId = request.params.conversationId;
    const title = optionalString(request.body?.title, 'title', { max: 300 });
    // Three real states have to survive validation, not collapse to two:
    // absent (don't touch folderId), explicit null (un-assign), or a real
    // id (assign). optionalString's "empty means undefined" behavior would
    // silently turn an explicit `null` into "don't touch" here, which is
    // the opposite of what the caller asked for.
    const rawFolderId = request.body?.folderId;
    const folderId = rawFolderId === null || rawFolderId === undefined
      ? rawFolderId
      : requireString(rawFolderId, 'folderId', { max: 200 });
    const { isPinned, isBookmarked } = request.body || {};
    await updateConversation(conversationId, userId, { title, folderId, isPinned, isBookmarked });
    response.json({ ok: true });
  } catch (error) {
    if (error.message === 'Folder not found.') {
      return response.status(400).json({ error: error.message });
    }
    next(error);
  }
});

// Create folder
historyRouter.post('/folders', async (request, response, next) => {
  try {
    const userId = request.userId;
    const name = requireString(request.body?.name, 'name', { max: 120 });
    const folder = await createFolder(name, userId);
    response.status(201).json({ folder });
  } catch (error) {
    next(error);
  }
});

// Update folder name
historyRouter.patch('/folders/:folderId', requireUuidParam('folderId'), async (request, response, next) => {
  try {
    const userId = request.userId;
    const folderId = request.params.folderId;
    const name = requireString(request.body?.name, 'name', { max: 120 });
    await updateFolder(folderId, name, userId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Delete folder
historyRouter.delete('/folders/:folderId', requireUuidParam('folderId'), async (request, response, next) => {
  try {
    const userId = request.userId;
    const folderId = request.params.folderId;
    await deleteFolder(folderId, userId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
