import { identifier, publicText, memoryError } from './validation.js';
/** Deliberately no executor, checkpoint loader or approval-store dependency. */
export function taskProjection(state) {
  const step = (s) => ({
    tool: publicText(s.tool, 80),
    action: publicText(s.action, 80),
    status: s.status,
    toolCallId: publicText(s.toolCallId, 240),
  });
  const observations = (state.attempts || []).slice(-24).map((a) => ({
    requestId: publicText(a.request?.requestId, 240),
    toolCallId: publicText(a.request?.toolCallId, 240),
    tool: publicText(a.request?.tool, 80),
    action: publicText(a.request?.action, 80),
    success: a.observation?.success ?? null,
    errorCode: publicText(a.observation?.error?.code, 100),
    verificationStatus: publicText(a.observation?.data?.verificationStatus, 60),
    summary: publicText(a.observation?.data?.summary, 500),
    permission: a.observation?.permission
      ? {
          decision: publicText(a.observation.permission.decision, 30),
          risk: publicText(a.observation.permission.risk, 30),
          reasonCode: publicText(a.observation.permission.reasonCode, 100),
        }
      : null,
    diagnosis:
      a.request?.action === 'inspectSpooler'
        ? {
            eligible: a.observation?.data?.eligible === true,
            reason: publicText(a.observation?.data?.reason, 100),
            serviceStatus: Number.isInteger(a.observation?.data?.sample?.status)
              ? a.observation.data.sample.status
              : null,
          }
        : null,
  }));
  return {
    taskId: state.sessionId,
    taskType: publicText(state.taskType, 100),
    goal: publicText(state.task, 1000),
    phase: state.phase,
    retryCount: state.retryCount,
    completedSteps: state.plan
      .filter((s) => s.status === 'done')
      .map(step)
      .slice(-24),
    failedSteps: state.plan
      .filter((s) => s.status === 'failed')
      .map(step)
      .slice(-24),
    pendingSteps: state.plan
      .filter((s) => !['done', 'failed'].includes(s.status))
      .map(step)
      .slice(0, 24),
    selectedCapability:
      state.taskType === 'windows_repair_print_spooler_start'
        ? 'windows.printSpooler.start.v1'
        : null,
    observations,
    result: state.verdict
      ? {
          success: state.verdict.success === true,
          summary: publicText(state.verdict.summary, 1000),
          scope: publicText(state.verdict.scope, 100),
        }
      : null,
    checkpointReference: state.sessionId,
    checkpointRevision: state.revision,
    authority: 'context_only',
  };
}
export class TaskMemoryService {
  constructor(repository) {
    this.r = repository;
  }
  createTaskMemory(userId, state, scope = {}) {
    return this.updateTaskMemory(userId, state, scope);
  }
  updateTaskMemory(userId, state, { conversationId, requestId } = {}) {
    this.r.user(userId);
    identifier(state.sessionId);
    if (state.ownerId !== userId || !Number.isSafeInteger(state.revision) || state.revision < 0)
      throw memoryError();
    if (conversationId) this.r.conversation(userId, conversationId);
    const value = JSON.stringify(taskProjection(state)),
      db = this.r.db,
      now = this.r.now();
    return db.transaction(() => {
      const prior = db
        .prepare('SELECT user_id,revision,conversation_id FROM task_memories WHERE task_id=?')
        .get(state.sessionId);
      if (prior && prior.user_id !== userId) throw memoryError('Task not found.', 404);
      if (prior && prior.revision >= state.revision)
        return this.getTaskMemory(userId, state.sessionId);
      if (prior?.conversation_id && conversationId && prior.conversation_id !== conversationId)
        throw memoryError('Task conversation cannot be changed.', 409);
      db.prepare(
        'INSERT INTO task_memories VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,value=excluded.value,updated_at=excluded.updated_at',
      ).run(
        state.sessionId,
        userId,
        prior?.conversation_id ?? conversationId ?? null,
        state.revision,
        value,
        now,
        now,
      );
      this.appendTaskObservation(userId, state.sessionId, state.revision, {
        phase: state.phase,
        completed: state.plan.filter((s) => s.status === 'done').length,
      });
      this.r.audit(userId, prior ? 'MEMORY_UPDATED' : 'MEMORY_CREATED', 'task', {
        taskId: state.sessionId,
        conversationId,
        requestId,
      });
      return this.getTaskMemory(userId, state.sessionId);
    })();
  }
  appendTaskObservation(userId, taskId, revision, event) {
    this.getTaskMemory(userId, taskId);
    if (
      !Number.isSafeInteger(revision) ||
      !Number.isSafeInteger(event.completed) ||
      typeof event.phase !== 'string'
    )
      throw memoryError();
    this.r.db.prepare('INSERT OR IGNORE INTO task_memory_events VALUES(?,?,?,?,?,?)').run(
      `${taskId}:${revision}`,
      taskId,
      userId,
      revision,
      JSON.stringify({
        phase: publicText(event.phase, 60),
        completed: event.completed,
      }),
      this.r.now(),
    );
    this.r.db
      .prepare(
        'DELETE FROM task_memory_events WHERE user_id=? AND task_id=? AND revision NOT IN (SELECT revision FROM task_memory_events WHERE user_id=? AND task_id=? ORDER BY revision DESC LIMIT 100)',
      )
      .run(userId, taskId, userId, taskId);
  }
  getTaskMemory(userId, taskId) {
    this.r.user(userId);
    identifier(taskId);
    const r = this.r.db
      .prepare('SELECT * FROM task_memories WHERE task_id=? AND user_id=?')
      .get(taskId, userId);
    if (!r) throw memoryError('Task not found.', 404);
    return {
      ...JSON.parse(r.value),
      memoryType: 'task',
      conversationId: r.conversation_id,
      updatedAt: r.updated_at,
    };
  }
  listTaskMemory(userId, conversationId) {
    this.r.conversation(userId, conversationId);
    return this.r.db
      .prepare(
        'SELECT task_id FROM task_memories WHERE user_id=? AND conversation_id=? ORDER BY updated_at DESC LIMIT 10',
      )
      .all(userId, conversationId)
      .map((r) => this.getTaskMemory(userId, r.task_id));
  }
  completeTaskMemory(userId, state, scope) {
    if (!['done', 'error'].includes(state.phase)) throw memoryError();
    return this.updateTaskMemory(userId, state, scope);
  }
  cancelTaskMemory(userId, state, scope) {
    if (state.phase !== 'cancelled') throw memoryError();
    return this.updateTaskMemory(userId, state, scope);
  }
}
