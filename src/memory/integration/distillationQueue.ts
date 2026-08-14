import { planPendingL1Task, type PlannedL1Task } from "./l1Scheduling.ts";
import {
  enqueueDistillationTask,
  type EnqueueDistillationTaskInput,
} from "../db/repositories/distillation.ts";
import type { L0MessageRecord, L1TaskEnqueuer } from "./l0Capture.ts";

interface ProductionL1EnqueuerOptions {
  enqueueTask?: (input: EnqueueDistillationTaskInput) => unknown;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  planTask?: (input: {
    scope: string;
    sessionId: string;
    correlationId: string | null;
    capturedAt: string;
    now: number;
  }) => PlannedL1Task | null;
}

function isDistillationEnabled(env: NodeJS.ProcessEnv): boolean {
  const interval = Number(env.MEMORY_DISTILLATION_INTERVAL);
  return env.MEMORY_DISTILLATION_ENABLED === "true" && Number.isFinite(interval) && interval > 0;
}

function formatConversation(records: readonly L0MessageRecord[]): string {
  return records.map((record) => `${record.role}: ${record.content}`).join("\n");
}

export function createProductionL1TaskEnqueuer(
  options: ProductionL1EnqueuerOptions = {}
): L1TaskEnqueuer {
  const enqueueTask = options.enqueueTask ?? enqueueDistillationTask;
  const planTask =
    options.planTask ?? (options.enqueueTask === undefined ? planPendingL1Task : null);
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;

  return {
    enqueueL1Task(input) {
      if (!isDistillationEnabled(env) || input.records.length === 0) return;
      const plan = planTask?.({
        scope: input.ownerId,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        capturedAt: input.capturedAt,
        now: now(),
      });
      if (plan) {
        enqueueTask(plan);
        return;
      }

      // Injected/unit stores do not populate canonical L0. Preserve a complete
      // executable payload for those adapters while production uses the cursor plan.
      const sourceMessageIds = input.records.map((record) => record.id);
      enqueueTask({
        kind: "L1_extract",
        scope: input.ownerId,
        payload: {
          sessionId: input.sessionId,
          correlationId: input.correlationId,
          capturedAt: input.capturedAt,
          sourceMessageIds,
          conversation: formatConversation(input.records),
        },
        priority: 1,
        notBefore: now() + 1_000,
        idempotencyKey: `l1:${sourceMessageIds.join(":")}`,
      });
    },
  };
}

export const PRODUCTION_L1_TASK_ENQUEUER = createProductionL1TaskEnqueuer();
