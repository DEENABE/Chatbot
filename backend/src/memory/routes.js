import { Router } from 'express';
import { memoryManager as manager } from './runtime.js';
import { fields, text, memoryError } from './validation.js';
export const typedMemoryRouter = Router();
const route = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
const scope = (req) => ({ requestId: req.id });
typedMemoryRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
typedMemoryRouter.get(
  '/long-term',
  route((req, res) => {
    const query = req.query.q;
    if (query !== undefined && typeof query !== 'string') throw memoryError();
    res.json({
      memories: query
        ? manager.longTerm.searchLongTermMemory(req.userId, text(query, 200))
        : manager.longTerm.getLongTermMemories(req.userId),
    });
  }),
);
typedMemoryRouter.post(
  '/long-term',
  route((req, res) => {
    const r = manager.longTerm.saveLongTermMemory(req.userId, req.body, {
      ...scope(req),
      explicit: true,
      origin: 'user',
    });
    res.status(r.memory ? 201 : 422).json(r);
  }),
);
typedMemoryRouter.patch(
  '/long-term/:id',
  route((req, res) => {
    fields(req.body, ['value', 'category']);
    const r = manager.longTerm.updateLongTermMemory(
      req.userId,
      req.params.id,
      req.body,
      scope(req),
    );
    res.status(r.memory ? 200 : 422).json(r);
  }),
);
typedMemoryRouter.delete(
  '/long-term/:id',
  route((req, res) => {
    res.json(manager.longTerm.deleteLongTermMemory(req.userId, req.params.id, scope(req)));
  }),
);
typedMemoryRouter.get(
  '/tasks/:id',
  route((req, res) => res.json({ memory: manager.task.getTaskMemory(req.userId, req.params.id) })),
);
typedMemoryRouter.get(
  '/short-term/:conversationId',
  route((req, res) =>
    res.json({
      memories: manager.shortTerm.getShortTermMemory(req.userId, req.params.conversationId),
    }),
  ),
);
typedMemoryRouter.post(
  '/short-term/clear',
  route((req, res) => {
    fields(req.body, ['conversationId']);
    manager.shortTerm.clearShortTermMemory(req.userId, req.body.conversationId);
    res.json({ ok: true });
  }),
);
typedMemoryRouter.get(
  '/system',
  route(async (_req, res) => {
    if (!manager.system.getSystemMemory().length) await manager.system.refreshSystemMemory();
    res.json(manager.system.getSystemSnapshot());
  }),
);
typedMemoryRouter.post(
  '/system/refresh',
  route(async (req, res) => {
    fields(req.body || {}, []);
    await manager.system.refreshSystemMemory();
    res.json(manager.system.getSystemSnapshot());
  }),
);
