/**
 * Memory tools guide — adapted from TencentDB Agent Memory (MIT).
 *
 * Upstream source:
 *   MemoryCore/src/core/hooks/auto-recall.ts
 *     (MEMORY_TOOLS_GUIDE — a `<memory-tools-guide>...</memory-tools-guide>`
 *      block injected at the end of memory context)
 *
 * Local adaptation:
 *   - Tool names are aligned to the OmniRoute native worker (the upstream
 *     names `tdai_memory_search` / `tdai_conversation_search` are preserved
 *     to keep behavior parity with the original).
 *   - The combined ≤3 calls/turn semantic is preserved.
 *   - The `read_file` reference is preserved because L2 scenes can be read
 *     via the native worker.
 *   - The block is exposed both as a tagged string and as a parsed guide
 *     object so callers can emit it programmatically.
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * ADAPTED FROM TencentDB Agent Memory (MIT). Copyright (C) 2026 Tencent.
 */

/** Per-turn combined-call budget for the two memory tools. */
export const MEMORY_TOOLS_PER_TURN_LIMIT = 3;

/** XML tag wrapping the guide block. */
export const MEMORY_TOOLS_GUIDE_OPEN = "<memory-tools-guide>";
export const MEMORY_TOOLS_GUIDE_CLOSE = "</memory-tools-guide>";

/** Tool names referenced by the guide. */
export const TOOL_MEMORY_SEARCH = "tdai_memory_search";
export const TOOL_CONVERSATION_SEARCH = "tdai_conversation_search";
export const TOOL_READ_FILE = "read_file";

export interface MemoryToolDescriptor {
  name: string;
  /** Short description in the guide's voice. */
  description: string;
}

/** Tool list as surfaced to the LLM. Order is preserved for the rendered guide. */
export const MEMORY_TOOLS: ReadonlyArray<MemoryToolDescriptor> = [
  {
    name: TOOL_MEMORY_SEARCH,
    description: "搜索结构化记忆（L1），适用于回忆用户偏好、历史事件节点、规则等关键信息。",
  },
  {
    name: TOOL_CONVERSATION_SEARCH,
    description:
      "搜索原始对话（L0），适用于查找具体消息原文、时间线、上下文细节；也可用于补充或校验 memory_search 的结果。",
  },
  {
    name: TOOL_READ_FILE,
    description:
      "（Scene Navigation 中的路径）：当已定位到相关情境，且需要该场景的完整画像、事件经过或阶段结论时使用。",
  },
];

/**
 * Render the memory tools guide block for injection at the end of memory
 * context. Mirrors upstream `MEMORY_TOOLS_GUIDE`.
 */
export function buildMemoryToolsGuide(): string {
  return `${MEMORY_TOOLS_GUIDE_OPEN}
## 记忆工具调用指南

当上方注入的记忆片段不足以回答用户问题时，可主动调用以下工具获取更多信息：

- **${TOOL_MEMORY_SEARCH}**：${MEMORY_TOOLS[0]!.description}
- **${TOOL_CONVERSATION_SEARCH}**：${MEMORY_TOOLS[1]!.description}
- **${TOOL_READ_FILE}**（Scene Navigation 中的路径）：${MEMORY_TOOLS[2]!.description}

### ⚠️ 调用次数限制
每轮对话中，${TOOL_MEMORY_SEARCH} 和 ${TOOL_CONVERSATION_SEARCH} **合计最多调用 ${MEMORY_TOOLS_PER_TURN_LIMIT} 次**。
- 首次搜索无结果时，可换关键词或换工具重试，但总调用次数不要超过 ${MEMORY_TOOLS_PER_TURN_LIMIT} 次。
- 若 ${MEMORY_TOOLS_PER_TURN_LIMIT} 次搜索后仍无结果，说明该信息不在记忆中，请直接根据已有信息回复用户，不要继续搜索。
${MEMORY_TOOLS_GUIDE_CLOSE}`;
}

/**
 * Plan-mode helper: track memory-tool calls within a single conversation
 * turn. Pure logic — the caller is responsible for advancing the counter
 * when the LLM invokes a tool. Returning `false` signals "stop searching".
 */
export class MemoryToolCallBudget {
  private used: number = 0;
  constructor(public readonly limit: number = MEMORY_TOOLS_PER_TURN_LIMIT) {}

  /** Returns true iff the call would fit in the per-turn budget. */
  canCall(): boolean {
    return this.used < this.limit;
  }

  /** Consume one call. Returns false (and does NOT consume) if the budget is exhausted. */
  consume(): boolean {
    if (!this.canCall()) return false;
    this.used += 1;
    return true;
  }

  /** Number of calls remaining. */
  remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  /** Reset the budget for a new turn. */
  reset(): void {
    this.used = 0;
  }
}
