import { Router } from 'express';
import { getMemories, addMemory, deleteMemory, clearMemories } from '../services/memoryService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireString, requireEnum, requireUuidParam, scalar } from '../lib/validate.js';

export const memoryRouter = Router();

const MEMORY_TYPES = ['session', 'pinned', 'project'];

memoryRouter.use(requireAuth);

// Get memories. `type` is collapsed to a single value (Step 11: a repeated
// ?type=a&type=b would otherwise reach the DB layer as an array, which
// better-sqlite3 rejects as an unbindable bind-parameter type) and, when
// present, must be one of the real memory types rather than an arbitrary
// string reaching a `WHERE type = ?` filter.
memoryRouter.get('/', async (request, response, next) => {
  try {
    const userId = request.userId;
    const rawType = scalar(request.query.type);
    const type = rawType === undefined ? undefined : requireEnum(rawType, 'type', MEMORY_TYPES);
    const memories = await getMemories(userId, type);
    response.json({ memories });
  } catch (error) {
    next(error);
  }
});

// Add memory
memoryRouter.post('/', async (request, response, next) => {
  try {
    const userId = request.userId;
    const content = requireString(request.body?.content, 'content', { max: 8000 });
    const type = requireEnum(request.body?.type, 'type', MEMORY_TYPES);
    const memory = await addMemory(userId, content, type);
    response.status(201).json({ memory });
  } catch (error) {
    next(error);
  }
});

// Delete memory
memoryRouter.delete('/:memoryId', requireUuidParam('memoryId'), async (request, response, next) => {
  try {
    const userId = request.userId;
    const memoryId = request.params.memoryId;
    await deleteMemory(userId, memoryId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Clear memories
memoryRouter.delete('/', async (request, response, next) => {
  try {
    const userId = request.userId;
    const rawType = scalar(request.query.type);
    const type = rawType === undefined ? undefined : requireEnum(rawType, 'type', MEMORY_TYPES);
    await clearMemories(userId, type);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
