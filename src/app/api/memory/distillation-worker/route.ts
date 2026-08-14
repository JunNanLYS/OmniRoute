/**
 * /api/memory/distillation-worker — process-global worker lifecycle controls.
 *
 * These settings intentionally require management auth: unlike per-key memory
 * pipeline settings, they can consume provider tokens for every owner. The
 * route never exposes the process-local HMAC secret.
 */
import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { validatedJsonBody } from "@/shared/validation/helpers";
import { DistillationWorkerPutSchema } from "@/shared/schemas/memoryFourLayer";
import {
  getDistillationWorkerStatus,
  reconcileDistillationWorker,
} from "@/memory/distillation/public.ts";
import {
  deleteDistillationWorkerRuntimeConfig,
  resolveDistillationWorkerRuntimeConfig,
  saveDistillationWorkerRuntimeConfig,
} from "@/memory/integration/distillationWorkerSettings.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const config = resolveDistillationWorkerRuntimeConfig();
  return NextResponse.json({
    data: {
      enabled: config.enabled,
      intervalSeconds: config.intervalSeconds,
      concurrency: config.concurrency,
      sourceLayer: config.sourceLayer,
      runtime: getDistillationWorkerStatus(),
    },
  });
}

export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const body = await validatedJsonBody(request, DistillationWorkerPutSchema);
  if (!body.success) return body.response;

  const config = saveDistillationWorkerRuntimeConfig(body.data);
  const runtime = await reconcileDistillationWorker(config);
  return NextResponse.json({
    data: {
      ...config,
      runtime,
    },
  });
}

export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const config = deleteDistillationWorkerRuntimeConfig();
  const runtime = await reconcileDistillationWorker(config);
  return NextResponse.json({
    data: {
      ...config,
      runtime,
    },
  });
}
