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

export const historyRouter = Router();

// Get history (conversations & folders)
historyRouter.get('/', async (request, response, next) => {
  try {
    const userId = request.headers['x-user-id'] || '';
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }
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
    const userId = request.headers['x-user-id'] || '';
    const query = request.query.q || '';
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }
    const results = await searchChats(query, userId);
    response.json({ results });
  } catch (error) {
    next(error);
  }
});

// Delete a conversation
historyRouter.delete('/:conversationId', async (request, response, next) => {
  try {
    const userId = request.headers['x-user-id'] || '';
    const conversationId = request.params.conversationId;
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }
    await deleteConversation(conversationId, userId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Update a conversation (rename, pin, bookmark, folder assignment)
historyRouter.patch('/:conversationId', async (request, response, next) => {
  try {
    const userId = request.headers['x-user-id'] || '';
    const conversationId = request.params.conversationId;
    const { title, folderId, isPinned, isBookmarked } = request.body;
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }
    await updateConversation(conversationId, userId, { title, folderId, isPinned, isBookmarked });
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Create folder
historyRouter.post('/folders', async (request, response, next) => {
  try {
    const userId = request.headers['x-user-id'] || '';
    const { name } = request.body;
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }
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
    const userId = request.headers['x-user-id'] || '';
    const folderId = request.params.folderId;
    const { name } = request.body;
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }
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
    const userId = request.headers['x-user-id'] || '';
    const folderId = request.params.folderId;
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }
    await deleteFolder(folderId, userId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
