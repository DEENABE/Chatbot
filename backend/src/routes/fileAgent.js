import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { outputStore, planStore } from '../fileagent/runtime.js';
import { applyPlan, undoPlan, OrganizeError } from '../fileagent/organize.js';

/** Downloads for generated files and Apply/Undo for folder plans shown in chat. */
export const fileAgentRouter = Router();
fileAgentRouter.use(requireAuth);

const route = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof OrganizeError) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};

fileAgentRouter.get(
  '/outputs/:id',
  route(async (req, res) => {
    const output = await outputStore.get(req.userId, req.params.id);
    if (!output) return res.status(404).json({ error: 'This file is no longer available. Ask again to regenerate it.' });
    res.setHeader('Content-Type', output.mime || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${output.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(output.name)}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(output.path);
  }),
);

const summary = (plan) => ({
  id: plan.id,
  status: plan.status,
  root: plan.root,
  moves: plan.moves.length,
  applied: plan.applied.length,
  failed: plan.failed,
  undo: plan.undo || null,
});

fileAgentRouter.get(
  '/plans/:id',
  route(async (req, res) => res.json(summary(await planStore.load(req.userId, req.params.id)))),
);
fileAgentRouter.post(
  '/plans/:id/apply',
  route(async (req, res) => res.json(summary(await applyPlan(planStore, req.userId, req.params.id)))),
);
fileAgentRouter.post(
  '/plans/:id/undo',
  route(async (req, res) => res.json(summary(await undoPlan(planStore, req.userId, req.params.id)))),
);
