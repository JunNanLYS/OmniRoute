/**
 * L1.5 task-judgment parser — adapted from TencentDB Agent Memory (MIT).
 *
 * Upstream source:
 *   MemoryCore/src/offload_server/parsers/l15-parser.ts
 *     (parseL15Response, toBool, isSafeFilename)
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * ADAPTED FROM TencentDB Agent Memory (MIT). Copyright (C) 2026 Tencent.
 */

import { extractJson } from "./json-utils.js";

export interface TaskJudgment {
  taskCompleted: boolean;
  isContinuation: boolean;
  isLongTask: boolean;
  /** Validated against `isSafeFilename`. */
  continuationMmdFile?: string;
  newTaskLabel?: string;
}

interface RawL15Response {
  taskCompleted?: boolean | null;
  isContinuation?: boolean | null;
  isLongTask?: boolean | null;
  continuationMmdFile?: string | null;
  newTaskLabel?: string | null;
}

/**
 * Parse L1.5 LLM response into a TaskJudgment.
 *
 * Returns null when parsing fails or all decision fields are null (the LLM
 * refused to answer, e.g. JSON failure or only "null" output).
 */
export function parseL15Response(raw: string): TaskJudgment | null {
  const parsed = extractJson<RawL15Response>(raw);
  if (!parsed || typeof parsed !== "object") return null;

  if (parsed.taskCompleted == null && parsed.isContinuation == null && parsed.isLongTask == null) {
    return null;
  }

  return {
    taskCompleted: toBool(parsed.taskCompleted),
    isContinuation: toBool(parsed.isContinuation),
    isLongTask: toBool(parsed.isLongTask),
    continuationMmdFile:
      typeof parsed.continuationMmdFile === "string" && isSafeFilename(parsed.continuationMmdFile)
        ? parsed.continuationMmdFile
        : undefined,
    newTaskLabel: typeof parsed.newTaskLabel === "string" ? parsed.newTaskLabel : undefined,
  };
}

function toBool(value: unknown): boolean {
  if (typeof value === "string") {
    return value.toLowerCase() !== "false" && value !== "0" && value !== "";
  }
  return Boolean(value);
}

function isSafeFilename(name: string): boolean {
  if (!name) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return /^[a-zA-Z0-9_.\-]+$/.test(name);
}
