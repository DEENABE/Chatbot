// Additive migration: existing knowledge, history and accounts remain intact.
export function migrateDocuments(db) {
  for (const [table, columns] of Object.entries({
    documents: {
      purpose: "TEXT NOT NULL DEFAULT 'knowledge'",
      conversationId: 'TEXT',
      workspaceId: 'TEXT',
      metadata: "TEXT NOT NULL DEFAULT '{}'",
    },
    messages: { attachments: 'TEXT' },
  })) {
    const existing = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
    );
    for (const [name, declaration] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
    }
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_documents_scope ON documents(userId,purpose,conversationId,workspaceId)',
  );
  db.exec(`CREATE TABLE IF NOT EXISTS document_images (
    documentId TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    mimeType TEXT NOT NULL, bytes BLOB NOT NULL
  )`);
}
