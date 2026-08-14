/**
 * /api/memory/distillation-model — selector management.
 *
 *  - GET  → effective selector. `sourceLayer` tells the caller which rung of
 *           the ladder supplied the value (per-key / global / env / auto).
 *  - PUT  → set provider, modelId, scope. `scope='global'` requires
 *           management scope.
 *  - DELETE → remove the configured selector (scope=self|global).
 *
 * Validation:
 *  1. Zod schema (`DistillationPutSchema`).
 *  2. The provider must be an active configured provider.
 *  3. The modelId must be in the synced available model catalog for that
 *     provider (DI'd via `getProviderModelValidator()`).
 */
import { NextResponse } from "next/server";

import { validatedJsonBody } from "@/shared/validation/helpers";
import { DistillationPutSchema } from "@/shared/schemas/memoryFourLayer";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { ownerFromApiKeyId } from "@/memory/integration/runtime";

import {
  audit,
  getProviderModelValidator,
  getService,
  jsonErrorFromUnknown,
  requireManagementActor,
  resolveAuthSubject,
  serviceUnavailableResponse,
} from "@/memory/api/handlers/_lib";

export const dynamic = "force-dynamic";

const GLOBAL_SCOPE = "global";

export async function GET(request: Request) {
  const actor = await resolveAuthSubject(request);
  if (!actor) {
    return createErrorResponse({
      status: 401,
      message: "Authentication required",
      type: "invalid_request",
    });
  }

  const url = new URL(request.url);
  const apiKeyHint = url.searchParams.get("apiKeyId");
  const effectiveApiKeyId = apiKeyHint ?? actor.apiKeyId;

  // Self caller cannot peek at another key.
  if (apiKeyHint && actor.actor === "apiKey" && !actor.isManagement) {
    if (apiKeyHint !== actor.apiKeyId) {
      return createErrorResponse({
        status: 403,
        message: "Self API key cannot inspect another owner's selector",
        type: "invalid_request",
      });
    }
  }

  try {
    const service = getService();
    const selector = await service.getDistillationSelector(
      effectiveApiKeyId
        ? {
            actor,
            ownerApiKeyId: effectiveApiKeyId,
            owner: ownerFromApiKeyId(effectiveApiKeyId),
          }
        : { actor },
      effectiveApiKeyId
    );
    return NextResponse.json({ data: selector });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, {
      status: 500,
      message: "Failed to read distillation selector",
    });
  }
}

export async function PUT(request: Request) {
  const actor = await resolveAuthSubject(request);
  if (!actor) {
    return createErrorResponse({
      status: 401,
      message: "Authentication required",
      type: "invalid_request",
    });
  }

  const body = await validatedJsonBody(request, DistillationPutSchema);
  if (!body.success) return body.response;

  // Global scope requires management auth.
  if (body.data.scope === GLOBAL_SCOPE) {
    const err = requireManagementActor(actor);
    if (err) return err;
  }

  // Self scope requires the calling API key.
  if (body.data.scope === "self" && actor.actor === "apiKey") {
    if (body.data.apiKeyId && body.data.apiKeyId !== actor.apiKeyId) {
      return createErrorResponse({
        status: 403,
        message: "Self API key cannot write another owner's selector",
        type: "invalid_request",
      });
    }
    body.data.apiKeyId = actor.apiKeyId;
  }

  // Validate provider+model against the synced catalog.
  const validator = getProviderModelValidator();
  const validation = await validator({
    provider: body.data.provider,
    modelId: body.data.modelId,
  });
  if (!validation.ok) {
    return createErrorResponse({
      status: 400,
      message: "Validation failed",
      type: "invalid_request",
      details: { reason: validation.reason },
    });
  }

  try {
    const service = getService();
    const targetApiKeyId =
      body.data.scope === "self" ? (body.data.apiKeyId ?? actor.apiKeyId) : null;
    const result = await service.setDistillationSelector(
      targetApiKeyId
        ? {
            actor,
            ownerApiKeyId: targetApiKeyId,
            owner: ownerFromApiKeyId(targetApiKeyId),
          }
        : { actor },
      body.data
    );
    await audit({
      action: "memory.distillation_model.set",
      actor: actor,
      target: `distillation-model:${result.scope}`,
      resourceType: "distillation_model",
      details: {
        provider: result.provider,
        modelId: result.modelId,
        scope: result.scope,
        apiKeyId: result.apiKeyId,
      },
      request,
    });
    return NextResponse.json({ data: result });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, {
      status: 400,
      message: "Failed to update distillation selector",
    });
  }
}

export async function DELETE(request: Request) {
  const actor = await resolveAuthSubject(request);
  if (!actor) {
    return createErrorResponse({
      status: 401,
      message: "Authentication required",
      type: "invalid_request",
    });
  }

  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") ?? GLOBAL_SCOPE;
  const apiKeyHint = url.searchParams.get("apiKeyId");

  if (scope !== "self" && scope !== GLOBAL_SCOPE) {
    return createErrorResponse({
      status: 400,
      message: "Invalid scope",
      type: "invalid_request",
    });
  }
  if (scope === GLOBAL_SCOPE) {
    const err = requireManagementActor(actor);
    if (err) return err;
  }
  if (scope === "self" && actor.actor === "apiKey") {
    if (apiKeyHint && apiKeyHint !== actor.apiKeyId) {
      return createErrorResponse({
        status: 403,
        message: "Self API key cannot drop another owner's selector",
        type: "invalid_request",
      });
    }
  }

  try {
    const service = getService();
    const targetApiKeyId = scope === "self" ? (apiKeyHint ?? actor.apiKeyId) : null;
    const ok = await service.deleteDistillationSelector(
      targetApiKeyId
        ? {
            actor,
            ownerApiKeyId: targetApiKeyId,
            owner: ownerFromApiKeyId(targetApiKeyId),
          }
        : { actor },
      scope,
      targetApiKeyId
    );
    if (!ok) {
      return createErrorResponse({
        status: 404,
        message: "Distillation selector not found",
        type: "not_found",
      });
    }
    await audit({
      action: "memory.distillation_model.delete",
      actor: actor,
      target: `distillation-model:${scope}`,
      resourceType: "distillation_model",
      request,
    });
    return NextResponse.json({ success: true, scope });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "memory four-layer storage not wired") {
      return serviceUnavailableResponse();
    }
    return jsonErrorFromUnknown(err, {
      status: 400,
      message: "Failed to delete distillation selector",
    });
  }
}
