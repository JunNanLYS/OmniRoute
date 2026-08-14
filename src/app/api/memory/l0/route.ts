/**
 * /api/memory/l0 — L0 lineage list + bulk import.
 *
 * L0 is the raw trace layer. Writes are restricted to POST /import (bulk);
 * there is NO PUT/edit. DELETE is soft/permanent by default and operates
 * against a single id (the [id] sub-route) or against an entire session
 * via DELETE here with a `sessionId` body.
 *
 * Auth: management or self API key. Owner is derived from the auth subject
 * (the self caller cannot cross owner). Management callers may select an
 * `apiKeyId` to scope to.
 *
 * NO raw SQL — all storage goes through `getFourLayerService()`.
 */
import { NextResponse } from "next/server";

import { validatedJsonBody } from "@/shared/validation/helpers";
import {
  L0DeleteAllSchema,
  L0ImportSchema,
  memoryListingQuerySchema,
} from "@/shared/schemas/memoryFourLayer";
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
    const result = await service.listL0(owner, parsed.data);
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
    return jsonErrorFromUnknown(err, { status: 500, message: "Failed to list L0 memories" });
  }
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  // POST /api/memory/l0 supports two modes:
  //   1. POST /api/memory/l0          — body = L0ImportSchema (bulk import)
  //   2. POST /api/memory/l0?sessionId=... — body = L0DeleteAllSchema (session delete)
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId) {
    return l0SessionDelete(request, sessionId);
  }

  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const body = await validatedJsonBody(request, L0ImportSchema);
  if (!body.success) return body.response;

  try {
    const service = getService();
    const result = await service.importL0(owner, body.data);
    await audit({
      action: "memory.l0.import",
      actor: owner.actor,
      target: `l0:${result.importedIds.length}`,
      resourceType: "memory_l0",
      details: { count: result.importedIds.length },
      request,
    });
    return NextResponse.json({ success: true, importedIds: result.importedIds }, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, {
      status: 400,
      message: "Failed to import L0 memories",
    });
  }
}

async function l0SessionDelete(request: Request, sessionId: string) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const body = await validatedJsonBody(request, L0DeleteAllSchema);
  if (!body.success) return body.response;

  if (body.data.sessionId !== sessionId) {
    return createErrorResponse({
      status: 400,
      message: "sessionId in body must match query",
      type: "invalid_request",
    });
  }

  try {
    const service = getService();
    const result = await service.deleteL0Session(owner, sessionId, body.data.mode);
    await audit({
      action: "memory.l0.delete_session",
      actor: owner.actor,
      target: `l0-session:${sessionId}`,
      resourceType: "memory_l0",
      details: { mode: body.data.mode, deleted: result.deleted },
      request,
    });
    return NextResponse.json({ success: true, deleted: result.deleted });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, {
      status: 400,
      message: "Failed to delete L0 session",
    });
  }
}
