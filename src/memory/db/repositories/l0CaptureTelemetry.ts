/**
 * L0 capture telemetry repository.
 *
 * Persists owner-scoped, masked aggregate counters for L0 capture attempts.
 * NEVER stores message content, tokens, secrets, correlation payloads, or any
 * field that could leak user-visible data. The `lastFailureCategory` only
 * contains an allow-listed category name (e.g. "storage_error") that the
 * capture pipeline classifies; full error messages are logged but not stored.
 */
import { getMemoryDbInstance } from "../core.ts";

export const L0_FAILURE_CATEGORIES = new Set([
  "storage_error",
  "invalid_owner",
  "gate_rejected",
  "telemetry_unavailable",
]);

export interface L0CaptureTelemetry {
  ownerApiKeyId: string;
  successCount: number;
  failureCount: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCategory: string | null;
}

interface TelemetryRow {
  owner_api_key_id: string;
  success_count: number;
  failure_count: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_category: string | null;
}

function rowToTelemetry(row: TelemetryRow): L0CaptureTelemetry {
  return {
    ownerApiKeyId: row.owner_api_key_id,
    successCount: Number(row.success_count ?? 0),
    failureCount: Number(row.failure_count ?? 0),
    lastSuccessAt:
      typeof row.last_success_at === "number" ? new Date(row.last_success_at).toISOString() : null,
    lastFailureAt:
      typeof row.last_failure_at === "number" ? new Date(row.last_failure_at).toISOString() : null,
    lastFailureCategory: row.last_failure_category,
  };
}

function blankTelemetry(ownerApiKeyId: string): L0CaptureTelemetry {
  return {
    ownerApiKeyId,
    successCount: 0,
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCategory: null,
  };
}

export function recordL0CaptureSuccess(ownerApiKeyId: string): void {
  const key = ownerApiKeyId.trim();
  if (!key) return;
  const now = Date.now();
  try {
    getMemoryDbInstance()
      .prepare(
        `INSERT INTO l0_capture_telemetry (
          owner_api_key_id, success_count, failure_count,
          last_success_at, last_failure_at, last_failure_category
        ) VALUES (?, 1, 0, ?, NULL, NULL)
        ON CONFLICT(owner_api_key_id) DO UPDATE SET
          success_count = success_count + 1,
          last_success_at = excluded.last_success_at`
      )
      .run(key, now);
  } catch {
    // Telemetry MUST NOT block the chat request; swallowed at this layer.
  }
}

export function recordL0CaptureFailure(ownerApiKeyId: string, category: string | null): void {
  const key = ownerApiKeyId.trim();
  if (!key) return;
  const safeCategory =
    typeof category === "string" && L0_FAILURE_CATEGORIES.has(category) ? category : null;
  const now = Date.now();
  try {
    getMemoryDbInstance()
      .prepare(
        `INSERT INTO l0_capture_telemetry (
          owner_api_key_id, success_count, failure_count,
          last_success_at, last_failure_at, last_failure_category
        ) VALUES (?, 0, 1, NULL, ?, ?)
        ON CONFLICT(owner_api_key_id) DO UPDATE SET
          failure_count = failure_count + 1,
          last_failure_at = excluded.last_failure_at,
          last_failure_category = excluded.last_failure_category`
      )
      .run(key, now, safeCategory);
  } catch {
    // Telemetry MUST NOT block the chat request; swallowed at this layer.
  }
}

export function readL0CaptureTelemetry(ownerApiKeyId: string): L0CaptureTelemetry {
  const key = ownerApiKeyId.trim();
  if (!key) return blankTelemetry(ownerApiKeyId);
  try {
    const row = getMemoryDbInstance()
      .prepare(
        `SELECT owner_api_key_id, success_count, failure_count,
                last_success_at, last_failure_at, last_failure_category
         FROM l0_capture_telemetry WHERE owner_api_key_id = ?`
      )
      .get(key) as TelemetryRow | undefined;
    return row ? rowToTelemetry(row) : blankTelemetry(key);
  } catch {
    return blankTelemetry(key);
  }
}
