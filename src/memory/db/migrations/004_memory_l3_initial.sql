-- 004_memory_l3_initial.sql
-- L3: persona — one active row per owner. Partial unique index on owner_key
-- where deleted_at IS NULL enforces the singleton invariant at the DB level.

CREATE TABLE IF NOT EXISTS l3_personas (
  persona_id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  prompt_mode TEXT NOT NULL CHECK(prompt_mode IN ('chat','code')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  last_modified_by TEXT NOT NULL CHECK(last_modified_by IN ('user','pipeline')),
  edited_by_user INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_l3_personas_owner_active
  ON l3_personas(owner_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_l3_personas_owner ON l3_personas(owner_key);
CREATE INDEX IF NOT EXISTS idx_l3_personas_deleted ON l3_personas(deleted_at);