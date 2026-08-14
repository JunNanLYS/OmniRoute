/**
 * /api/memory/distillation-model/usage — owner-scoped token + USD accounting.
 *
 *  - GET → list recent usage rows for the resolved owner, plus aggregate totals.
 *
 * Auth + scope rules:
 *  - Self callers can only inspect their own owner.
 *  - Management callers may target any owner via `?apiKeyId=...`.
 *  - Rows are aggregated per task_id (`ON CONFLICT(task_id) DO NOTHING`),
 *    so the totals are idempotent on retry.
 */
import { NextResponse } from "next/server";

import {
  audit,
  getService,
  jsonErrorFromUnknown,
  resolveOwner,
  serviceUnavailableResponse,
} from "@/memory/api/handlers/_lib";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: Request) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Math.min(Math.max(rawLimit || DEFAULT_LIMIT, 1), MAX_LIMIT);

  try {
    const service = getService();
    const result = await service.listDistillationUsage(owner, { limit });
    await audit({
      action: "memory.distillation_model.usage.list",
      actor: owner.actor,
      target: "distillation-usage",
      resourceType: "distillation_usage",
      details: { count: result.records.length, totals: result.totals },
      request,
    });
    return NextResponse.json({
      data: result.records,
      totals: result.totals,
      pagination: { limit },
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, {
      status: 500,
      message: "Failed to list distillation usage",
    });
  }
}
