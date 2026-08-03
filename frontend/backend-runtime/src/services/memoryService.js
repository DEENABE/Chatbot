import crypto from 'node:crypto';
import { db } from './db.js';

export async function getMemories(userId, type) {
  if (type) {
    return db.prepare('SELECT * FROM memories WHERE userId = ? AND type = ? ORDER BY createdAt DESC').all(userId, type);
  }
  return db.prepare('SELECT * FROM memories WHERE userId = ? ORDER BY createdAt DESC').all(userId);
}

export async function addMemory(userId, content, type) {
  const memory = {
    id: crypto.randomUUID(),
    userId,
    content: content.trim(),
    type,
    createdAt: new Date().toISOString()
  };

  db.prepare(`
    INSERT INTO memories (id, userId, content, type, createdAt)
    VALUES (@id, @userId, @content, @type, @createdAt)
  `).run(memory);

  return memory;
}

export async function deleteMemory(userId, memoryId) {
  db.prepare('DELETE FROM memories WHERE id = ? AND userId = ?').run(memoryId, userId);
}

export async function clearMemories(userId, type) {
  if (type) {
    db.prepare('DELETE FROM memories WHERE userId = ? AND type = ?').run(userId, type);
  } else {
    db.prepare('DELETE FROM memories WHERE userId = ?').run(userId);
  }
}
