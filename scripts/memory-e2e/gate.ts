/**
 * L0 gate — strict structural verification of the raw-capture layer before
 * any semantic scoring. L0 is raw visible memory, NOT an audit log: it must
 * contain exactly the imported history plus the real gateway turn, nothing
 * else, faithfully and in order. A gate failure stops semantic evaluation
 * for the fixture (see docs/superpowers/specs/2026-08-15-memory-e2e-design.md).
 */
import type { FixtureMessage } from "./types.ts";

export interface GateL0Row {
  id: string;
  ownerApiKeyId: string;
  sessionId: string;
  role: string;
  content: string;
  /** Millisecond-precision ISO timestamp (importer-generated for imports). */
  timestamp: string;
  recordedAt: string;
  source: string;
  correlationId: string | null;
  isInternal: boolean;
  truncated: boolean;
  provider: string | null;
  model: string | null;
}

export interface L0GateInput {
  ownerApiKeyId: string;
  sessionId: string;
  /** All L0 rows for the session (any order — the gate sorts by recordedAt). */
  rows: GateL0Row[];
  history: FixtureMessage[];
  finalUser: string;
  /** Assistant text returned by the real gateway call. */
  finalAssistantContent: string;
  /** The X-Correlation-Id the gateway echoed for the final turn. */
  correlationId: string;
  requestedModel: string;
  /** Model reported by the gateway response. */
  gatewayModel: string;
  /**
   * L1 memories of the owner. Only rows whose `metadata.sessionId` matches
   * the fixture session count as distillation evidence for THIS fixture:
   * the harness reuses one owner across suites, so other sessions' L1 rows
   * legitimately reference L0 ids absent from this session and must not
   * fail the check.
   */
  l1Rows: GateL1Row[];
  /** L0 row count visible to the judge key (capture disabled — must be 0). */
  judgeRowCount: number;
}

export interface GateL1Row {
  sourceMessageIds: string[];
  metadata?: { sessionId?: string | null };
}

export interface L0GateCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string | null;
}

export interface L0GateResult {
  passed: boolean;
  failures: string[];
  checks: L0GateCheck[];
}

