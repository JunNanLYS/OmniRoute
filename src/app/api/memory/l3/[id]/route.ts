/**
 * /api/memory/l3/[id] — L3 detail / upsert / soft-delete / restore / permanent.
 *
 *  - GET    → fetch a single L3 entry.
 *  - PUT    → upsert (no `expectedVersion` required; one stored entry per
 *             (owner, sourceLayer, sourceId) tuple).
 *  - DELETE → soft (default) | restore | permanent.
 */
import { NextResponse } from "next/server";

import { validatedJsonBody } from "@/shared/validation/helpers";
import { L3DeleteBodySchema, L3UpsertSchema } from "@/shared/schemas/memoryFourLayer";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { MemoryOptimisticConflictError } from "@/memory/api/dependencies";

import {
  audit,
  getService,
  jsonErrorFromUnknown,
  resolveOwner,
  serviceUnavailableResponse,
} from "@/memory/api/handlers/_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const { id } = await props.params;

  try {
    const service = getService();
    const entry = await service.getL3(owner, id);
    if (!entry) {
      return createErrorResponse({
        status: 404,
        message: "L3 memory not found",
        type: "not_found",
      });
    }
    return NextResponse.json({ data: entry });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 500, message: "Failed to fetch L3 memory" });
  }
}

export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const { id } = await props.params;
  const body = await validatedJsonBody(request, L3UpsertSchema);
  if (!body.success) return body.response;

  try {
    const service = getService();
    const entry = await service.upsertL3(owner, body.data);
    await audit({
      action: "memory.l3.upsert",
      actor: owner.actor,
      target: `l3:${id}`,
      resourceType: "memory_l3",
      details: { promptMode: entry.promptMode, version: entry.version },
      request,
    });
    return NextResponse.json({ data: entry });
  } catch (err: unknown) {
    if (err instanceof MemoryOptimisticConflictError) {
      return createErrorResponse({
        status: 409,
        message: "Optimistic version conflict — refetch and retry",
        type: "conflict",
        details: { expectedVersion: body.data.expectedVersion },
      });
    }
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 400, message: "Failed to upsert L3 memory" });
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const { id } = await props.params;

  let mode: "soft" | "restore" | "permanent" = "soft";
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const clone = request.clone();
      const raw = (await clone.json()) as unknown;
      const parsed = L3DeleteBodySchema.safeParse(raw);
      if (parsed.success) mode = parsed.data.mode;
    } catch {
      // empty body → soft
    }
  }

  try {
    const service = getService();
    let ok: boolean;
    if (mode === "restore") {
      const restored = await service.restoreL3(owner, id);
      ok = Boolean(restored);
    } else {
      ok = await service.deleteL3(owner, id, mode);
    }
    if (!ok) {
      return createErrorResponse({
        status: 404,
        message: "L3 memory not found",
        type: "not_found",
      });
    }
    await audit({
      action:
        mode === "permanent"
          ? "memory.l3.permanent_delete"
          : mode === "restore"
            ? "memory.l3.restore"
            : "memory.l3.soft_delete",
      actor: owner.actor,
      target: `l3:${id}`,
      resourceType: "memory_l3",
      details: { mode },
      request,
    });
    return NextResponse.json({ success: true, mode });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 400, message: "Failed to mutate L3 memory" });
  }
}
