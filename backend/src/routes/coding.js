import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { CodingAgentService } from '../coding/CodingAgentService.js';
import { askLimiter } from '../middleware/rateLimiter.js';
import { createProjectWorkspace } from '../coding/NewProject.js';

export function createCodingRouter({
  service = new CodingAgentService(),
  auth = requireAuth,
  inferenceLimit = askLimiter,
  createProject = createProjectWorkspace,
} = {}) {
  const router = Router();
  router.use(auth);
  const handle = (fn) => async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (error) {
      if (error.code && error.status)
        res.status(error.status).json({ error: error.message, code: error.code });
      else next(error);
    }
  };
  router.get(
    '/models',
    handle(async (_req, res) => res.json(await service.models())),
  );
  router.get(
    '/tools',
    handle(async (_req, res) => res.json({ tools: service.engine.definitions() })),
  );
  router.post(
    '/projects',
    handle(async (req, res) => res.status(201).json(await createProject(req.userId, req.body))),
  );
  router.get(
    '/tasks',
    handle(async (req, res) => res.json({ tasks: service.repository.list(req.userId) })),
  );
  router.post(
    '/tasks',
    inferenceLimit,
    handle(async (req, res) => res.status(202).json(await service.start(req.userId, req.body))),
  );
  router.get(
    '/tasks/:id',
    handle(async (req, res) => res.json(service.get(req.userId, req.params.id))),
  );
  router.post(
    '/tasks/:id/approval',
    (req, res, next) => (req.body?.approved === true ? inferenceLimit(req, res, next) : next()),
    handle(async (req, res) =>
      res.json(
        await service.approve(req.userId, req.params.id, req.body?.approvalId, req.body?.approved),
      ),
    ),
  );
  router.post(
    '/tasks/:id/cancel',
    handle(async (req, res) => res.json(service.cancel(req.userId, req.params.id))),
  );
  router.get(
    '/workspaces/:id/tree',
    handle(async (req, res) => res.json(await service.tree(req.userId, req.params.id))),
  );
  router.get(
    '/workspaces/:id/file',
    handle(async (req, res) =>
      res.json(await service.read(req.userId, req.params.id, req.query.path)),
    ),
  );
  router.get(
    '/workspaces/:id/runtime',
    handle(async (req, res) => res.json(await service.runtime(req.userId, req.params.id))),
  );
  router.post(
    '/workspaces/:id/execution-policy',
    handle(async (req, res) =>
      res.json(await service.setExecutionPolicy(req.userId, req.params.id, req.body)),
    ),
  );
  router.post(
    '/workspaces/:id/processes/:jobId/stop',
    handle(async (req, res) =>
      res.json(await service.stopProcess(req.userId, req.params.id, req.params.jobId)),
    ),
  );
  router.post(
    '/workspaces/:id/processes/:jobId/open',
    handle(async (req, res) =>
      res.json(await service.openPreview(req.userId, req.params.id, req.params.jobId)),
    ),
  );
  router.post(
    '/workspaces/:id/authorize',
    handle(async (req, res) =>
      res.json(await service.authorize(req.userId, req.params.id, req.body?.write)),
    ),
  );
  router.post(
    '/workspaces/:id/tools',
    handle(async (req, res) => res.json(await service.tools(req.userId, req.params.id, req.body))),
  );
  router.post(
    '/workspaces/:id/approvals/:approvalId',
    handle(async (req, res) =>
      res.json(
        await service.approveTool(
          req.userId,
          req.params.id,
          req.params.approvalId,
          req.body?.approved,
        ),
      ),
    ),
  );
  return router;
}
export const codingRouter = createCodingRouter();
