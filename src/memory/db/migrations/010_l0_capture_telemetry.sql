-- 010_l0_capture_telemetry.sql
-- Persisted, masked, owner-scoped L0 capture telemetry counters.
-- Stores aggregate success/failure counts and last-event timestamps; never
-- persists message content, tokens, secrets, or correlation payloads.

CREATE TABLE IF NOT EXISTS l0_capture_telemetry (
  owner_api_key_id TEXT PRIMARY KEY,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_failure_category TEXT
);

CREATE INDEX IF NOT EXISTS idx_l0_capture_telemetry_last_success
  ON l0_capture_telemetry(last_success_at DESC);
