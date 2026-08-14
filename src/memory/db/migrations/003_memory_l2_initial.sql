-- 003_memory_l2_initial.sql
-- L2: scenes (max 15 active per owner enforced at write-time in code).
-- (scene_name, group_key) is the natural unique key for upsert.

CREATE TABLE IF NOT EXISTS l2_scenes (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  scene_name TEXT NOT NULL,
  group_key TEXT,
  summary TEXT NOT NULL DEFAULT '',
  heat REAL NOT NULL DEFAULT 0.0 CHECK(heat >= 0.0 AND heat <= 1.0),
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  last_modified_by TEXT NOT NULL CHECK(last_modified_by IN ('user','pipeline')),
  edited_by_user INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  -- soft-delete semantic; real "active" = deleted_at IS NULL
  tombstone INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_l2_scenes_natural
  ON l2_scenes(owner_key, scene_name, group_key)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_l2_scenes_owner ON l2_scenes(owner_key);
CREATE INDEX IF NOT EXISTS idx_l2_scenes_owner_heat ON l2_scenes(owner_key, heat);
CREATE INDEX IF NOT EXISTS idx_l2_scenes_deleted ON l2_scenes(deleted_at);