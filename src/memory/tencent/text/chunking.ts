/**
 * Head/tail extraction chunking — adapted from TencentDB Agent Memory (MIT).
 *
 * Upstream source:
 *   MemoryCore/src/core/skill/conversation-add/oversize-strategy.ts
 *     (applyOversizeStrategy, DEFAULT_OVERSIZE_OPTIONS, OversizeResult,
 *      OversizeOptions, OversizeMessage)
 *
 * The strategy: when a transcript chunk exceeds the budget, keep a head of
 * recent-tokens-worth of messages from the start, keep a tail from the end,
 * and replace the omitted middle with a single placeholder message.
 *
 * Pathological case (single message > head/tail budget): allow head and tail
 * to each contain at least 1 message — guarantees the placeholder still
 * represents an actual omission rather than swallowing everything.
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * ADAPTED FROM TencentDB Agent Memory (MIT). Copyright (C) 2026 Tencent.
 */

export interface OversizeChunkMessage {
  role: string;
  content: string;
  /** Optional, opaque metadata pass-through */
  [key: string]: unknown;
  metadata?: Record<string, unknown>;
}

export interface OversizeChunkOptions {
  /** Total budget (bytes). Above this we trim. */
  chunkMaxBytes: number;
  /** Bytes to keep from the head. */
  headKeepBytes: number;
  /** Bytes to keep from the tail. */
  tailKeepBytes: number;
  /** Placeholder content template. `{n}` → omitted count, `{bytes}` → omitted bytes. */
  placeholderTemplate: string;
}

export const DEFAULT_OVERSIZE_OPTIONS: OversizeChunkOptions = {
  chunkMaxBytes: 81_920, // 80KB
  headKeepBytes: 20_480, // 20KB
  tailKeepBytes: 20_480, // 20KB
  placeholderTemplate: "[中间 {n} 条消息 / {bytes} 字节内容过长已省略]",
};

export interface OversizeChunkResult {
  /** Trimmed messages (head + placeholder + tail). */
  messages: OversizeChunkMessage[];
  /** True iff truncation happened. */
  truncated: boolean;
  omittedMessageCount: number;
  omittedBytes: number;
}

function messageBytes(msg: OversizeChunkMessage): number {
  return Buffer.byteLength(JSON.stringify(msg), "utf8");
}

function totalBytes(msgs: OversizeChunkMessage[]): number {
  let sum = 0;
  for (const m of msgs) sum += messageBytes(m);
  return sum;
}

/**
 * Apply head/tail truncation to keep within `chunkMaxBytes`.
 *
 * Behavior parity with upstream:
 *   - passthrough when `total <= chunkMaxBytes`
 *   - head accumulates from index 0, tail accumulates from end
 *   - the two regions are non-overlapping (tail starts at headEnd)
 *   - if headEnd === tailStart (omitted = 0) → passthrough
 */
export function applyOversizeStrategy(
  messages: OversizeChunkMessage[],
  optsOverride: Partial<OversizeChunkOptions> = {}
): OversizeChunkResult {
  const opts: OversizeChunkOptions = { ...DEFAULT_OVERSIZE_OPTIONS, ...optsOverride };

  if (messages.length === 0) {
    return { messages: [], truncated: false, omittedMessageCount: 0, omittedBytes: 0 };
  }

  const total = totalBytes(messages);
  if (total <= opts.chunkMaxBytes) {
    return { messages: [...messages], truncated: false, omittedMessageCount: 0, omittedBytes: 0 };
  }

  // accumulate head
  const headMsgs: OversizeChunkMessage[] = [];
  let headBytes = 0;
  let headEnd = 0; // exclusive
  for (let i = 0; i < messages.length; i++) {
    const b = messageBytes(messages[i]!);
    // allow head at least 1 message even if it exceeds headKeep
    if (headMsgs.length > 0 && headBytes + b > opts.headKeepBytes) break;
    headMsgs.push(messages[i]!);
    headBytes += b;
    headEnd = i + 1;
    if (headBytes >= opts.headKeepBytes) break;
  }

  // accumulate tail (do not eat head region)
  const tailMsgs: OversizeChunkMessage[] = [];
  let tailBytes = 0;
  let tailStart = messages.length;
  for (let i = messages.length - 1; i >= headEnd; i--) {
    const b = messageBytes(messages[i]!);
    if (tailMsgs.length > 0 && tailBytes + b > opts.tailKeepBytes) break;
    tailMsgs.unshift(messages[i]!);
    tailBytes += b;
    tailStart = i;
    if (tailBytes >= opts.tailKeepBytes) break;
  }

  const omittedSlice = messages.slice(headEnd, tailStart);
  const omittedMessageCount = omittedSlice.length;
  const omittedBytes = totalBytes(omittedSlice);

  // edge case: head+tail cover everything → no real omission, passthrough
  if (omittedMessageCount === 0) {
    return {
      messages: [...messages],
      truncated: false,
      omittedMessageCount: 0,
      omittedBytes: 0,
    };
  }

  const placeholderContent = opts.placeholderTemplate
    .replace("{n}", String(omittedMessageCount))
    .replace("{bytes}", String(omittedBytes));

  const placeholder: OversizeChunkMessage = {
    role: "system",
    content: placeholderContent,
    metadata: {
      omitted_message_count: omittedMessageCount,
      omitted_bytes: omittedBytes,
    },
  };

  return {
    messages: [...headMsgs, placeholder, ...tailMsgs],
    truncated: true,
    omittedMessageCount,
    omittedBytes,
  };
}
