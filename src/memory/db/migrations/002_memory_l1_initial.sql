-- 002_memory_l1_initial.sql
-- L1: structured memories with versioned updates. 7 types; FTS5 over content.

CREATE TABLE IF NOT EXISTS l1_memories (
  -- stable memory_id (UUID); preserved across versions. Primary key is
  -- (id, version) so each version is a separate row.
  id TEXT NOT NULL,
  -- monotonic version (1..N) so each update is a separate row.
  version INTEGER NOT NULL,
  owner_key TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('persona','episodic','instruction','work_fact','work_task','work_method','work_artifact')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK(priority >= 0 AND priority <= 100),
  scene_name TEXT NOT NULL DEFAULT 'default',
  source_message_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array
  metadata TEXT NOT NULL DEFAULT '{}',            -- JSON object
  content TEXT NOT NULL,
  last_modified_by TEXT NOT NULL CHECK(last_modified_by IN ('user','pipeline')),
  edited_by_user INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  tombstone INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_l1_memories_id_version ON l1_memories(id, version);
CREATE INDEX IF NOT EXISTS idx_l1_memories_owner ON l1_memories(owner_key);
CREATE INDEX IF NOT EXISTS idx_l1_memories_owner_type ON l1_memories(owner_key, type);
CREATE INDEX IF NOT EXISTS idx_l1_memories_owner_scene ON l1_memories(owner_key, scene_name);
CREATE INDEX IF NOT EXISTS idx_l1_memories_owner_updated ON l1_memories(owner_key, updated_at);
CREATE INDEX IF NOT EXISTS idx_l1_memories_deleted ON l1_memories(deleted_at);

-- L1 FTS5 over content.
CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
  content,
  content='l1_memories',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS l1_fts_ai AFTER INSERT ON l1_memories BEGIN
  INSERT INTO l1_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS l1_fts_ad AFTER DELETE ON l1_memories BEGIN
  INSERT INTO l1_fts(l1_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS l1_fts_au AFTER UPDATE ON l1_memories BEGIN
  INSERT INTO l1_fts(l1_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO l1_fts(rowid, content) VALUES (new.rowid, new.content);
END;