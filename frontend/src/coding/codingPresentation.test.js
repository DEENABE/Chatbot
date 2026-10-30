import test from 'node:test';
import assert from 'node:assert/strict';
import { taskActivity, taskDiagnostic, conversationTurns } from './codingPresentation.js';

test('legacy failed tasks show recovery guidance and known blockers explain the next action', () => {
  assert.match(taskDiagnostic({ status: 'error', reason: 'CODING_ERROR' }).hint, /Retry/);
  assert.match(
    taskDiagnostic({ status: 'blocked', reason: 'ISOLATION_UNAVAILABLE' }).hint,
    /terminal/,
  );
  assert.equal(taskDiagnostic({ status: 'done' }), null);
  assert.equal(
    taskDiagnostic({ status: 'blocked', error: { code: 'OLLAMA_UNAVAILABLE', message: 'Offline' } })
      .message,
    'Offline',
  );
});

test('activity distinguishes actual success, failed observations and pending approvals', () => {
  const attempt = (id, observation) => ({
    attemptId: id,
    request: { tool: 'fs', action: 'write', params: { path: 'app.jsx' } },
    observation,
  });
  const result = taskActivity({
    state: {
      state: {
        attempts: [
          attempt('1', null),
          attempt('2', { success: false, needsConfirmation: true }),
          attempt('3', { success: false, error: { message: 'Conflict' } }),
          attempt('4', { success: true }),
        ],
      },
    },
  });
  assert.deepEqual(
    result.map((a) => a.status),
    ['running', 'approval', 'failed', 'done'],
  );
  assert.equal(result[2].error, 'Conflict');
  assert.equal(result[0].path, 'app.jsx');
});

test('polled task replaces its stale history entry without duplicating conversation turns', () => {
  const history = [
    { id: '2', createdAt: '2026-10-25T02:00:00Z', status: 'running' },
    { id: '1', createdAt: '2026-10-25T01:00:00Z' },
  ];
  const current = { ...history[0], status: 'done' };
  const result = conversationTurns(history, current);
  assert.deepEqual(
    result.map((task) => task.id),
    ['1', '2'],
  );
  assert.equal(result[1].status, 'done');
});
