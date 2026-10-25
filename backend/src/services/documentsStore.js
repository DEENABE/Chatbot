import { db } from './db.js';
import { deleteChunks } from './vectorService.js';
import { deleteDocumentStructure } from '../docqa/structuredStore.js';
import { ValidationError } from '../lib/validate.js';
import { isValidUuid } from '../lib/validateUuid.js';

function decode(row) {
  if (!row) return null;
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata || '{}');
  } catch {}
  return {
    ...metadata,
    ...row,
    metadata: undefined,
    scope: row.purpose,
    uploadedAt: row.createdAt,
  };
}

export function getDocument(documentId, userId) {
  return decode(
    db.prepare('SELECT * FROM documents WHERE id = ? AND userId = ?').get(documentId, userId),
  );
}

export async function getDocuments(
  userId,
  { purpose = 'knowledge', workspaceId, conversationId } = {},
) {
  const conditions = ['userId = ?', 'purpose = ?'];
  const values = [userId, purpose];
  if (workspaceId) {
    conditions.push('workspaceId = ?');
    values.push(workspaceId);
  }
  if (conversationId) {
    conditions.push('conversationId = ?');
    values.push(conversationId);
  }
  return db
    .prepare(`SELECT * FROM documents WHERE ${conditions.join(' AND ')} ORDER BY createdAt DESC`)
    .all(...values)
    .map(decode);
}

export async function appendDocuments(documents, userId) {
  const insert =
    db.prepare(`INSERT INTO documents (id,userId,name,size,createdAt,purpose,conversationId,workspaceId,metadata)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,size=excluded.size,metadata=excluded.metadata
    WHERE documents.userId=excluded.userId AND documents.purpose=excluded.purpose`);
  db.transaction(() => {
    for (const doc of documents) {
      insert.run(
        doc.id,
        userId,
        doc.name,
        doc.size ?? null,
        doc.createdAt || doc.uploadedAt || new Date().toISOString(),
        doc.purpose || doc.scope || 'knowledge',
        doc.conversationId || null,
        doc.workspaceId || null,
        JSON.stringify(doc),
      );
    }
  })();
}

export function attachmentSnapshot(document) {
  const {
    id,
    name,
    size,
    mimeType,
    scope,
    status,
    characters,
    chunks,
    keywordOnly,
    kind,
    mediaType,
    width,
    height,
  } = document;
  return {
    id,
    name,
    size,
    mimeType,
    scope,
    status,
    characters,
    chunks,
    keywordOnly,
    kind,
    mediaType,
    width,
    height,
  };
}

export function validateAttachmentIds(ids, userId, conversationId) {
  if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => !isValidUuid(id))) {
    throw new ValidationError('attachmentIds must contain at most 20 document IDs.');
  }
  return [...new Set(ids)].map((id) => {
    const doc = getDocument(id, userId);
    if (
      !doc ||
      doc.purpose !== 'attachment' ||
      (doc.conversationId && doc.conversationId !== conversationId)
    ) {
      throw new ValidationError('Attachment not found in this conversation.');
    }
    return attachmentSnapshot(doc);
  });
}

export function claimAttachments(ids, userId, conversationId) {
  const attachments = validateAttachmentIds(ids, userId, conversationId);
  for (const attachment of attachments) {
    db.prepare('UPDATE documents SET conversationId = ? WHERE id = ? AND userId = ?').run(
      conversationId,
      attachment.id,
      userId,
    );
  }
  return attachments;
}

export function conversationDocumentIds(userId, conversationId) {
  return db
    .prepare(
      "SELECT id FROM documents WHERE userId = ? AND purpose = 'attachment' AND conversationId = ? ORDER BY createdAt DESC LIMIT 100",
    )
    .all(userId, conversationId)
    .map((r) => r.id);
}

export function knowledgeDocumentIds(userId) {
  return db
    .prepare("SELECT id FROM documents WHERE userId = ? AND purpose = 'knowledge'")
    .all(userId)
    .map((r) => r.id);
}

export async function deleteDocument(documentId, userId) {
  // Only app-owned indexes/metadata are removed; originals are never unlinked.
  await deleteChunks(documentId, userId);
  deleteDocumentStructure(documentId, userId);
  db.prepare('DELETE FROM documents WHERE id = ? AND userId = ?').run(documentId, userId);
}
