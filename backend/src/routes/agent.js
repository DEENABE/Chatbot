import { Router } from 'express';
import { runAgent } from '../agent/agentLoop.js';
import { AGENT_DEFAULT_MODEL } from '../agent/agentBrain.js';
import { requireAuth } from '../middleware/auth.js';
import { boundedInt } from '../lib/validate.js';

export const agentRouter = Router();

const MAX_GOAL_LENGTH = 4000;
// Well above the loop's own default (8) so a deliberately longer run still
// works, but bounded — an unbounded maxSteps is an unbounded number of
// unattended PowerShell commands (Step 19: resource exhaustion).
const MAX_STEPS_CEILING = 50;

/**
 * POST /api/agent
 * Body: { goal: string, model?: string, maxSteps?: number }
 *
 * Streams the autonomous troubleshooting session as NDJSON, one JSON event
 * per line (same transport style as /api/chat). Event types:
 *   thought | command | output | blocked | final | error | aborted
 */
// This endpoint runs unattended PowerShell on the host — every other route
// that touches user data requires a verified session, but this one (and
// /api/repair) didn't require anything at all, so any process that could
// reach the port could trigger it. Loopback binding (config.js) now keeps it
// off the network; this keeps it consistent with the rest of the API anyway.
agentRouter.post('/', requireAuth, async (request, response) => {
  const { goal, model = AGENT_DEFAULT_MODEL, maxSteps } = request.body || {};

  if (!goal || !String(goal).trim()) {
    return response.status(400).json({ error: 'A "goal" describing the problem is required.' });
  }
  if (String(goal).length > MAX_GOAL_LENGTH) {
    return response.status(400).json({ error: `goal must be ${MAX_GOAL_LENGTH} characters or fewer.` });
  }
  let boundedMaxSteps;
  try {
    boundedMaxSteps = boundedInt(maxSteps, 'maxSteps', { min: 1, max: MAX_STEPS_CEILING, fallback: undefined });
  } catch (error) {
    return response.status(400).json({ error: error.message });
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
      maxSteps: boundedMaxSteps,
      signal: request.signal,
      onEvent: send,
    });
  } catch (error) {
    send({ type: 'error', payload: { message: error.message } });
  } finally {
    response.end();
  }
});
