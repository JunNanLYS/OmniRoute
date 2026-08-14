import { createHash } from "node:crypto";

import {
  listMessagesForDistillation,
  type L0DistillationCursor,
  type L0DistillationMessage,
} from "../l0.ts";
import { getSetting, upsertSetting } from "../operations.ts";
import { nextL1ScheduleMs } from "../distillation/scheduler.ts";
import type { EnqueueDistillationTaskInput } from "../db/repositories/distillation.ts";
import { ownerFromApiKeyId } from "./runtime.ts";

const MAX_L1_MESSAGES_PER_TASK = 10;
const L1_READ_AHEAD = 20;
const STATE_PREFIX = "distillation.l1.state.";

interface L1SchedulingState {
  cursor: L0DistillationCursor | null;
  completedRuns: number;
}

export interface L1TaskPayload extends Record<string, unknown> {
  sessionId: string;
  correlationId: string | null;
  capturedAt: string;
  sourceMessageIds: string[];
  conversation: string;
  roundCount: number;
  cursorStart: L0DistillationCursor | null;
  cursorEnd: L0DistillationCursor;
}

export interface PlannedL1Task extends EnqueueDistillationTaskInput {
  kind: "L1_extract";
  payload: L1TaskPayload;
  coalesceKey: string;
  coalesceNotBefore: "earliest" | "replace";
}

function stateKey(scope: string, sessionId: string): string {
  const digest = createHash("sha256")
    .update(scope, "utf8")
    .update("\0")
    .update(sessionId, "utf8")
    .digest("hex");
  return `${STATE_PREFIX}${digest}`;
}

function parseCursor(value: unknown): L0DistillationCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cursor = value as Record<string, unknown>;
  return typeof cursor.recordedAt === "string" &&
    typeof cursor.rowId === "number" &&
    Number.isInteger(cursor.rowId) &&
    cursor.rowId >= 0
    ? { recordedAt: cursor.recordedAt, rowId: cursor.rowId }
    : null;
}

function readState(scope: string, sessionId: string): L1SchedulingState {
  const row = getSetting(stateKey(scope, sessionId));
  if (!row) return { cursor: null, completedRuns: 0 };
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    return {
      cursor: parseCursor(parsed.cursor),
      completedRuns:
        typeof parsed.completedRuns === "number" &&
        Number.isInteger(parsed.completedRuns) &&
        parsed.completedRuns >= 0
          ? parsed.completedRuns
          : 0,
    };
  } catch {
    return { cursor: null, completedRuns: 0 };
  }
}

function cursorFor(message: L0DistillationMessage): L0DistillationCursor {
  return { recordedAt: message.recordedAt, rowId: message.cursorRowId };
}

function compareCursor(a: L0DistillationCursor, b: L0DistillationCursor): number {
  const time = a.recordedAt.localeCompare(b.recordedAt);
  return time !== 0 ? time : a.rowId - b.rowId;
}

function formatConversation(messages: readonly L0DistillationMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

export function planPendingL1Task(input: {
  scope: string;
  sessionId: string;
  correlationId: string | null;
  capturedAt: string;
  now?: number;
}): PlannedL1Task | null {
  const scope = input.scope.trim();
  const sessionId = input.sessionId.trim();
  if (!scope || !sessionId) return null;
  const state = readState(scope, sessionId);
  const pending = listMessagesForDistillation({
    owner: ownerFromApiKeyId(scope),
    sessionId,
    after: state.cursor,
    limit: L1_READ_AHEAD,
  }).slice(0, MAX_L1_MESSAGES_PER_TASK);
  if (pending.length === 0) return null;

  const roundCount = pending.filter((message) => message.role === "user").length;
  if (roundCount === 0) return null;
  const now = input.now ?? Date.now();
  const notBefore = nextL1ScheduleMs({
    roundsSinceLast: roundCount,
    completedRuns: state.completedRuns,
    now,
  });
  const cursorEnd = cursorFor(pending[pending.length - 1]!);
  const payload: L1TaskPayload = {
    sessionId,
    correlationId: input.correlationId,
    capturedAt: input.capturedAt,
    sourceMessageIds: pending.map((message) => message.id),
    conversation: formatConversation(pending),
    roundCount,
    cursorStart: state.cursor,
    cursorEnd,
  };
  const thresholdReached = notBefore - now <= 1_000;
  return {
    kind: "L1_extract",
    scope,
    payload,
    priority: 1,
    notBefore,
    coalesceKey: `l1:session:${sessionId}`,
    coalesceNotBefore: thresholdReached ? "earliest" : "replace",
  };
}

export function markL1TaskApplied(input: { scope: string; payload: unknown }): boolean {
  const payload =
    input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : null;
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
  const cursorEnd = parseCursor(payload?.cursorEnd);
  if (!input.scope.trim() || !sessionId || !cursorEnd) return false;

  const current = readState(input.scope, sessionId);
  if (current.cursor && compareCursor(cursorEnd, current.cursor) <= 0) return false;
  upsertSetting(
    stateKey(input.scope, sessionId),
    JSON.stringify({
      cursor: cursorEnd,
      completedRuns: current.completedRuns + 1,
    })
  );
  return true;
}
