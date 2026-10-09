import { executionRequestSignal } from '../orchestrator/requestSignal.js';
/**
 * @module routes/orchestrate
 * @description POST /api/orchestrate
 *
 * Entry point for the Agent Orchestrator. Handles task routing:
 *   - Simple tasks  → streamed redirect hint (use /api/chat)
 *   - Agentic tasks → runs AgentOrchestrator loop, streams NDJSON events
 *
 * Event types streamed to the client:
 *   router_decision   { mode, taskType, confidence, via }
 *   phase_transition  { phase, stepIndex? }
 *   plan              { summary, steps[] }
 *   step_start        { stepIndex, tool, action, params, description }
 *   step_result       { stepIndex, success, data, error, needsConfirmation }
 *   confirmation_req  { stepIndex, confirmationId, message }
 *   decision          { stepIndex, decision, reason }
 *   verify            { verified, summary }
 *   final             { success, summary, recommendation, stopped, ... }
 *   error             { message }
 */

import { Router } from 'express';
import { routeChatModel } from '../services/modelRouter.js';
import { classifyIntent } from '../services/intentRouter.js';
import { computerTask } from '../orchestrator/ComputerTaskPolicy.js';
import { modelRuntime } from '../services/modelRuntime.js';
import { inferenceGate } from '../services/inferenceGate.js';
import { isSpoolerIntent, REPAIR_TASK } from '../orchestrator/WindowsRepairCapability.js';
import { runOrchestrator, resumeOrchestrator } from '../orchestrator/AgentOrchestrator.js';
import { createCheckpointStore } from '../orchestrator/CheckpointStore.js';
import { cancelSessionRequest } from '../orchestrator/ExecutionSessions.js';
import { cancelToolRequest, inspectToolCall } from '../orchestrator/ToolEngineBridge.js';
import { requireAuth } from '../middleware/auth.js';
import { memoryRequest } from '../memory/runtime.js';
import { boundedInt } from '../lib/validate.js';
import { DEFAULT_MODEL } from '../ai/llmClient.js';
import { reviewCheckpoint, renewCheckpointConfirmation } from '../orchestrator/ManualRecovery.js';
import { ExecutionController } from '../orchestrator/ExecutionController.js';
import { claimSession } from '../orchestrator/ExecutionSessions.js';
import { cancelToolConfirmation } from '../orchestrator/ToolEngineBridge.js';

// The orchestrator always runs on the approved-tools route; the agent only picks which installed model suits the task.
const agentFor = (task) => {
  try {
    const text = String(task || '');
    return classifyIntent({
      message: text,
      computerRequest: computerTask(text) || { requiresTools: true },
    }).agentId;
  } catch {
    return undefined;
  }
};

export const orchestrateRouter = Router();
const checkpoints = createCheckpointStore();
orchestrateRouter.get('/checkpoints/:id/recovery', requireAuth, async (request, response) => {
  try {
    const saved = checkpoints.load(request.params.id, request.userId);
    const step = saved.state.plan[saved.state.currentStepIndex];
    const evidence = step?.idempotencyKey
      ? await inspectToolCall(step.idempotencyKey, request.userId)
      : null;
    const canReview =
      (['act', 'observe'].includes(saved.state.phase) ||
        (saved.state.phase === 'cancelled' &&
          saved.state.taskType === 'windows_repair_print_spooler_start')) &&
      !step?.observation &&
      !!step?.requestId &&
      ['unknown', 'uncertain'].includes(evidence?.status) &&
      evidence.executionActive === false;
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      checkpoint: saved,
      evidence,
      canReview,
      requiresHumanQuiescenceConfirmation: true,
    });
  } catch (error) {
    response.status(error.status || 500).json({ error: error.message });
  }
});
orchestrateRouter.post('/checkpoints/:id/reconcile', requireAuth, async (request, response) => {
  try {
    const { expectedRevision, requestId, idempotencyKey, toolCallId, review } = request.body || {};
    response.json(
      await reviewCheckpoint({
        store: checkpoints,
        sessionId: request.params.id,
        userId: request.userId,
        expectedRevision,
        requestId,
        idempotencyKey,
        toolCallId,
        review,
      }),
    );
  } catch (error) {
    response.status(error.status || 500).json({ error: error.message });
  }
});
orchestrateRouter.post(
  '/checkpoints/:id/confirmation/renew',
  requireAuth,
  async (request, response) => {
    try {
      const { expectedRevision, renewalId } = request.body || {};
      response.json(
        await renewCheckpointConfirmation({
          store: checkpoints,
          sessionId: request.params.id,
          userId: request.userId,
          expectedRevision,
          renewalId,
        }),
      );
    } catch (error) {
      response.status(error.status || 500).json({ error: error.message });
    }
  },
);

