import { randomUUID } from 'node:crypto';
import { identifier, memoryError } from './validation.js';
export class MemoryRepository {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
  }
  user(userId) {
    identifier(userId);
    if (!this.db.prepare('SELECT 1 FROM users WHERE id=?').get(userId))
      throw memoryError('Memory not found.', 404);
    return userId;
  }
  conversation(userId, id) {
    this.user(userId);
    identifier(id);
    if (!this.db.prepare('SELECT 1 FROM chats WHERE id=? AND userId=?').get(id, userId))
      throw memoryError('Conversation not found.', 404);
    return id;
  }
  audit(userId, event, type, scope = {}) {
    const id = (value) =>
      typeof value === 'string' && /^[a-zA-Z0-9:._-]{1,240}$/.test(value) ? value : null;
    this.db
      .prepare(
        'INSERT INTO memory_audit(user_id,event,memory_type,request_id,conversation_id,task_id,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        userId,
        event,
        type,
        id(scope.requestId),
        id(scope.conversationId),
        id(scope.taskId),
        this.now(),
      );
    this.db
      .prepare(
        'DELETE FROM memory_audit WHERE user_id=? AND id NOT IN (SELECT id FROM memory_audit WHERE user_id=? ORDER BY id DESC LIMIT 1000)',
      )
      .run(userId, userId);
  }
  longRows(userId) {
    this.user(userId);
    return this.db
      .prepare(
        'SELECT * FROM long_term_memories WHERE user_id=? ORDER BY updated_at DESC,id LIMIT 500',
      )
      .all(userId)
      .map(this.longView);
  }
  longView(r) {
    return {
      id: r.id,
      memoryType: 'long_term',
      userId: r.user_id,
      key: r.key,
      value: r.value,
      category: r.category,
      source: r.source,
      confidence: r.confidence,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  longById(userId, id) {
    this.user(userId);
    identifier(id);
    const r = this.db
      .prepare('SELECT * FROM long_term_memories WHERE user_id=? AND id=?')
      .get(userId, id);
    if (!r) throw memoryError('Memory not found.', 404);
    return this.longView(r);
  }
  putLong(userId, c, scope = {}) {
    return this.db.transaction(() => {
      this.user(userId);
      const prior = this.db
        .prepare('SELECT * FROM long_term_memories WHERE user_id=? AND key=?')
        .get(userId, c.key);
      if (
        !prior &&
        this.db.prepare('SELECT count(*) AS n FROM long_term_memories WHERE user_id=?').get(userId)
          .n >= 500
      )
        throw memoryError('Long-term memory limit reached.', 409);
      const now = this.now(),
        id = prior?.id || randomUUID();
      this.db
        .prepare(
          `INSERT INTO long_term_memories VALUES(?,?,?,?,?,'explicit_user',1,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,category=excluded.category,source=excluded.source,confidence=excluded.confidence,updated_at=excluded.updated_at`,
        )
        .run(id, userId, c.category, c.key, c.value, now, now);
      this.audit(userId, prior ? 'MEMORY_UPDATED' : 'MEMORY_CREATED', 'long_term', scope);
      if (prior && prior.value !== c.value)
        this.audit(userId, 'MEMORY_CONFLICT_RESOLVED', 'long_term', scope);
      return this.longById(userId, id);
    })();
  }
  deleteLong(userId, id, scope = {}) {
    this.longById(userId, id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM long_term_memories WHERE user_id=? AND id=?').run(userId, id);
      this.audit(userId, 'MEMORY_DELETED', 'long_term', scope);
    })();
  }
}
