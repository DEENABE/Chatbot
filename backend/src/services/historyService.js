import crypto from 'node:crypto';
import { db } from './db.js';

export async function getConversations(userId) {
  if (!userId) return [];

  const chats = db.prepare(`
    SELECT * FROM chats 
    WHERE userId = ? 
    ORDER BY isPinned DESC, updatedAt DESC
  `).all(userId);

  return chats.map(chat => ({
    id: chat.id,
    userId: chat.userId,
    title: chat.title,
    folderId: chat.folderId,
    isPinned: Boolean(chat.isPinned),
    isBookmarked: Boolean(chat.isBookmarked),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messages: getMessages(chat.id)
  }));
}

export function getMessages(chatId) {
  const messages = db.prepare('SELECT * FROM messages WHERE chatId = ? ORDER BY createdAt ASC').all(chatId);
  return messages.map(msg => ({
    id: msg.id,
    chatId: msg.chatId,
    role: msg.role,
    content: msg.content,
    sources: msg.sources,
    createdAt: msg.createdAt
  }));
}

export async function appendHistory(entry, userId) {
  const { conversationId, role, content, sources } = entry;
  const now = new Date().toISOString();

  // 1. Ensure the conversation exists
  let chatExists = db.prepare('SELECT 1 FROM chats WHERE id = ? AND userId = ?').get(conversationId, userId);
  if (!chatExists) {
    const title = role === 'user' ? content.slice(0, 80) : 'New Conversation';
    db.prepare(`
      INSERT INTO chats (id, userId, title, folderId, isPinned, isBookmarked, createdAt, updatedAt)
      VALUES (?, ?, ?, NULL, 0, 0, ?, ?)
    `).run(conversationId, userId, title, now, now);
  } else {
    db.prepare('UPDATE chats SET updatedAt = ? WHERE id = ?').run(now, conversationId);
  }

  // 2. Insert message
  const messageId = crypto.randomUUID();
  const sourcesStr = sources ? JSON.stringify(sources) : null;
  db.prepare(`
    INSERT INTO messages (id, chatId, role, content, sources, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(messageId, conversationId, role, content, sourcesStr, now);

  // If this was the first user message, update title
  if (role === 'user') {
    const messagesCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE chatId = ?').get(conversationId);
    if (messagesCount && messagesCount.count === 1) {
      const newTitle = content.slice(0, 80) || 'New Conversation';
      db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(newTitle, conversationId);
    }
  }

  return {
    id: messageId,
    chatId: conversationId,
    role,
    content,
    sources: sourcesStr,
    createdAt: now
  };
}

export async function deleteConversation(conversationId, userId) {
  db.prepare('DELETE FROM chats WHERE id = ? AND userId = ?').run(conversationId, userId);
}

export async function updateConversation(conversationId, userId, updates) {
  const fields = [];
  const values = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.folderId !== undefined) {
    fields.push('folderId = ?');
    values.push(updates.folderId);
  }
  if (updates.isPinned !== undefined) {
    fields.push('isPinned = ?');
    values.push(updates.isPinned ? 1 : 0);
  }
  if (updates.isBookmarked !== undefined) {
    fields.push('isBookmarked = ?');
    values.push(updates.isBookmarked ? 1 : 0);
  }

  if (fields.length === 0) return;

  // Bind updatedAt explicitly rather than using the SQL CURRENT_TIMESTAMP
  // keyword: every other timestamp in this app is `new Date().toISOString()`
  // (e.g. line 40 above), and SQLite's own CURRENT_TIMESTAMP produces a
  // different, non-'Z'-suffixed format — mixing the two would make
  // updatedAt parse as a different timezone than createdAt for the same row.
  fields.push('updatedAt = ?');
  values.push(new Date().toISOString());

  values.push(conversationId, userId);
  db.prepare(`
    UPDATE chats
    SET ${fields.join(', ')}
    WHERE id = ? AND userId = ?
  `).run(...values);
}

// Folders Management
export async function getFolders(userId) {
  return db.prepare('SELECT * FROM folders WHERE userId = ? ORDER BY name ASC').all(userId);
}

export async function createFolder(name, userId) {
  const folder = {
    id: crypto.randomUUID(),
    userId,
    name: name.trim(),
    createdAt: new Date().toISOString()
  };

  db.prepare('INSERT INTO folders (id, userId, name, createdAt) VALUES (@id, @userId, @name, @createdAt)').run(folder);
  return folder;
}

export async function updateFolder(folderId, name, userId) {
  db.prepare('UPDATE folders SET name = ? WHERE id = ? AND userId = ?').run(name.trim(), folderId, userId);
}

export async function deleteFolder(folderId, userId) {
  db.prepare('DELETE FROM folders WHERE id = ? AND userId = ?').run(folderId, userId);
}

// Search
export async function searchChats(query, userId) {
  const searchTerm = `%${query}%`;
  const chats = db.prepare(`
    SELECT DISTINCT c.* FROM chats c
    LEFT JOIN messages m ON c.id = m.chatId
    WHERE c.userId = ? AND (c.title LIKE ? OR m.content LIKE ?)
    ORDER BY c.updatedAt DESC
  `).all(userId, searchTerm, searchTerm);

  return chats.map(chat => ({
    id: chat.id,
    userId: chat.userId,
    title: chat.title,
    folderId: chat.folderId,
    isPinned: Boolean(chat.isPinned),
    isBookmarked: Boolean(chat.isBookmarked),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt
  }));
}
