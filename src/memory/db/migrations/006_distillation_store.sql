-- 006_distillation_store.sql
-- Canonical persistent store for the four-layer distillation worker.
-- The pre-integration task_queue/task_lock shapes from migration 005 cannot
-- represent the worker state machine, so this hard-cutover migration replaces
-- them before the feature is released.

DROP TABLE IF EXISTS task_queue;
DROP TABLE IF EXISTS task_lock;

CREATE TABLE task_queue (
  task_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN (
    'L0_chunk_embed','L1_extract','L2_scene','L3_persona'
  )),
  scope TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 10),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
    'queued','claimed','running','succeeded','failed_retry','failed_dlq','skipped_breaker'
  )),
  provider_hint TEXT,
  model_hint TEXT,
  last_error TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  claimed_by TEXT,
  lease_expires_at INTEGER,
  result_json TEXT,
  fallback_evidence_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX idx_task_queue_claim
  ON task_queue(status, not_before, priority DESC, created_at ASC);
CREATE INDEX idx_task_queue_scope_status
  ON task_queue(scope, status, updated_at DESC);

CREATE TABLE task_lock (
  lock_key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL
);
CREATE INDEX idx_task_lock_expires ON task_lock(expires_at);

CREATE TABLE IF NOT EXISTS task_dlq (
  dlq_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  reason TEXT NOT NULL,
  failure_kind TEXT NOT NULL CHECK(failure_kind IN (
    'retry_exhausted','no_retry','model_lockout','parse_failed',
    'semantic_invalid','budget_exceeded','model_unset','model_deleted',
    'credentials_invalid'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  retry_status TEXT NOT NULL DEFAULT 'pending' CHECK(retry_status IN (
    'pending','running','failed','succeeded'
  )),
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_dlq_scope_recorded
  ON task_dlq(scope, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_dlq_status_recorded
  ON task_dlq(retry_status, recorded_at DESC);

CREATE TABLE IF NOT EXISTS distillation_usage (
  usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'L0_chunk_embed','L1_extract','L2_scene','L3_persona'
  )),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_distillation_usage_scope_recorded
  ON distillation_usage(scope, recorded_at DESC);