/** Protocol-necessary normalization only: trim + CRLF unification. */
export function normalizeContent(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function check(
  id: string,
  label: string,
  passed: boolean,
  detail: string | null = null
): L0GateCheck {
  return { id, label, passed, detail };
}

/**
 * Deterministic chronological order. The store's `recorded_at` is
 * second-granular (`datetime('now')`), so it cannot order same-second turns;
 * the importer-generated `timestamp` (ms) is the authoritative sequence. The
 * captured final pair shares one timestamp, so its two rows are ordered by
 * content match (final user, then final assistant).
 */
function orderRows(rows: GateL0Row[], finalUser: string, finalAssistant: string): GateL0Row[] {
  const tieRank = (row: GateL0Row): number => {
    if (row.role === "user" && normalizeContent(row.content) === normalizeContent(finalUser)) {
      return 0;
    }
    if (
      row.role === "assistant" &&
      normalizeContent(row.content) === normalizeContent(finalAssistant)
    ) {
      return 1;
    }
    return 2;
  };
  return [...rows].sort((a, b) => {
    const time = a.timestamp.localeCompare(b.timestamp);
    return time !== 0 ? time : tieRank(a) - tieRank(b);
  });
}

export function evaluateL0Gate(input: L0GateInput): L0GateResult {
  const rows = orderRows(input.rows, input.finalUser, input.finalAssistantContent);
  const checks: L0GateCheck[] = [];

  // 1. Owner + session isolation.
  const foreignOwner = rows.filter(
    (row) => row.ownerApiKeyId !== input.ownerApiKeyId || row.sessionId !== input.sessionId
  );
  checks.push(
    check(
      "owner-session-isolation",
      "Every L0 row belongs to the subject owner and session; judge key captured nothing",
      foreignOwner.length === 0 && input.judgeRowCount === 0,
      foreignOwner.length > 0
        ? `${foreignOwner.length} rows outside owner/session`
        : input.judgeRowCount > 0
          ? `judge key sees ${input.judgeRowCount} L0 rows`
          : null
    )
  );

  // 2. Chronological role order: alternating user/assistant, starting user.
  const expectedRoles: string[] = [];
  for (const message of [
    ...input.history,
    { role: "user", content: input.finalUser },
    { role: "assistant", content: "" },
  ]) {
    expectedRoles.push(message.role);
  }
  const actualRoles = rows.map((row) => row.role);
  const roleOrderOk =
    actualRoles.length === expectedRoles.length &&
    actualRoles.every((role, index) => role === expectedRoles[index]);
  checks.push(
    check(
      "role-order",
      "Roles alternate user/assistant in chronological order",
      roleOrderOk,
      roleOrderOk ? null : `expected ${expectedRoles.join(",")}, got ${actualRoles.join(",")}`
    )
  );

  // 3. Imported history fidelity (order + content, whitespace-normalized).
  const historyOk = input.history.every((message, index) => {
    const row = rows[index];
    return (
      row !== undefined &&
      row.role === message.role &&
      normalizeContent(row.content) === normalizeContent(message.content)
    );
  });
  checks.push(check("history-fidelity", "Imported history matches L0 rows in order", historyOk));

  // 4. Final user fidelity against the actual gateway request.
  const finalUserRow = rows[input.history.length];
  const finalUserOk =
    finalUserRow !== undefined &&
    finalUserRow.role === "user" &&
    normalizeContent(finalUserRow.content) === normalizeContent(input.finalUser);
  checks.push(
    check(
      "final-user-fidelity",
      "Captured final user message equals the gateway request",
      finalUserOk
    )
  );

  // 5. Final assistant fidelity against the actual gateway response.
  const finalAssistantRow = rows.at(-1);
  const finalAssistantOk =
    finalAssistantRow !== undefined &&
    finalAssistantRow.role === "assistant" &&
    normalizeContent(finalAssistantRow.content ?? "") ===
      normalizeContent(input.finalAssistantContent);
  checks.push(
    check(
      "final-assistant-fidelity",
      "Captured final assistant message equals the gateway response",
      finalAssistantOk
    )
  );

  // 6. No duplicates from context replay.
  const expectedCount = input.history.length + 2;
  const ids = new Set(rows.map((row) => row.id));
  const contentKeys = new Set<string>();
  let duplicateContent = false;
  for (const row of rows) {
    const key = `${row.role}\u0000${normalizeContent(row.content)}`;
    if (contentKeys.has(key)) {
      duplicateContent = true;
      break;
    }
    contentKeys.add(key);
  }
  const noDuplicates =
    rows.length === expectedCount && ids.size === rows.length && !duplicateContent;
  checks.push(
    check(
      "no-duplicates",
      `Exactly ${expectedCount} rows, no duplicate ids or replayed content`,
      noDuplicates,
      noDuplicates ? null : `rows=${rows.length}, duplicateContent=${duplicateContent}`
    )
  );

  // 7. L0 is visible memory only — never truncated or internal.
  const flagged = rows.filter((row) => row.truncated || row.isInternal);
  checks.push(
    check(
      "not-truncated-internal",
      "Every row has truncated=false and is_internal=false",
      flagged.length === 0,
      flagged.length > 0 ? `${flagged.length} rows truncated/internal` : null
    )
  );

  // 8. Subject provider/model match. The gateway response and the captured
  //    rows may both normalize the model to its suffix (e.g. "mock-model"
  //    instead of "mock/mock-model"), so compare the trailing segment.
  const requestedSuffix = input.requestedModel.toLowerCase().split("/").pop() ?? "";
  const gatewayModel = input.gatewayModel.toLowerCase();
  const modelMatches =
    gatewayModel === input.requestedModel.toLowerCase() ||
    gatewayModel === requestedSuffix ||
    gatewayModel.endsWith(`/${requestedSuffix}`);
  const capturedModels = rows.slice(input.history.length).map((row) => row.model ?? null);
  const capturedModelOk = capturedModels.every(
    (model) => model === null || model.toLowerCase().endsWith(requestedSuffix)
  );
  const modelDetail = `requested=${input.requestedModel} gateway=${input.gatewayModel} captured=${JSON.stringify(capturedModels)}`;
  checks.push(
    check(
      "provider-model-match",
      `Gateway + captured rows match the requested model (${input.requestedModel})`,
      modelMatches && capturedModelOk,
      modelMatches && capturedModelOk ? null : modelDetail
    )
  );

  // 9. Correlation traceability for the gateway turn.
  const finalRows = rows.slice(input.history.length);
  const correlationOk =
    finalRows.length === 2 && finalRows.every((row) => row.correlationId === input.correlationId);
  checks.push(
    check(
      "correlation-traceability",
      "Final gateway turn carries the echoed X-Correlation-Id",
      correlationOk
    )
  );

  // 10. L1 references real L0 message ids (scoped to this session only).
  const l0Ids = new Set(rows.map((row) => row.id));
  const sessionL1Rows = input.l1Rows.filter((row) => row.metadata?.sessionId === input.sessionId);
  const dangling = sessionL1Rows.flatMap((row) =>
    row.sourceMessageIds.filter((id) => !l0Ids.has(id))
  );
  checks.push(
    check(
      "l1-references-l0",
      "Every L1 sourceMessageIds entry exists in L0",
      dangling.length === 0,
      dangling.length > 0 ? `dangling ids: ${dangling.slice(0, 3).join(", ")}` : null
    )
  );

  const failures = checks
    .filter((item) => !item.passed)
    .map((item) => `${item.id}: ${item.detail ?? item.label}`);
  return { passed: failures.length === 0, failures, checks };
}
