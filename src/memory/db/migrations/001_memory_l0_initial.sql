-- 001_memory_l0_initial.sql
-- L0: raw messages (immutable; insert-only; idempotent by message_id)

CREATE TABLE IF NOT EXISTS l0_messages (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  session_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL CHECK(source IN ('user','assistant','imported')),
  correlation_id TEXT,
  combo_execution_key TEXT,
  is_internal INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  model TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  -- idempotency_key is the dedupe key — derived from session/role/timestamp/source/content
  -- so repeated inserts of the same logical message are no-ops.
  idempotency_key TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_l0_messages_idem ON l0_messages(owner_key, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_l0_messages_owner ON l0_messages(owner_key);
CREATE INDEX IF NOT EXISTS idx_l0_messages_session ON l0_messages(owner_key, session_id);
CREATE INDEX IF NOT EXISTS idx_l0_messages_role ON l0_messages(owner_key, role);
CREATE INDEX IF NOT EXISTS idx_l0_messages_recorded ON l0_messages(owner_key, recorded_at);
CREATE INDEX IF NOT EXISTS idx_l0_messages_deleted ON l0_messages(deleted_at);

-- L0 FTS5: content index. Used by searchMessages. content='l0_messages' avoids
-- duplicating storage; triggers keep it in sync.
CREATE VIRTUAL TABLE IF NOT EXISTS l0_fts USING fts5(
  content,
  content='l0_messages',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS l0_fts_ai AFTER INSERT ON l0_messages BEGIN
  INSERT INTO l0_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS l0_fts_ad AFTER DELETE ON l0_messages BEGIN
  INSERT INTO l0_fts(l0_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS l0_fts_au AFTER UPDATE ON l0_messages BEGIN
  INSERT INTO l0_fts(l0_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO l0_fts(rowid, content) VALUES (new.rowid, new.content);
END;