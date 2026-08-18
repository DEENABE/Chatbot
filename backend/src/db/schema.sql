-- Real SQLite schema, replacing the hand-rolled JSON-file shim that used to
-- sit behind this same `db.prepare(sql).get/all/run()` interface. That shim
-- parsed SQL with regexes and only ever matched the FIRST condition in a
-- compound WHERE clause — so `WHERE id = ? AND userId = ?` silently ran as
-- `WHERE id = ?`, letting any caller who knew a resource's id delete or read
-- another user's data regardless of ownership (RBAC-01 in the security
-- audit). Every ownership check below is enforced by SQLite for real.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  displayName TEXT,
  email TEXT,
  department TEXT,
  role TEXT NOT NULL DEFAULT 'Employee',
  permissions TEXT NOT NULL DEFAULT '[]',
  passwordHash TEXT NOT NULL,
  salt TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Server-side session tokens (sessionService.js). Only a hash of the bearer
-- token is ever stored here — see sessionService.js for why.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tokenHash TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_folders_userId ON folders(userId);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  -- A deleted folder un-categorizes its chats rather than leaving them
  -- pointing at a folder id that no longer exists.
  folderId TEXT REFERENCES folders(id) ON DELETE SET NULL,
  isPinned INTEGER NOT NULL DEFAULT 0,
  isBookmarked INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_userId ON chats(userId);
CREATE INDEX IF NOT EXISTS idx_chats_folderId ON chats(folderId);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT,
  sources TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chatId ON messages(chatId);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  type TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_userId ON memories(userId);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_userId ON documents(userId);

-- Everything below is dead weight kept only so the standalone, unmounted
-- ingest CLI (`npm run ingest`, src/ingest/runIngest.js) and the routes it
-- feeds (routes/ask.js, routes/usage.js — neither wired into app.js) don't
-- hard-crash on a missing table. Nothing reachable from the running server
-- touches these. The vector-search half of that same dead path (a
-- `chunks_vec` virtual table over sqlite-vec) is NOT recreated here: it
-- needs the sqlite-vec extension, which isn't installed, and real vector
-- search for the live app is handled entirely by vectorService.js (LanceDB).
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_row_id TEXT,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source, source_row_id);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  latency_ms INTEGER,
  question TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
