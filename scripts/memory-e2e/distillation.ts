/**
 * Explicit distillation run client — the evaluation's distillation
 * orchestration (POST /api/memory/distillation/run + status polling).
 */
import { httpJson, sleep } from "./http.ts";

export interface DistillationRunRecord {
  runId: string;
  status: "running" | "succeeded" | "failed";
  session: string;
  layers: string[];
  layerStates: Array<{
    layer: string;
    status: string;
    taskIds: string[];
    error: { kind: string; message: string } | null;
  }>;
  evidence: {
    tasks: Array<{ id: string; kind: string; status: string; lastError: string | null }>;
    dlq: Array<{ taskId: string; reason: string; failureKind: string; error: string }>;
  } | null;
}

export async function runExplicitDistillation(options: {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  layers?: string[];
  layerTimeoutMs: number;
  pollMs: number;
  deadlineMs: number;
}): Promise<DistillationRunRecord> {
  const accepted = await httpJson<{ runId?: string; statusUrl?: string }>(
    `${options.baseUrl}/api/memory/distillation/run`,
    {
      method: "POST",
      bearer: options.apiKey,
      body: JSON.stringify({
        session: options.sessionId,
        layers: options.layers ?? ["l1", "l2", "l3"],
        layerTimeoutMs: options.layerTimeoutMs,
      }),
    }
  );
  if (accepted.status !== 202 || !accepted.body.runId) {
    throw new Error(
      `distillation run start failed: HTTP ${accepted.status} ${JSON.stringify(accepted.body).slice(0, 400)}`
    );
  }
  const statusUrl =
    accepted.body.statusUrl ??
    `/api/memory/distillation/run/${encodeURIComponent(accepted.body.runId)}`;

  const deadline = Date.now() + options.deadlineMs;
  for (;;) {
    const status = await httpJson<{ data?: DistillationRunRecord }>(
      `${options.baseUrl}${statusUrl}`,
      { bearer: options.apiKey }
    );
    const record = status.body.data;
    if (!status.ok || !record) {
      throw new Error(
        `distillation run status failed: HTTP ${status.status} ${JSON.stringify(status.body).slice(0, 400)}`
      );
    }
    if (record.status !== "running") return record;
    if (Date.now() >= deadline) {
      throw new Error(
        `distillation run ${record.runId} did not finish within ${options.deadlineMs}ms`
      );
    }
    await sleep(Math.min(options.pollMs, Math.max(1, deadline - Date.now())));
  }
}
