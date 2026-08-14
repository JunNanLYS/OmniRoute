/**
 * /api/memory/l2 — L2 derived/working memory list and create.
 *
 *  - GET  → list (with optional `?q=` for search if the storage supports it).
 *  - POST → create. Owner is derived from the auth subject.
 *
 * Owner cannot be cross-set by self callers.
 */
import { NextResponse } from "next/server";

import { validatedJsonBody } from "@/shared/validation/helpers";
import { L2CreateSchema, memoryListingQuerySchema } from "@/shared/schemas/memoryFourLayer";
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
    const result = await service.listL2(owner, parsed.data);
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
    return jsonErrorFromUnknown(err, { status: 500, message: "Failed to list L2 memories" });
  }
}

export async function POST(request: Request) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const body = await validatedJsonBody(request, L2CreateSchema);
  if (!body.success) return body.response;

  try {
    const service = getService();
    const entry = await service.createL2(owner, body.data);
    await audit({
      action: "memory.l2.create",
      actor: owner.actor,
      target: `l2:${entry.id}`,
      resourceType: "memory_l2",
      details: { sceneName: entry.sceneName, groupKey: entry.groupKey },
      request,
    });
    return NextResponse.json({ data: entry }, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 400, message: "Failed to create L2 memory" });
  }
}
