import { Router } from 'express';
import { getMemories, addMemory, deleteMemory, clearMemories } from '../services/memoryService.js';

export const memoryRouter = Router();

// Get memories
memoryRouter.get('/', async (request, response, next) => {
  try {
    const userId = request.headers['x-user-id'] || '';
    const type = request.query.type;
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }
    const memories = await getMemories(userId, type);
    response.json({ memories });
  } catch (error) {
    next(error);
  }
});

// Add memory
memoryRouter.post('/', async (request, response, next) => {
  try {
    const userId = request.headers['x-user-id'] || '';
    const { content, type } = request.body;
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }
    if (!content?.trim()) {
      return response.status(400).json({ error: 'Memory content is required' });
    }
    if (!type || !['session', 'pinned', 'project'].includes(type)) {
      return response.status(400).json({ error: 'Invalid memory type' });
    }
    const memory = await addMemory(userId, content, type);
    response.status(201).json({ memory });
  } catch (error) {
    next(error);
  }
});

// Delete memory
memoryRouter.delete('/:memoryId', async (request, response, next) => {
  try {
    const userId = request.headers['x-user-id'] || '';
    const memoryId = request.params.memoryId;
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }
    await deleteMemory(userId, memoryId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Clear memories
memoryRouter.delete('/', async (request, response, next) => {
  try {
    const userId = request.headers['x-user-id'] || '';
    const type = request.query.type;
    if (!userId) {
      return response.status(401).json({ error: 'Authentication required' });
    }
    await clearMemories(userId, type);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
