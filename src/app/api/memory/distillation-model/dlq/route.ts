/**
 * /api/memory/distillation-model/dlq — failure inspection + retry.
 *
 *  - GET  → list recent DLQ entries with status counts.
 *  - POST → retry selected ids or all pending/failed records.
 */
import { NextResponse } from "next/server";

import { validatedJsonBody } from "@/shared/validation/helpers";
import { DistillationDlqRetrySchema } from "@/shared/schemas/memoryFourLayer";
import { createErrorResponse } from "@/lib/api/errorResponse";

import {
  audit,
  getService,
  jsonErrorFromUnknown,
  resolveOwner,
  serviceUnavailableResponse,
} from "@/memory/api/handlers/_lib";

export const dynamic = "force-dynamic";

const DLQ_STATUSES = ["pending", "running", "failed", "succeeded"] as const;
type DlqStatus = (typeof DLQ_STATUSES)[number];

export async function GET(request: Request) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(rawLimit || 50, 1), 200);

  const rawStatuses = (url.searchParams.get("statuses") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is DlqStatus => (DLQ_STATUSES as readonly string[]).includes(s));

  try {
    const service = getService();
    const result = await service.listDistillationDlq(owner, {
      limit,
      statuses: rawStatuses.length > 0 ? rawStatuses : ["pending", "running", "failed"],
    });
    return NextResponse.json({
      data: result.entries,
      statusCounts: result.statusCounts,
      pagination: { limit },
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, {
      status: 500,
      message: "Failed to list DLQ entries",
    });
  }
}

export async function POST(request: Request) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const url = new URL(request.url);
  if (url.searchParams.get("op") !== "retry") {
    return createErrorResponse({
      status: 400,
      message: "Only op=retry is supported on the DLQ endpoint",
      type: "invalid_request",
    });
  }

  const body = await validatedJsonBody(request, DistillationDlqRetrySchema);
  if (!body.success) return body.response;

  try {
    const service = getService();
    const result = await service.retryDistillationDlq(owner, body.data);
    await audit({
      action: "memory.distillation_model.dlq.retry",
      actor: owner.actor,
      target: "distillation-dlq",
      resourceType: "distillation_dlq",
      details: { retried: result.retried, skipped: result.skipped, all: body.data.all ?? false },
      request,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, {
      status: 400,
      message: "Failed to retry DLQ entries",
    });
  }
}
