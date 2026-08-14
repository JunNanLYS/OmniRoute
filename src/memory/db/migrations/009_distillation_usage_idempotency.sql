-- 009_distillation_usage_idempotency.sql
-- A distillation task is billed at most once. Existing duplicate rows can only
-- come from the pre-atomic batcher path, so retain the first durable record.

DELETE FROM distillation_usage
WHERE usage_id NOT IN (
  SELECT MIN(usage_id)
  FROM distillation_usage
  GROUP BY task_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_distillation_usage_task
  ON distillation_usage(task_id);
