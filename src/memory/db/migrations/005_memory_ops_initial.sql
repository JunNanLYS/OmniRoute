-- 005_memory_ops_initial.sql
-- Operations tables: task_queue, task_lock, memory_settings, embedding_meta.
--
-- task_queue error_class is a constrained enum and includes the issue #10
-- values model_unset and credentials_invalid alongside transient / rate_limit /
-- upstream_5xx / validation / permission_denied / unknown.

CREATE TABLE IF NOT EXISTS task_queue (
  task_id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('extract','summarize','embed','reindex','custom')),
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK(status IN ('pending','running','done','failed','dlq')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  claimed_by TEXT,
  last_error_class TEXT CHECK(last_error_class IS NULL OR last_error_class IN (
    'transient','timeout','rate_limit','upstream_5xx','validation','permission_denied','model_unset','credentials_invalid','unknown'
  )),
  last_error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_queue_owner_status
  ON task_queue(owner_key, status);
CREATE INDEX IF NOT EXISTS idx_task_queue_status_created
  ON task_queue(status, created_at);

CREATE TABLE IF NOT EXISTS task_lock (
  -- (owner_key, key) is the natural unique key.
  owner_key TEXT NOT NULL,
  key TEXT NOT NULL,
  acquired_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_key, key)
);

CREATE INDEX IF NOT EXISTS idx_task_lock_expires ON task_lock(expires_at);

CREATE TABLE IF NOT EXISTS memory_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_settings_deleted ON memory_settings(deleted_at);

-- embedding_meta is a single-row table tracking sqlite-vec readiness.
CREATE TABLE IF NOT EXISTS embedding_meta (
  id INTEGER PRIMARY KEY CHECK(id = 1),  -- only one row
  signature TEXT,
  active_dim INTEGER,
  source TEXT,
  vec_loaded INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO embedding_meta (id, signature, active_dim, source, vec_loaded)
  VALUES (1, NULL, NULL, NULL, 0);