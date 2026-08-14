/**
 * /api/memory/l0/[id] — L0 detail / soft-delete / permanent / restore.
 *
 *  - GET   → fetch a single L0 entry (404 if not found / wrong owner).
 *  - DELETE → soft-delete (default) or permanent depending on `mode` body.
 *  - POST /restore → restore a soft-deleted entry. Body: `{ id }` mirror.
 *
 * There is NO PUT/edit on L0 (lineage is immutable).
 */
import { NextResponse } from "next/server";

import { validatedJsonBody } from "@/shared/validation/helpers";
import { L0DeleteBodySchema } from "@/shared/schemas/memoryFourLayer";
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
    const entry = await service.getL0(owner, id);
    if (!entry) {
      return createErrorResponse({
        status: 404,
        message: "L0 memory not found",
        type: "not_found",
      });
    }
    return NextResponse.json({ data: entry });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 500, message: "Failed to fetch L0 memory" });
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const { id } = await props.params;

  // DELETE may have no body (mode defaults to soft) — handle both.
  let mode: "soft" | "permanent" = "soft";
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const clone = request.clone();
      const raw = (await clone.json()) as unknown;
      const parsed = L0DeleteBodySchema.safeParse(raw);
      if (parsed.success) {
        mode = parsed.data.mode;
      }
    } catch {
      // empty body is fine
    }
  }

  try {
    const service = getService();
    const ok = await service.deleteL0(owner, id, mode);
    if (!ok) {
      return createErrorResponse({
        status: 404,
        message: "L0 memory not found",
        type: "not_found",
      });
    }
    await audit({
      action: mode === "permanent" ? "memory.l0.permanent_delete" : "memory.l0.soft_delete",
      actor: owner.actor,
      target: `l0:${id}`,
      resourceType: "memory_l0",
      details: { mode },
      request,
    });
    return NextResponse.json({ success: true, mode });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 400, message: "Failed to delete L0 memory" });
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
      message: "Unsupported op on L0 entry",
      type: "invalid_request",
    });
  }

  try {
    const service = getService();
    const entry = await service.restoreL0(owner, id);
    if (!entry) {
      return createErrorResponse({
        status: 404,
        message: "L0 memory not found or not in recycle",
        type: "not_found",
      });
    }
    await audit({
      action: "memory.l0.restore",
      actor: owner.actor,
      target: `l0:${id}`,
      resourceType: "memory_l0",
      request,
    });
    return NextResponse.json({ data: entry });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 400, message: "Failed to restore L0 memory" });
  }
}
