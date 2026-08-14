/**
 * /api/memory/l2/[id]/regenerate — POST only.
 *
 * Enqueue a regeneration task for the L2 entry. The service enforces a
 * rolling-window error cap (default 15 errors → 409 with the window length).
 */
import { NextResponse } from "next/server";

import { validatedJsonBody } from "@/shared/validation/helpers";
import { L2RegenerateSchema } from "@/shared/schemas/memoryFourLayer";
import { createErrorResponse } from "@/lib/api/errorResponse";

import {
  audit,
  getService,
  jsonErrorFromUnknown,
  resolveOwner,
  serviceUnavailableResponse,
} from "@/memory/api/handlers/_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const { id } = await props.params;

  // Body is optional — Zod's `.default({})` makes this safe.
  const body = await validatedJsonBody(request, L2RegenerateSchema);
  if (!body.success) return body.response;

  try {
    const service = getService();
    const result = await service.regenerateL2(owner, id, body.data);
    if (result.rejected) {
      return createErrorResponse({
        status: 409,
        message: "Too many errors in the rolling window",
        type: "conflict",
        details: result.rejected,
      });
    }
    await audit({
      action: "memory.l2.regenerate",
      actor: owner.actor,
      target: `l2:${id}`,
      resourceType: "memory_l2",
      details: { enqueued: result.enqueued, reason: body.data.reason ?? null },
      request,
    });
    return NextResponse.json({ success: true, enqueued: result.enqueued });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, { status: 400, message: "Failed to enqueue L2 regenerate" });
  }
}
