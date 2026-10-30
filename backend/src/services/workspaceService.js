import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { validateWorkspaceRoot } from './workspacePaths.js';
import { getDocuments, deleteDocument } from './documentsStore.js';

db.exec(`CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, name TEXT NOT NULL, root TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0, indexState TEXT NOT NULL DEFAULT 'idle',
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_active_user ON workspaces(userId) WHERE active = 1;`);
// A stopped backend cannot retain a live indexing job. Completed documents
// remain available and the next user action can resume remaining files.
db.prepare("UPDATE workspaces SET indexState = 'paused' WHERE indexState = 'indexing'").run();

const present = (row) => row && { ...row, active: Boolean(row.active) };
export function getWorkspaceForUser(userId, id) {
  const workspace = present(
    db.prepare('SELECT * FROM workspaces WHERE id = ? AND userId = ?').get(id, userId),
  );
  if (!workspace) throw Object.assign(new Error('Workspace not found.'), { status: 404 });
  return workspace;
}
export async function listWorkspaces(userId) {
  const rows = db
    .prepare('SELECT * FROM workspaces WHERE userId = ? ORDER BY createdAt ASC')
    .all(userId);
  return Promise.all(
    rows.map(async (row) => {
      let available = true,
        error = null;
      try {
        await validateWorkspaceRoot(row.root);
      } catch {
        available = false;
        error = 'The directory is unavailable. Reconnect the drive or choose a new directory.';
      }
      return { ...present(row), available, error };
    }),
  );
}
export async function saveWorkspace(userId, input, id = null) {
  const existing = id ? getWorkspaceForUser(userId, id) : null;
  const validated = await validateWorkspaceRoot(input.root ?? existing?.root);
  const name = String(input.name ?? existing?.name ?? validated.name).trim();
  if (!name || name.length > 100 || /[\x00-\x1f]/.test(name))
    throw Object.assign(new Error('Workspace name must contain 1 to 100 characters.'), {
      status: 400,
    });
  if (existing && existing.root !== validated.root) {
    // A changed root must not retrieve documents from the previous directory.
    // Removing metadata/search entries never removes files in either root.
    for (const document of await getDocuments(userId, {
      purpose: 'workspace',
      workspaceId: id,
    }))
      await deleteDocument(document.id, userId);
  }
  const now = new Date().toISOString();
  const workspaceId = id || randomUUID();
  db.transaction(() => {
    if (!existing) db.prepare('UPDATE workspaces SET active = 0 WHERE userId = ?').run(userId);
    db.prepare(
      `INSERT INTO workspaces (id,userId,name,root,active,indexState,createdAt,updatedAt) VALUES (?,?,?,?,?,'idle',?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,root=excluded.root,indexState='idle',updatedAt=excluded.updatedAt`,
    ).run(
      workspaceId,
      userId,
      name,
      validated.root,
      existing?.active ? 1 : existing ? 0 : 1,
      existing?.createdAt || now,
      now,
    );
  })();
  return getWorkspaceForUser(userId, workspaceId);
}
export function activateWorkspace(userId, id) {
  getWorkspaceForUser(userId, id);
  db.transaction(() => {
    db.prepare('UPDATE workspaces SET active = 0 WHERE userId = ?').run(userId);
    db.prepare('UPDATE workspaces SET active = 1,updatedAt = ? WHERE userId = ? AND id = ?').run(
      new Date().toISOString(),
      userId,
      id,
    );
  })();
  return getWorkspaceForUser(userId, id);
}
export function setWorkspaceIndexState(userId, id, state) {
  db.prepare('UPDATE workspaces SET indexState = ?,updatedAt = ? WHERE userId = ? AND id = ?').run(
    state,
    new Date().toISOString(),
    userId,
    id,
  );
}
