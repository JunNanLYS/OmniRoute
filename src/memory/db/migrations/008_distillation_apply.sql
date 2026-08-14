-- 008_distillation_apply.sql
-- Stable pipeline identity for exactly-once L1 application across task retries.
-- Historical versions retain the key, but only the active row participates in
-- uniqueness so versioned updates can preserve provenance.

ALTER TABLE l1_memories ADD COLUMN pipeline_key TEXT;
ALTER TABLE task_queue ADD COLUMN coalesce_key TEXT;

CREATE UNIQUE INDEX idx_l1_memories_pipeline_active
  ON l1_memories(owner_key, pipeline_key)
  WHERE pipeline_key IS NOT NULL AND deleted_at IS NULL AND tombstone = 0;

CREATE UNIQUE INDEX idx_task_queue_coalesce_active
  ON task_queue(scope, kind, coalesce_key)
  WHERE coalesce_key IS NOT NULL AND status = 'queued' AND deleted_at IS NULL;
