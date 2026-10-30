import { randomUUID } from 'node:crypto';
import { safeText, identifier, bytes, memoryError } from './validation.js';
export class ShortTermMemoryService {
  constructor(repository, { maxEntries = 24, maxBytes = 16000, ttlMs = 86400000 } = {}) {
    this.r = repository;
    this.limits = { maxEntries, maxBytes, ttlMs };
    for (const n of Object.values(this.limits))
      if (!Number.isSafeInteger(n) || n < 1) throw memoryError('Invalid memory limits.');
  }
  compactShortTermMemory(userId, conversationId) {
    this.r.conversation(userId, conversationId);
    const db = this.r.db,
      now = this.r.now();
    return db.transaction(() => {
      const expired = db
        .prepare('DELETE FROM short_term_memories WHERE user_id=? AND expires_at<=?')
        .run(userId, now).changes;
      if (expired)
        this.r.audit(userId, 'MEMORY_EXPIRED', 'short_term', {
          conversationId,
        });
      const rows = db
        .prepare(
          'SELECT * FROM short_term_memories WHERE user_id=? AND conversation_id=? ORDER BY updated_at DESC,id DESC',
        )
        .all(userId, conversationId);
      let size = 0;
      for (const [i, row] of rows.entries()) {
        size += bytes(row.value);
        if (i >= this.limits.maxEntries || size > this.limits.maxBytes)
          db.prepare('DELETE FROM short_term_memories WHERE id=? AND user_id=?').run(
            row.id,
            userId,
          );
      }
    })();
  }
  getShortTermMemory(userId, conversationId) {
    this.compactShortTermMemory(userId, conversationId);
    return this.r.db
      .prepare(
        'SELECT id,key,value,source,created_at AS createdAt,updated_at AS updatedAt,expires_at AS expiresAt FROM short_term_memories WHERE user_id=? AND conversation_id=? ORDER BY updated_at,id',
      )
      .all(userId, conversationId)
      .map((r) => ({ ...r, memoryType: 'short_term' }));
  }
  addShortTermMemory(
    userId,
    conversationId,
    { key = randomUUID(), value, source = 'conversation' },
    scope = {},
  ) {
    this.r.conversation(userId, conversationId);
    identifier(key);
    const clean = safeText(value, 4000);
    if (!['conversation', 'tool_observation', 'task_context'].includes(source)) throw memoryError();
    const now = this.r.now();
    this.r.db.transaction(() => {
      const prior = this.r.db
        .prepare(
          'SELECT id FROM short_term_memories WHERE user_id=? AND conversation_id=? AND key=?',
        )
        .get(userId, conversationId, key);
      this.r.db
        .prepare(
          'INSERT INTO short_term_memories VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,conversation_id,key) DO UPDATE SET value=excluded.value,source=excluded.source,updated_at=excluded.updated_at,expires_at=excluded.expires_at',
        )
        .run(
          randomUUID(),
          userId,
          conversationId,
          key,
          clean,
          source,
          now,
          now,
          now + this.limits.ttlMs,
        );
      this.r.audit(userId, prior ? 'MEMORY_UPDATED' : 'MEMORY_CREATED', 'short_term', {
        ...scope,
        conversationId,
      });
      this.compactShortTermMemory(userId, conversationId);
    })();
  }
  updateShortTermMemory(userId, conversationId, key, value) {
    return this.addShortTermMemory(userId, conversationId, { key, value });
  }
  clearShortTermMemory(userId, conversationId) {
    this.r.conversation(userId, conversationId);
    this.r.db.transaction(() => {
      this.r.db
        .prepare('DELETE FROM short_term_memories WHERE user_id=? AND conversation_id=?')
        .run(userId, conversationId);
      this.r.audit(userId, 'MEMORY_DELETED', 'short_term', { conversationId });
    })();
  }
}
