/**
 * /api/memory/l3 — L3 operator-visible distilled memory list and regenerate.
 *
 *  - GET  → list.
 *  - POST op=regenerate → enqueue a global regeneration task.
 */
import { NextResponse } from "next/server";

import { validatedJsonBody } from "@/shared/validation/helpers";
import { L3RegenerateSchema, memoryListingQuerySchema } from "@/shared/schemas/memoryFourLayer";
import { createErrorResponse } from "@/lib/api/errorResponse";

import {
  audit,
  buildPagination,
  getService,
  jsonErrorFromUnknown,
  resolveOwner,
  serviceUnavailableResponse,
} from "@/memory/api/handlers/_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const url = new URL(request.url);
  const parsed = memoryListingQuerySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
    apiKeyId: owner.ownerApiKeyId ?? undefined,
    sessionId: url.searchParams.get("sessionId") ?? undefined,
    sceneName: url.searchParams.get("sceneName") ?? undefined,
    sourceId: url.searchParams.get("sourceId") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    includeDeleted: url.searchParams.get("includeDeleted") ?? undefined,
  });

  if (!parsed.success) {
    return createErrorResponse({
      status: 400,
      message: "Invalid query parameters",
      type: "invalid_request",
      details: parsed.error.issues,
    });
  }

  try {
    const service = getService();
    const result = await service.listL3(owner, parsed.data);
    return NextResponse.json({
      data: result.data,
      pagination: buildPagination({
        page: result.page,
        limit: result.limit,
        total: result.total,
      }),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 500, message: "Failed to list L3 memories" });
  }
}

export async function POST(request: Request) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const body = await validatedJsonBody(request, L3RegenerateSchema);
  if (!body.success) return body.response;

  try {
    const service = getService();
    const result = await service.regenerateL3(owner, body.data);
    if (result.rejected) {
      return createErrorResponse({
        status: 409,
        message: "Too many errors in the rolling window",
        type: "conflict",
        details: result.rejected,
      });
    }
    await audit({
      action: "memory.l3.regenerate",
      actor: owner.actor,
      target: "l3",
      resourceType: "memory_l3",
      details: { enqueued: result.enqueued },
      request,
    });
    return NextResponse.json({ success: true, enqueued: result.enqueued });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 400, message: "Failed to enqueue L3 regenerate" });
  }
}
