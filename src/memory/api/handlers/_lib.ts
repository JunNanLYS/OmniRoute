/**
 * Shared handler helpers for the four-layer memory API.
 *
 *  - `resolveAuthSubject()` — derive the auth subject from the request. Owner
 *    is ALWAYS `actor.apiKeyId` for the self scope; the management dashboard
 *    can override via `?apiKeyId=` ONLY after `requireManagementAuth`.
 *  - `resolveOwnerApiKeyId()` — pick the effective owner based on the actor
 *    + the optional query hint. Self callers cannot cross owners; management
 *    callers can.
 *  - `createErrorResponse()` / `buildErrorBody()` — pass-through to the
 *    shared helpers so each route returns the same error envelope.
 *  - `audit()` — sugar over the audit DI.
 *
 * NO raw SQL or DB calls in this file. All storage goes through
 * `getFourLayerService()`.
 */
import { NextResponse } from "next/server";

import { createErrorResponse } from "@/lib/api/errorResponse";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { hasManageScope } from "@/shared/constants/managementScopes";

import { ownerFromApiKeyId } from "@/memory/integration/runtime";

import {
  type AuditWriter,
  type AuthSubject,
  type MemoryRequestScope,
  getAuditWriter,
  getFourLayerService,
  getProviderModelValidator,
} from "../dependencies.ts";

export const DASHBOARD_ACTOR = "dashboard";

/**
 * Pull the bearer key from the request, ignoring URL-borne credentials.
 * Mirrors the management-auth contract (see `#3300`).
 */
function readBearerKey(request: Request): string | null {
  return extractApiKey(request, { allowUrl: false });
}

/**
 * Resolve the auth subject from the request. The subject is the ONLY source
 * of `ownerApiKeyId` for self callers — body/query values are ignored.
 *
 * Resolution order:
 *  1. Dashboard session cookie → `actor='dashboard'`, `userId` from JWT payload
 *     (`sub`/`id`), `isManagement=true`.
 *  2. Bearer API key → `actor='apiKey'`, `apiKeyId` from key metadata,
 *     `isManagement = hasManageScope(scopes)`.
 *  3. Neither → null.
 */
export async function resolveAuthSubject(request: Request): Promise<AuthSubject | null> {
  if (await isDashboardSessionAuthenticated(request)) {
    return {
      apiKeyId: null,
      userId: "dashboard",
      actor: DASHBOARD_ACTOR,
      isManagement: true,
      apiKey: "",
    };
  }

  const key = readBearerKey(request);
  if (!key) return null;

  // isValidApiKey does the env-var fallback and DB lookup.
  if (!(await isValidApiKey(key))) return null;
  const meta = await getApiKeyMetadata(key);
  if (!meta) return null;

  return {
    apiKeyId: meta.id,
    userId: null,
    actor: "apiKey",
    isManagement: hasManageScope(meta.scopes),
    apiKey: key,
  };
}

/**
 * Produce the effective owner for the request.
 *
 *  - Self callers (non-management) → MUST equal `actor.apiKeyId`. A query/body
 *    override is rejected with 403.
 *  - Management callers → can target any apiKeyId via `?apiKeyId=...`. If
 *    absent, falls back to the calling key (or `null` for dashboard sessions).
 *
 * `paramName` lets the caller pass in a non-default query/body field name
 * (e.g. for `apiKeyId` reads). The default reads the URL query.
 */
export interface OwnerResolution extends MemoryRequestScope {
  /** True when the caller is management AND the override was honored. */
  ownerOverride: boolean;
}

export async function resolveOwner(
  request: Request,
  options: {
    paramName?: string;
    allowManagementOverride?: boolean;
    /** Override the value pulled from query (e.g. a body-derived apiKeyId). */
    override?: string | null;
  } = {}
): Promise<OwnerResolution | { errorResponse: Response }> {
  const { paramName = "apiKeyId", allowManagementOverride = true, override } = options;

  const actor = await resolveAuthSubject(request);
  if (!actor) {
    return {
      errorResponse: createErrorResponse({
        status: 401,
        message: "Authentication required",
        type: "invalid_request",
      }),
    };
  }

  const url = new URL(request.url);
  const queryValue = url.searchParams.get(paramName);
  const fromQuery = override ?? queryValue;

  // Self callers cannot cross owner.
  if (fromQuery && actor.actor === "apiKey" && !actor.isManagement) {
    if (fromQuery !== actor.apiKeyId) {
      return {
        errorResponse: createErrorResponse({
          status: 403,
          message: "Self API key cannot target a different owner",
          type: "invalid_request",
        }),
      };
    }
  }

  // Management caller override
  if (
    fromQuery &&
    actor.isManagement &&
    allowManagementOverride &&
    (actor.actor === "dashboard" || actor.actor === "apiKey")
  ) {
    return {
      actor,
      ownerApiKeyId: fromQuery,
      owner: ownerFromApiKeyId(fromQuery),
      ownerOverride: true,
    };
  }

  // No override → fall back to the calling key
  if (actor.actor === "apiKey" && actor.apiKeyId) {
    return {
      actor,
      ownerApiKeyId: actor.apiKeyId,
      owner: ownerFromApiKeyId(actor.apiKeyId),
      ownerOverride: false,
    };
  }

  return {
    errorResponse: createErrorResponse({
      status: 400,
      message: "apiKeyId is required for dashboard memory requests",
      type: "invalid_request",
    }),
  };
}

export function requireManagementActor(actor: AuthSubject | null): Response | null {
  if (!actor) {
    return createErrorResponse({
      status: 401,
      message: "Authentication required",
      type: "invalid_request",
    });
  }
  if (!actor.isManagement) {
    return createErrorResponse({
      status: 403,
      message: "Management scope required",
      type: "invalid_request",
    });
  }
  return null;
}

export async function audit(input: Parameters<AuditWriter>[0]): Promise<void> {
  await getAuditWriter()(input);
}

/**
 * Convert a raw error into a sanitized JSON response. Never returns stack
 * traces or absolute paths.
 */
export function jsonErrorFromUnknown(
  error: unknown,
  fallback: { status: number; message: string }
): Response {
  const message = sanitizeErrorMessage(error instanceof Error ? error.message : error);
  // Surface the fallback when the sanitized string is empty.
  const safe = message && message.trim().length > 0 ? message : fallback.message;
  return NextResponse.json(buildErrorBody(fallback.status, safe), { status: fallback.status });
}

/**
 * Common "service unavailable" wrapper for the no-op storage adapter.
 */
export function serviceUnavailableResponse(): Response {
  return createErrorResponse({
    status: 503,
    message: "Memory four-layer storage is not yet wired in this build",
    type: "server_error",
  });
}

export function buildPagination(input: { page: number; limit: number; total: number }): {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
} {
  const totalPages = input.limit > 0 ? Math.ceil(input.total / input.limit) : 0;
  return { page: input.page, limit: input.limit, total: input.total, totalPages };
}

export { getProviderModelValidator };

export function getService() {
  return getFourLayerService();
}
