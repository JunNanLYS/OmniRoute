/**
 * POST /api/memory/distillation/run — start an explicit distillation run.
 *
 * The run is the evaluation control plane: it executes the selected layers
 * sequentially for one session, terminates dependent layers on failure with
 * task/DLQ evidence, and never retries inside the run. It is independent of
 * the background worker lifecycle.
 *
 * Auth: management or self API key. Owner is derived from the auth subject;
 * management callers may target another key via `?apiKeyId=`.
 */
import { NextResponse } from "next/server";

import { validatedJsonBody } from "@/shared/validation/helpers";
import { DistillationRunPostSchema } from "@/shared/schemas/memoryFourLayer";

import { audit, jsonErrorFromUnknown, resolveOwner } from "@/memory/api/handlers/_lib";
import { startDistillationRun } from "@/memory/distillation/run";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const body = await validatedJsonBody(request, DistillationRunPostSchema);
  if (!body.success) return body.response;

  try {
    const record = await startDistillationRun({
      ownerApiKeyId: owner.ownerApiKeyId,
      session: body.data.session,
      layers: body.data.layers,
      layerTimeoutMs: body.data.layerTimeoutMs,
    });
    await audit({
      action: "memory.distillation.run",
      actor: owner.actor,
      target: `distillation-run:${record.runId}`,
      resourceType: "memory_distillation_run",
      details: { session: record.session, layers: record.layers },
      request,
    });
    return NextResponse.json(
      {
        runId: record.runId,
        status: record.status,
        session: record.session,
        layers: record.layers,
        statusUrl: `/api/memory/distillation/run/${record.runId}`,
      },
      { status: 202 }
    );
  } catch (err: unknown) {
    return jsonErrorFromUnknown(err, {
      status: 500,
      message: "Failed to start distillation run",
    });
  }
}
