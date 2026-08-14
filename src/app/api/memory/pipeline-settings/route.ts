/**
 * /api/memory/pipeline-settings — owner-scoped L0 capture and recall switches.
 */
import { NextResponse } from "next/server";

import {
  audit,
  getService,
  jsonErrorFromUnknown,
  resolveOwner,
  serviceUnavailableResponse,
} from "@/memory/api/handlers/_lib";
import { MemoryPipelineSettingsPutSchema } from "@/shared/schemas/memoryFourLayer";
import { validatedJsonBody } from "@/shared/validation/helpers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  try {
    const data = await getService().getMemoryPipelineSettings(owner);
    return NextResponse.json({ data });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, {
      status: 500,
      message: "Failed to read memory pipeline settings",
    });
  }
}

export async function PUT(request: Request) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  const body = await validatedJsonBody(request, MemoryPipelineSettingsPutSchema);
  if (!body.success) return body.response;

  try {
    const data = await getService().setMemoryPipelineSettings(owner, body.data);
    await audit({
      action: "memory.pipeline_settings.set",
      actor: owner.actor,
      target: `pipeline-settings:${owner.ownerApiKeyId}`,
      resourceType: "memory_pipeline_settings",
      details: {
        captureEnabled: data.captureEnabled,
        injectionEnabled: data.injectionEnabled,
      },
      request,
    });
    return NextResponse.json({ data });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, {
      status: 400,
      message: "Failed to update memory pipeline settings",
    });
  }
}

export async function DELETE(request: Request) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  try {
    await getService().deleteMemoryPipelineSettings(owner);
    const data = await getService().getMemoryPipelineSettings(owner);
    await audit({
      action: "memory.pipeline_settings.reset",
      actor: owner.actor,
      target: `pipeline-settings:${owner.ownerApiKeyId}`,
      resourceType: "memory_pipeline_settings",
      request,
    });
    return NextResponse.json({ data });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, {
      status: 400,
      message: "Failed to reset memory pipeline settings",
    });
  }
}
