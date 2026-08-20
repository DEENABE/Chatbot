import { Router } from 'express';
import { runRepair } from '../ai/Orchestrator.js';
import { DEFAULT_MODEL } from '../ai/llmClient.js';
import { addFeedback, getSessions, exportTrainingData } from '../ai/RepairLogger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

export const repairRouter = Router();

// Every route here either runs unattended PowerShell or reads/exports
// diagnostic session data, so all of them require a verified session — none
// of them had any auth check at all before.
repairRouter.use(requireAuth);

// Record user feedback on a repair ("did it work?") — becomes training signal.
// A session only carries a userId when it was logged after that field was
// introduced (Step 5); addFeedback treats a userId-less session as legacy/
// unowned and allows it, but otherwise refuses to attach feedback to a
// session that belongs to a different account (Step 17: sessionId IDOR).
repairRouter.post('/feedback', (request, response) => {
  const { sessionId, worked, note } = request.body || {};
  if (!sessionId || typeof worked !== 'boolean') {
    return response.status(400).json({ error: 'sessionId and boolean "worked" are required.' });
  }
  const ok = addFeedback(sessionId, worked, note || '', request.userId);
  if (!ok) return response.status(404).json({ error: 'Repair session not found.' });
  response.json({ ok: true });
});

// List logged repair sessions (for review / analytics). This is a shared
// training corpus spanning every user's repair history — Step 4/10: a list
// endpoint must only return records the caller is authorized to see, and
// "every user's diagnostic history" is not something a regular account is
// authorized to browse, so this is admin-only.
repairRouter.get('/sessions', requireAdmin, (_request, response) => {
  response.json({ sessions: getSessions() });
});

// Export the fine-tuning-ready dataset (chat format) — same cross-user
// exposure as /sessions above, same admin-only restriction.
repairRouter.get('/dataset', requireAdmin, (_request, response) => {
  response.json({ examples: exportTrainingData() });
});

/**
 * POST /api/repair
 * Body: { goal: string, model?: string, maxSteps?: number }
 *
 * Streams the enterprise repair pipeline as NDJSON. Event types:
 *   intent | plan | agent | thought | command | output | blocked | final | error | aborted
 */
repairRouter.post('/', async (request, response) => {
  const { goal, model = DEFAULT_MODEL, maxSteps } = request.body || {};

  if (!goal || !String(goal).trim()) {
    return response.status(400).json({ error: 'A "goal" describing the problem is required.' });
  }

  response.status(200);
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('X-Accel-Buffering', 'no');

  const send = (event) => response.write(`${JSON.stringify(event)}\n`);

  try {
    await runRepair({
      goal: String(goal).trim(),
      model,
      maxSteps: Number(maxSteps) || undefined,
      signal: request.signal,
      userId: request.userId,
      onEvent: send
    });
  } catch (error) {
    send({ type: 'error', payload: { message: error.message } });
  } finally {
    response.end();
  }
});
