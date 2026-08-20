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

// Search history
historyRouter.get('/search', async (request, response, next) => {
  try {
    const userId = request.userId;
    const query = request.query.q || '';
    const results = await searchChats(query, userId);
    response.json({ results });
  } catch (error) {
    next(error);
  }
});

// Delete a conversation
historyRouter.delete('/:conversationId', async (request, response, next) => {
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
historyRouter.patch('/:conversationId', async (request, response, next) => {
  try {
    const userId = request.userId;
    const conversationId = request.params.conversationId;
    const { title, folderId, isPinned, isBookmarked } = request.body;
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
    const { name } = request.body;
    if (!name?.trim()) {
      return response.status(400).json({ error: 'Folder name is required' });
    }
    const folder = await createFolder(name, userId);
    response.status(201).json({ folder });
  } catch (error) {
    next(error);
  }
});

// Update folder name
historyRouter.patch('/folders/:folderId', async (request, response, next) => {
  try {
    const userId = request.userId;
    const folderId = request.params.folderId;
    const { name } = request.body;
    if (!name?.trim()) {
      return response.status(400).json({ error: 'Folder name is required' });
    }
    await updateFolder(folderId, name, userId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Delete folder
historyRouter.delete('/folders/:folderId', async (request, response, next) => {
  try {
    const userId = request.userId;
    const folderId = request.params.folderId;
    await deleteFolder(folderId, userId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
