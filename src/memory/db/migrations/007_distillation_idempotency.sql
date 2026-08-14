-- 007_distillation_idempotency.sql
-- Stable producer keys prevent a retried chat response from duplicating the
-- same L1 extraction task. NULL keeps manually-triggered/regeneration tasks
-- unconstrained.

ALTER TABLE task_queue ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX idx_task_queue_idempotency
  ON task_queue(scope, kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
