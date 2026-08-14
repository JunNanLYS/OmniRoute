/**
 * /api/memory/l1 — L1 owner-curated memory list, search, and create.
 *
 *  - GET    → list with optional `q` shorthand (`?q=` matches `searchL1`).
 *  - POST   → create an L1 entry. 7 types. `sceneName` + `metadata` + optional
 *             `sourceId`. `priority` 0..100 (default 50). Owner is derived
 *             from the auth subject.
 *  - search is the same GET, the `q` query routes through `searchL1()`.
 *
 * Self API key callers MUST target their own owner. Management callers may
 * select `?apiKeyId=...` to scope to a specific key.
 */
import { NextResponse } from "next/server";

import { validatedJsonBody } from "@/shared/validation/helpers";
import { L1CreateSchema, memoryListingQuerySchema } from "@/shared/schemas/memoryFourLayer";
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
    const isSearch = Boolean(parsed.data.q && parsed.data.q.trim().length > 0);
    const result = isSearch
      ? await service.searchL1(owner, parsed.data)
      : await service.listL1(owner, parsed.data);
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
    return jsonErrorFromUnknown(err, { status: 500, message: "Failed to list L1 memories" });
  }
}

export async function POST(request: Request) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const body = await validatedJsonBody(request, L1CreateSchema);
  if (!body.success) return body.response;

  try {
    const service = getService();
    const entry = await service.createL1(owner, body.data);
    await audit({
      action: "memory.l1.create",
      actor: owner.actor,
      target: `l1:${entry.id}`,
      resourceType: "memory_l1",
      details: { type: entry.type, priority: entry.priority, sceneName: entry.sceneName },
      request,
    });
    return NextResponse.json({ data: entry }, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 400, message: "Failed to create L1 memory" });
  }
}
