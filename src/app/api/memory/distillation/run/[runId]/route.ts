/**
 * GET /api/memory/distillation/run/[runId] — explicit run status.
 *
 * Returns the live run record: layer states, task ids, and (once terminal)
 * task/DLQ evidence. The CLI `--wait` flag polls this endpoint.
 *
 * Auth: the owning self API key or any management caller. Unknown run ids
 * and runs owned by someone else both return 404 so existence is not leaked.
 */
import { NextResponse } from "next/server";

import { createErrorResponse } from "@/lib/api/errorResponse";

import { resolveAuthSubject } from "@/memory/api/handlers/_lib";
import { getDistillationRun } from "@/memory/distillation/run";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const actor = await resolveAuthSubject(request);
  if (!actor) {
    return createErrorResponse({
      status: 401,
      message: "Authentication required",
      type: "invalid_request",
    });
  }

  const { runId } = await context.params;
  const record = getDistillationRun(runId);
  if (!record) {
    return createErrorResponse({
      status: 404,
      message: "Distillation run not found",
      type: "invalid_request",
    });
  }

  const isOwner = actor.actor === "apiKey" && actor.apiKeyId === record.ownerApiKeyId;
  if (!isOwner && !actor.isManagement) {
    return createErrorResponse({
      status: 404,
      message: "Distillation run not found",
      type: "invalid_request",
    });
  }

  return NextResponse.json({ data: record });
}