orchestrateRouter.get('/checkpoints/:id', requireAuth, (request, response) => {
  try {
    response.setHeader('Cache-Control', 'no-store');
    response.json(checkpoints.load(request.params.id, request.userId));
  } catch (error) {
    response.status(error.status || 400).json({ error: error.message });
  }
});
orchestrateRouter.post('/checkpoints/:id/resume', requireAuth, async (request, response) => {
  try {
    const { expectedRevision, confirmationId, model } = request.body || {};
    const saved = checkpoints.load(request.params.id, request.userId);
    const routing =
      saved.state.taskType === REPAIR_TASK
        ? null
        : await routeChatModel({
            userId: request.userId,
            computerRequest: { requiresTools: true },
            agentId: agentFor(saved.state.task),
          });
    const resume = () =>
      resumeOrchestrator({
        sessionId: request.params.id,
        userId: request.userId,
        expectedRevision,
        confirmationId,
        model: routing?.model || model,
        signal: executionRequestSignal(request, response),
        dependencies: { save: checkpoints },
      });
    const result = routing
      ? await inferenceGate.run(() => modelRuntime.run(routing, resume), {
          signal: executionRequestSignal(request, response),
        })
      : await resume();
    response.json(result);
  } catch (error) {
    response.status(error.status || 500).json({ error: error.message });
  }
});
orchestrateRouter.post('/checkpoints/:id/cancel', requireAuth, async (request, response) => {
  try {
    const saved = checkpoints.load(request.params.id, request.userId);
    const { requestId } = request.body || {};
    if (
      typeof requestId !== 'string' ||
      !saved.state.attempts.some((a) => a.request.requestId === requestId)
    )
      return response.status(400).json({ error: 'Unknown requestId.' });
    const propagated = cancelSessionRequest(request.params.id, request.userId, requestId);
    if (saved.state.mode !== 'orchestrator')
      return response.json({ cancelled: propagated, propagated, requestId });
    const result = await cancelToolRequest(requestId, request.userId);
    if (!propagated && saved.state.taskType === 'windows_repair_print_spooler_start') {
      const c = new ExecutionController('', {
        checkpoint: checkpoints.load(request.params.id, request.userId),
        save: checkpoints,
      });
      const lease = claimSession(c);
      try {
        const token = c.state.plan[c.state.currentStepIndex]?.observation?.confirmationId;
        c.stop('cancelled', 'User cancelled repair; admitted effects may require inspection.');
        if (token) await cancelToolConfirmation(token, request.userId);
      } finally {
        lease.release();
      }
    }
    response.json({ ...result, propagated });
  } catch (error) {
    response.status(error.status || 500).json({ error: error.message });
  }
});

const MAX_TASK_LENGTH = 2000;
const MAX_STEPS_CEILING = 20; // Hard ceiling across all clients
const MAX_RETRIES_CEILING = 3;

orchestrateRouter.post('/', requireAuth, memoryRequest, async (request, response) => {
  const { task, model = DEFAULT_MODEL, maxSteps, maxRetries } = request.body || {};

  // ── Input validation ─────────────────────────────────────────────────────
  if (!task || !String(task).trim()) {
    return response.status(400).json({ error: 'A "task" describing what to do is required.' });
  }
  if (String(task).length > MAX_TASK_LENGTH) {
    return response.status(400).json({
      error: `task must be ${MAX_TASK_LENGTH} characters or fewer.`,
    });
  }

  let boundedMaxSteps;
  let boundedMaxRetries;
  try {
    boundedMaxSteps = boundedInt(maxSteps, 'maxSteps', {
      min: 1,
      max: MAX_STEPS_CEILING,
      fallback: 10,
    });
    boundedMaxRetries = boundedInt(maxRetries, 'maxRetries', {
      min: 0,
      max: MAX_RETRIES_CEILING,
      fallback: 2,
    });
  } catch (err) {
    return response.status(400).json({ error: err.message });
  }

  // ── Response setup (NDJSON stream) ────────────────────────────────────────
  response.status(200);
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('X-Accel-Buffering', 'no');

  const signal = executionRequestSignal(request, response);
  const send = (event) => {
    try {
      response.write(`${JSON.stringify(event)}\n`);
    } catch {
      // Client disconnected mid-stream — ignore.
    }
  };

  // ── Run the orchestrator ──────────────────────────────────────────────────
  try {
    const routing = isSpoolerIntent(task)
      ? null
      : await routeChatModel({
          userId: request.userId,
          computerRequest: { requiresTools: true },
          agentId: agentFor(task),
        });
    const run = () =>
      runOrchestrator({
        task: String(task).trim(),
        model: routing?.model || model,
        maxSteps: boundedMaxSteps,
        maxRetries: boundedMaxRetries,
        signal,
        userId: request.userId,
        onEvent: send,
      });
    if (routing) await inferenceGate.run(() => modelRuntime.run(routing, run), { signal });
    else await run();
  } catch (err) {
    send({ type: 'error', payload: { message: err.message } });
  } finally {
    response.end();
  }
});
