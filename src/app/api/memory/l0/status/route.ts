/**
 * /api/memory/l0/status — owner-scoped L0 capture telemetry.
 *
 * Returns masked aggregate counters and timestamps. Never exposes message
 * content, prompt tokens, secrets, or correlation payloads.
 */
import { NextResponse } from "next/server";

import {
  audit,
  getService,
  jsonErrorFromUnknown,
  resolveOwner,
  serviceUnavailableResponse,
} from "@/memory/api/handlers/_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = await resolveOwner(request);
  if ("errorResponse" in owner) return owner.errorResponse;

  try {
    const service = getService();
    const telemetry = await service.getL0CaptureStatus(owner);
    await audit({
      action: "memory.l0.status.read",
      actor: owner.actor,
      target: "l0-capture-status",
      resourceType: "l0_capture_telemetry",
      details: { successCount: telemetry.successCount, failureCount: telemetry.failureCount },
      request,
    });
    return NextResponse.json({ data: telemetry });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, {
      status: 500,
      message: "Failed to read L0 capture status",
    });
  }
}
