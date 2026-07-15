import { Router } from 'express';
import { runRepair } from '../ai/Orchestrator.js';
import { DEFAULT_MODEL } from '../ai/llmClient.js';
import { addFeedback, getSessions, exportTrainingData } from '../ai/RepairLogger.js';

export const repairRouter = Router();

// Record user feedback on a repair ("did it work?") — becomes training signal.
repairRouter.post('/feedback', (request, response) => {
  const { sessionId, worked, note } = request.body || {};
  if (!sessionId || typeof worked !== 'boolean') {
    return response.status(400).json({ error: 'sessionId and boolean "worked" are required.' });
  }
  const ok = addFeedback(sessionId, worked, note || '');
  if (!ok) return response.status(404).json({ error: 'Repair session not found.' });
  response.json({ ok: true });
});

// List logged repair sessions (for review / analytics).
repairRouter.get('/sessions', (_request, response) => {
  response.json({ sessions: getSessions() });
});

// Export the fine-tuning-ready dataset (chat format).
repairRouter.get('/dataset', (_request, response) => {
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
      onEvent: send
    });
  } catch (error) {
    send({ type: 'error', payload: { message: error.message } });
  } finally {
    response.end();
  }
});
