import { randomUUID } from 'node:crypto';
import { fail } from './contracts.js';
import { checkpoint, restoreCheckpoint, transition } from '../orchestrator/AgentState.js';

/** Uses the same authenticated local SQLite database; model text cannot write task records. */
export class CodingTaskRepository {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS coding_tasks(id TEXT PRIMARY KEY,userId TEXT NOT NULL,workspaceId TEXT NOT NULL,data TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS coding_tasks_owner ON coding_tasks(userId,updatedAt);
      CREATE TABLE IF NOT EXISTS coding_grants(userId TEXT NOT NULL,workspaceId TEXT NOT NULL,binding TEXT NOT NULL,writeAllowed INTEGER NOT NULL,PRIMARY KEY(userId,workspaceId));
      CREATE TABLE IF NOT EXISTS coding_audit(id TEXT PRIMARY KEY,userId TEXT NOT NULL,workspaceId TEXT NOT NULL,taskId TEXT,event TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coding_tool_approvals(id TEXT PRIMARY KEY,userId TEXT NOT NULL,workspaceId TEXT NOT NULL,data TEXT NOT NULL);`);
  }
  save(userId, task) {
    this.db
      .prepare(
        'INSERT INTO coding_tasks(id,userId,workspaceId,data,updatedAt) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt WHERE coding_tasks.userId=excluded.userId',
      )
      .run(task.id, userId, task.workspaceId, JSON.stringify(task), new Date().toISOString());
    return task;
  }
  get(userId, id) {
    const row = this.db
      .prepare('SELECT data FROM coding_tasks WHERE id=? AND userId=?')
      .get(id, userId);
    if (!row) throw fail('TASK_NOT_FOUND', 'Coding task not found.', 404);
    return JSON.parse(row.data);
  }
  list(userId) {
    return this.db
      .prepare('SELECT data FROM coding_tasks WHERE userId=? ORDER BY updatedAt DESC LIMIT 50')
      .all(userId)
      .map((r) => JSON.parse(r.data));
  }
  recoverInterrupted() {
    const rows = this.db.prepare('SELECT id,userId,data FROM coding_tasks').all();
    for (const row of rows) {
      const task = JSON.parse(row.data);
      if (['running', 'waiting_approval'].includes(task.status)) {
        task.status = 'blocked';
        task.reason = 'INTERRUPTED';
        task.approvals = [];
        if (task.state) {
          const state = restoreCheckpoint(task.state);
          if (!['done', 'error', 'cancelled'].includes(state.phase))
            task.state = checkpoint(transition(state, 'error', { reason: 'INTERRUPTED' }));
          task.phase = task.state.state.phase;
        }
        for (const pending of this.db
          .prepare('SELECT id,data FROM coding_tool_approvals WHERE userId=? AND workspaceId=?')
          .all(row.userId, task.workspaceId)) {
          if (JSON.parse(pending.data).taskId === task.id)
            this.db.prepare('DELETE FROM coding_tool_approvals WHERE id=?').run(pending.id);
        }
        task.summary =
          'The application restarted during execution. Review changes and start a new task; pending effects are never replayed automatically.';
        this.save(row.userId, task);
      }
    }
  }
  grant(userId, workspaceId, binding, allowed) {
    this.db
      .prepare(
        'INSERT INTO coding_grants(userId,workspaceId,binding,writeAllowed) VALUES(?,?,?,?) ON CONFLICT(userId,workspaceId) DO UPDATE SET binding=excluded.binding,writeAllowed=excluded.writeAllowed',
      )
      .run(userId, workspaceId, binding, allowed ? 1 : 0);
  }
  writeAllowed(userId, workspaceId, binding) {
    const row = this.db
      .prepare('SELECT binding,writeAllowed FROM coding_grants WHERE userId=? AND workspaceId=?')
      .get(userId, workspaceId);
    return !!row?.writeAllowed && row.binding === binding;
  }
  audit(userId, workspaceId, taskId, event) {
    // Only action identity, versions, duration and error codes; no prompts/file content/credentials.
    this.db
      .prepare(
        'INSERT INTO coding_audit(id,userId,workspaceId,taskId,event,createdAt) VALUES(?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        userId,
        workspaceId,
        taskId || null,
        JSON.stringify(event),
        new Date().toISOString(),
      );
  }
  approval(userId, workspaceId, data, id = randomUUID()) {
    this.db
      .prepare('INSERT INTO coding_tool_approvals(id,userId,workspaceId,data) VALUES(?,?,?,?)')
      .run(id, userId, workspaceId, JSON.stringify(data));
    return id;
  }
  clearTaskApprovals(userId, workspaceId, taskId) {
    for (const row of this.db
      .prepare('SELECT id,data FROM coding_tool_approvals WHERE userId=? AND workspaceId=?')
      .all(userId, workspaceId)) {
      if (JSON.parse(row.data).taskId === taskId)
        this.db.prepare('DELETE FROM coding_tool_approvals WHERE id=?').run(row.id);
    }
  }
  takeApproval(userId, workspaceId, id) {
    const data = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT data FROM coding_tool_approvals WHERE id=? AND userId=? AND workspaceId=?')
        .get(id, userId, workspaceId);
      if (!row)
        throw fail('APPROVAL_INVALID', 'This approval is missing or was already used.', 409);
      this.db
        .prepare('DELETE FROM coding_tool_approvals WHERE id=? AND userId=? AND workspaceId=?')
        .run(id, userId, workspaceId);
      const data = JSON.parse(row.data);
      return data;
    })();
    if (data.expiresAt < Date.now())
      throw fail('APPROVAL_EXPIRED', 'Review this action again.', 409);
    return data;
  }
}
