/** Additive migration. Legacy memories are retained and are not silently promoted. */
export function migrateMemory(db) {
 db.transaction(()=>{
  db.exec(`CREATE TABLE IF NOT EXISTS memory_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS chats_memory_owner ON chats(id,userId);
   CREATE TABLE IF NOT EXISTS short_term_memories(
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,source TEXT NOT NULL,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
    FOREIGN KEY(conversation_id,user_id) REFERENCES chats(id,userId) ON DELETE CASCADE,
    UNIQUE(user_id,conversation_id,key));
   CREATE INDEX IF NOT EXISTS short_memory_scope ON short_term_memories(user_id,conversation_id,updated_at);
   CREATE INDEX IF NOT EXISTS short_memory_expiry ON short_term_memories(expires_at);
   CREATE TABLE IF NOT EXISTS task_memories(
    task_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES chats(id) ON DELETE SET NULL,revision INTEGER NOT NULL,
    value TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS task_memory_scope ON task_memories(user_id,conversation_id,updated_at);
   CREATE TABLE IF NOT EXISTS task_memory_events(
    id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES task_memories(task_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,revision INTEGER NOT NULL,
    value TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(task_id,revision));
   CREATE INDEX IF NOT EXISTS task_events_scope ON task_memory_events(user_id,task_id,revision);
   CREATE TABLE IF NOT EXISTS system_memories(
    machine_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,classification TEXT NOT NULL
     CHECK(classification IN ('STATIC','SEMI_STATIC','DYNAMIC')),source TEXT NOT NULL,
    last_verified_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(machine_id,key));
   CREATE TABLE IF NOT EXISTS long_term_memories(
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,source TEXT NOT NULL,
    confidence REAL NOT NULL CHECK(confidence>=0 AND confidence<=1),
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_id,key));
   CREATE INDEX IF NOT EXISTS long_memory_scope ON long_term_memories(user_id,category,updated_at);
   CREATE TABLE IF NOT EXISTS memory_audit(
    id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event TEXT NOT NULL,memory_type TEXT NOT NULL,request_id TEXT,conversation_id TEXT,task_id TEXT,
    created_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS memory_audit_owner ON memory_audit(user_id,created_at);`);
  db.prepare('INSERT OR IGNORE INTO memory_migrations VALUES(1,?)').run(new Date().toISOString());
 })();
}
