import { Router } from 'express';
import { runAgent } from '../agent/agentLoop.js';
import { AGENT_DEFAULT_MODEL } from '../agent/agentBrain.js';

export const agentRouter = Router();

/**
 * POST /api/agent
 * Body: { goal: string, model?: string, maxSteps?: number }
 *
 * Streams the autonomous troubleshooting session as NDJSON, one JSON event
 * per line (same transport style as /api/chat). Event types:
 *   thought | command | output | blocked | final | error | aborted
 */
agentRouter.post('/', async (request, response) => {
  // This endpoint runs unattended PowerShell on the host — every other route
  // that touches user data requires x-user-id, but this one (and /api/repair)
  // didn't require anything at all, so any process that could reach the port
  // could trigger it. Loopback binding (config.js) now keeps it off the
  // network; this keeps it consistent with the rest of the API regardless.
  const userId = request.headers['x-user-id'] || '';
  if (!userId) {
    return response.status(401).json({ error: 'Authentication required' });
  }

  const { goal, model = AGENT_DEFAULT_MODEL, maxSteps } = request.body || {};

  if (!goal || !String(goal).trim()) {
    return response.status(400).json({ error: 'A "goal" describing the problem is required.' });
  }

  response.status(200);
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('X-Accel-Buffering', 'no');

  const send = (event) => response.write(`${JSON.stringify(event)}\n`);

  try {
    await runAgent({
      goal: String(goal).trim(),
      model,
      maxSteps: Number(maxSteps) || undefined,
      signal: request.signal,
      onEvent: send,
    });
  } catch (error) {
    send({ type: 'error', payload: { message: error.message } });
  } finally {
    response.end();
  }
});
