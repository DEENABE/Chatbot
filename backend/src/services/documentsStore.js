import { db } from './db.js';
import { deleteChunks } from './vectorService.js';

export async function getDocuments(userId) {
  return db.prepare('SELECT * FROM documents WHERE userId = ? ORDER BY createdAt DESC').all(userId);
}

export async function appendDocuments(documents, userId) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO documents (id, userId, name, size, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((docs) => {
    for (const doc of docs) {
      const size = doc.size !== undefined ? doc.size : null;
      const createdAt = doc.createdAt || new Date().toISOString();
      insert.run(doc.id, userId, doc.name, size, createdAt);
    }
  });

  transaction(documents);
}

export async function deleteDocument(documentId, userId) {
  // Delete from metadata
  db.prepare('DELETE FROM documents WHERE id = ? AND userId = ?').run(documentId, userId);
  // Delete vector chunks from lancedb
  await deleteChunks(documentId, userId);
}
