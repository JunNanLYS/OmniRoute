/**
 * /api/memory/l2/[id] — L2 detail / edit / soft-delete / restore / permanent.
 *
 *  - GET    → fetch a single L2 entry.
 *  - PUT    → edit with optimistic version.
 *  - DELETE → soft (default) or permanent.
 *  - POST op=restore → restore from recycle.
 */
import { NextResponse } from "next/server";

import { validatedJsonBody } from "@/shared/validation/helpers";
import { L2DeleteBodySchema, L2UpdateSchema } from "@/shared/schemas/memoryFourLayer";
import { createErrorResponse } from "@/lib/api/errorResponse";

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
    const entry = await service.getL2(owner, id);
    if (!entry) {
      return createErrorResponse({
        status: 404,
        message: "L2 memory not found",
        type: "not_found",
      });
    }
    return NextResponse.json({ data: entry });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 500, message: "Failed to fetch L2 memory" });
  }
}

export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const { id } = await props.params;
  const body = await validatedJsonBody(request, L2UpdateSchema);
  if (!body.success) return body.response;

  try {
    const service = getService();
    const result = await service.updateL2(owner, id, body.data);
    if (result.conflict) {
      return createErrorResponse({
        status: 409,
        message: "Optimistic version conflict — refetch and retry",
        type: "conflict",
        details: { expectedVersion: body.data.expectedVersion },
      });
    }
    await audit({
      action: "memory.l2.update",
      actor: owner.actor,
      target: `l2:${id}`,
      resourceType: "memory_l2",
      details: { newVersion: result.entry.version },
      request,
    });
    return NextResponse.json({ data: result.entry });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 400, message: "Failed to update L2 memory" });
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const { id } = await props.params;

  let mode: "soft" | "permanent" = "soft";
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const clone = request.clone();
      const raw = (await clone.json()) as unknown;
      const parsed = L2DeleteBodySchema.safeParse(raw);
      if (parsed.success) mode = parsed.data.mode;
    } catch {
      // empty body → soft
    }
  }

  try {
    const service = getService();
    const ok = await service.deleteL2(owner, id, mode);
    if (!ok) {
      return createErrorResponse({
        status: 404,
        message: "L2 memory not found",
        type: "not_found",
      });
    }
    await audit({
      action: mode === "permanent" ? "memory.l2.permanent_delete" : "memory.l2.soft_delete",
      actor: owner.actor,
      target: `l2:${id}`,
      resourceType: "memory_l2",
      details: { mode },
      request,
    });
    return NextResponse.json({ success: true, mode });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 400, message: "Failed to delete L2 memory" });
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const { id } = await props.params;
  const url = new URL(request.url);
  const op = url.searchParams.get("op") ?? "restore";

  if (op !== "restore") {
    return createErrorResponse({
      status: 400,
      message: "Unsupported op on L2 entry",
      type: "invalid_request",
    });
  }

  try {
    const service = getService();
    const entry = await service.restoreL2(owner, id);
    if (!entry) {
      return createErrorResponse({
        status: 404,
        message: "L2 memory not found or not in recycle",
        type: "not_found",
      });
    }
    await audit({
      action: "memory.l2.restore",
      actor: owner.actor,
      target: `l2:${id}`,
      resourceType: "memory_l2",
      request,
    });
    return NextResponse.json({ data: entry });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 400, message: "Failed to restore L2 memory" });
  }
}
