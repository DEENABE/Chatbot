-- Metadata table: one row per text chunk
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,          -- e.g. table name, file name, doc id
  source_row_id TEXT,            -- original row/record id in your big DB, for incremental updates
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,    -- sha256 of cleaned text, used for de-dup / change detection
  metadata TEXT,                 -- JSON string: category, date, tags, etc.
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source, source_row_id);

-- Vector table (sqlite-vec virtual table), rowid matches chunks.id
-- Created dynamically in connection.js because the vector dimension is configurable

-- Usage log for token tracking
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
