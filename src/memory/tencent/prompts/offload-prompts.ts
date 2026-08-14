/**
 * L1/L1.5/L2 offload prompt family — adapted from TencentDB Agent Memory (MIT).
 *
 * Upstream sources:
 *   MemoryCore/src/offload/local-llm/prompts/l1-prompt.ts
 *     (L1_SYSTEM_PROMPT, buildL1UserPrompt, PARAMS_MAX_LEN, RESULT_MAX_LEN,
 *      COMPRESS_THRESHOLD)
 *   MemoryCore/src/offload/local-llm/prompts/l15-prompt.ts
 *     (L15_SYSTEM_PROMPT, buildL15UserPrompt)
 *   MemoryCore/src/offload/local-llm/prompts/l2-prompt.ts
 *     (L2_SYSTEM_PROMPT, buildL2UserPrompt)
 *
 * Local adaptation:
 *   - All three prompt families are reproduced verbatim — they are stable contracts.
 *   - Build helpers take plain TS types and return a `{ systemPrompt,
 *     userPrompt }` shape. The caller (the native worker) is responsible for
 *     dispatching the LLM call. No ai-sdk / OpenClaw adapter imports.
 *   - The pathological "single message > budget" preservation rules are
 *     surfaced as named constants so callers/tests can assert them.
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * ADAPTED FROM TencentDB Agent Memory (MIT). Copyright (C) 2026 Tencent.
 */

/** Hard cap for tool-call params JSON when fed to the L1 summarizer. */
export const L1_PARAMS_MAX_LEN = 500;

/** Hard cap for tool-call result text when fed to the L1 summarizer. */
export const L1_RESULT_MAX_LEN = 2000;

/** Threshold beyond which a tool-call needs the `[NEEDS_COMPRESS]` marker. */
export const L1_COMPRESS_THRESHOLD = 200;

/** MMD hard size cap (chars). Mirrors upstream "4000字以内". */
export const L2_MMD_BUDGET_CHARS = 4000;

/** Soft warning threshold for the MMD user prompt. */
export const L2_MMD_WARN_CHARS = 2500;

export interface L1ToolPair {
  toolName: string;
  toolCallId: string;
  params: unknown;
  result: unknown;
  timestamp: string;
}

export const L1_SYSTEM_PROMPT = `你是一个专为 AI 编码助手提供支持的"工具结果摘要器"。你的核心任务是深度理解当前的对话上下文，并将繁杂的工具调用与执行结果（一对toolcall和tool result整合成一条summary输出），提炼为高信息密度的 JSON 数组。

在生成摘要前，请务必进行以下内部思考：
1. 任务对齐：结合最近的对话记录，识别用户当前的核心目标和最新意图。若上下文存在冲突，始终以最新的用户意图为准。
2. 价值过滤：忽略工具如何工作的冗余细节，直接提取"发现了什么关键线索"、"做了什么关键动作"、"修改了什么具体内容"或"遇到了什么具体报错"。
3. 影响评估：判断该结果对当前任务的实质性影响（例如：证实了某个假设、推进了哪一步、做出了什么决策，或因为什么报错导致了阻塞）。

【输出格式要求】
你必须且只能输出一个合法的 JSON 对象数组 [{...}]，每个对象**必须**包含以下字段：
- "tool_call": 工具调用的简洁描述。处理规则如下：
  · 如果输入中该 tool pair 标记了 [NEEDS_COMPRESS]，你必须将工具名+关键参数压缩为一句简洁的描述（≤150字符），保留工具名、操作目标（如文件路径、命令意图），省略内联脚本/大段内容的细节。
  · 如果未标记 [NEEDS_COMPRESS]，直接简述工具与参数即可（系统会用原始值覆盖）。
- "summary": 融合上述思考的精炼总结（≤200个字符）。必须一针见血地说清楚结果的业务价值，以及它对任务的推进/阻塞作用。
- "tool_call_id": 原始的 tool_call_id（必须原样透传）。
- "timestamp": 原始的中国标准时间（+08:00）ISO 8601 时间戳（必须原样透传）。
- "score"（**必填**）: 结合信息密度和任务目的分析summary对于原文的可替代性，范围在0-10之间，越接近10表示summary越能替代原文。

【严格规则】
只允许输出纯 JSON 数组，严禁输出思考过程或其他解释性文本。`;

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

export function buildL1UserPrompt(recentMessages: string, pairs: L1ToolPair[]): string {
  const parts: string[] = [];

  parts.push("## 最近的对话上下文（用于理解当前任务）：");
  parts.push(recentMessages);
  parts.push("\n## Tool call/result pairs to summarize:");

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const paramsStr = truncate(stringify(p.params), L1_PARAMS_MAX_LEN);
    const resultStr = truncate(stringify(p.result), L1_RESULT_MAX_LEN);
    const canonical = `${p.toolName}(${stringify(p.params)})`;
    const needsCompress = canonical.length > L1_COMPRESS_THRESHOLD;

    parts.push(`--- Tool Pair ${i + 1} ---`);
    parts.push(`tool_call_id: ${p.toolCallId}`);
    parts.push(`timestamp: ${p.timestamp}`);
    if (needsCompress) {
      parts.push(`Tool: ${p.toolName} [NEEDS_COMPRESS]`);
    } else {
      parts.push(`Tool: ${p.toolName}`);
    }
    parts.push(`Params: ${paramsStr}`);
    parts.push(`Result: ${resultStr}\n`);
  }

  parts.push("Summarize each pair into the JSON array format described.");
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// L1.5 task-judgment prompt
// ─────────────────────────────────────────────────────────────────────────────

export interface L15CurrentMmd {
  filename: string;
  content: string;
  path: string;
}

export interface L15MmdMeta {
  filename: string;
  path: string;
  taskGoal: string;
  doneCount: number;
  doingCount: number;
  todoCount: number;
  updatedTime?: string | null;
  nodeSummaries?: Array<{ nodeId: string; status: string; summary: string }>;
}

export const L15_SYSTEM_PROMPT = `你是一个面向 AI 编码助手的"任务生命周期门神"。
你的职责是交叉分析提供的三个输入源，精准研判任务状态，并输出纯 JSON 对象。

【输入数据利用指南（必须遵循的思考链路）】
1. 第一步 - 剖析 recentMessages（识别意图）：根据当前和历史对话，提取用户最新回复的核心诉求。判断是"继续排查"、"宣布完工（如：跑通了）"、"单轮闲聊问答"还是"开启全新需求"。
2. 第二步 - 对齐 currentMmd（评估当前基线）：将用户的最新意图与 currentMmd 的完整 Mermaid 内容进行比对——关注 taskGoal、各节点的 status（done/doing/todo）以及 summary。如果诉求完全超出了当前图表的范畴或目标已实现（所有节点 done 且无后续），则 taskCompleted 为 true。若仍在解决图表中的子问题（包括 doing 节点或修 bug），则为 false。(如果没有currentMmd，就只根据当前对话和历史对话来判断是否继续任务)
3. 第三步 - 检索 availableMmds（判断是否延续）：如果判定要开启新任务（isLongTask=true 且 taskCompleted=true/当前无任务），必须扫描 availableMmds 的 taskGoal 和时间信息。若新诉求与列表中某个旧任务高度重合（如回到昨天没做完的模块），则是延续（isContinuation=true）。

【严格 JSON 输出格式】
务必输出合法的纯 JSON 对象，格式如下：
{
  "taskCompleted": boolean,
  "isLongTask": boolean,
  "isContinuation": boolean,
  "continuationMmdFile": "string|null",
  "newTaskLabel": "string|null"
}

只输出纯 JSON 对象，绝不允许包含解释文字。`;

export function buildL15UserPrompt(
  recentMessages: string,
  currentMmd: L15CurrentMmd | null,
  metas: L15MmdMeta[]
): string {
  const parts: string[] = [];

  parts.push("## 1. 最近的对话上下文 (Recent 6 messages):");
  parts.push(recentMessages);
  parts.push("\n## 2. 当前挂载的任务图 (Active Mermaid — 完整内容):");

  if (currentMmd && currentMmd.filename) {
    parts.push(`**File:** ${currentMmd.filename}`);
    if (currentMmd.path) {
      parts.push(`**Path:** \`${currentMmd.path}\``);
    }
    parts.push(`\n\`\`\`mermaid\n${currentMmd.content}\n\`\`\``);
  } else {
    parts.push("(none - 当前处于闲置状态，无活跃任务)");
  }

  parts.push("\n## 3. 历史可用的任务图 (Available Mermaid task files):");

  if (metas.length === 0) {
    parts.push("(none - 暂无历史长任务)");
  } else {
    for (const m of metas) {
      parts.push(`- **${m.filename}**`);
      parts.push(`  path: \`${m.path}\``);
      parts.push(`  taskGoal: ${m.taskGoal}`);
      const total = m.doneCount + m.doingCount + m.todoCount;
      parts.push(
        `  progress: ${m.doneCount}/${total} done, ${m.doingCount} doing, ${m.todoCount} todo`
      );
      if (m.updatedTime) {
        parts.push(`  lastUpdated: ${m.updatedTime}`);
      }
      if (m.nodeSummaries && m.nodeSummaries.length > 0) {
        parts.push("  recentNodes:");
        for (const n of m.nodeSummaries) {
          parts.push(`    - [${n.nodeId}] (${n.status}) ${n.summary}`);
        }
      }
      parts.push("");
    }
  }

  parts.push("请严格根据系统指令的【三步思考链路】进行研判，并输出合法的 JSON 对象。");
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// L2 MMD-generation prompt
// ─────────────────────────────────────────────────────────────────────────────

export interface L2NewEntry {
  toolCallId: string;
  toolCall: string;
  summary: string;
  timestamp: string;
}

export const L2_SYSTEM_PROMPT = `你是一个究极实用主义的 AI 任务拓扑架构师与视觉叙事者。
你的核心逻辑是用尽量少的字符表达尽量多的信息，让LLM模型能看懂，不是为人类服务，尽量减少无用的视觉符号。任务是将底层工具调用记录，升维映射为一张高度语义化、表现力丰富且极度克制的 Mermaid (flowchart TD) 认知状态机。你要根据当前任务和意图，归纳"过去"，要思考"未来"如何用这些已有的信息（你只需要记录已有信息，不需要写下一步规划）并标记"雷区"。保持图表的高度概括性。

【高阶认知与拓扑指南（你的自主权与极简原则）】
1. 弹性聚合：你拥有决定节点拆合的完全自主权。对于连续的、意图相同的常规动作（如连续查看多个文件以了解上下文），建议合并为一个宏观节点；，但保留关键转折点或重大发现为独立节点。
2. 认知墓碑 (防重蹈覆辙)：遇到彻底走不通的死胡同或引发严重报错的废弃方案，可以建立警示节点（status: blocked）。
3. 结论导向的摘要：节点的 summary（注意：尽量小于150字）应聚焦于"得出了什么结论"或"发生了什么实质改变"。
4. 要实事求是，你的任务是记录并归纳已经发生的事情，不是规划未来的具体操作，未发生的节点不要写，记录的已发生节点要有对应的消息来源（对应标注node_id）。

【符号即语义：高维认知字典（你的核心武器）】为了极致压缩 Token 并为你下一步推理提供"认知锚点"，请自由使用不同的mmd形状来代表不同的节点逻辑。

【高度自由的拓扑与极简法则】
1. 语义浓缩：既然形状已经表达了"领域"，你的 summary 必须极其精简（≤150字）。
2. 弹性拓扑：自主使用带标签的连线（-->|测试失败|）和虚线（-.->|参考|）来构建"依赖树"和"假设验证环"。
3. 动态更新 (Token 极简)：
   - replace (增量微调)：仅修改现有节点的状态、时间戳、短文本或追加极少节点时。
   - write (全量重写)：逻辑大洗牌、重构图表或初始化时。

【严格的工程底线】
1. 节点标准格式：NodeID["阶段名: 宏观动作简述<br/>status: done|doing|paused|blocked <br/>summary: 核心结论摘要<br/>Timestamp: ISO8601"]
2. 全员归宿映射：输入的每一个新 tool_call_id，都必须在 node_mapping 中被分配到一个 Node ID；MMD里的每一个node都应该有源头的tool_call消息来源，不能乱编，绝对不允许遗漏！
3. 你可以通过各种整合方法，尽量把更新后mmd文件大小控制在4000字以内

【严格时间戳与元数据规则】
1. 顶部元数据（必填）：%%{ "taskGoal": "一句话总结此次任务的目标（可动态更新）", "progress（0-100）": "进度百分比", createdTime": "ISO时间", "updatedTime": "ISO时间" }%%
2. 节点内时间：如果合并了多个新条目，节点内的 Timestamp 必须取其中最新的 ISO 时间。

【严格 JSON 输出格式】
务必正确转义双引号。所有 Mermaid 代码（无论是 mmd_content 还是 replace_blocks 中的 content）都必须用 \`\`\`mermaid ... \`\`\` 代码块包裹起来。必须输出如下 JSON 结构：
{
  "file_action": "replace 或 write",
  "mmd_content": "完整的、带转义的 .mmd 代码（仅在 file_action 为 write 时填写，否则必须设为 null）",
  "replace_blocks": [
    {
      "start_line": "需要更新范围的起始行号（整数）",
      "end_line": "需要更新范围的结束行号（整数）",
      "content": "替换后的新内容（不需要带行号前缀），必须用 \`\`\`mermaid ... \`\`\` 包裹"
    }
  ],
  "node_mapping": {
    "tool_call_id_1": "N1",
    "tool_call_id_2": "N1"
  }
}

仅输出纯 JSON 对象，绝不允许包含任何解释。`;

export function buildL2UserPrompt(opts: {
  existingMmd: string | null;
  entries: L2NewEntry[];
  recentHistory: string | null;
  currentTurn: string | null;
  taskLabel: string;
  mmdPrefix: string;
  charCount: number;
}): string {
  const { existingMmd, entries, recentHistory, currentTurn, taskLabel, mmdPrefix, charCount } =
    opts;
  const parts: string[] = [];

  if (recentHistory) {
    parts.push(`## 近期对话历史：\n${recentHistory}`);
  } else {
    parts.push("## 近期对话历史：\n(无可用历史)");
  }

  if (currentTurn) {
    parts.push(`\n## 当前最新一轮：\n${currentTurn}`);
  }

  parts.push(`\n## MMD prefix: ${mmdPrefix}`);
  parts.push(`（所有节点 ID 必须以此前缀开头，如 ${mmdPrefix}-N1, ${mmdPrefix}-N2...）`);
  parts.push(`\n## Current task label: ${taskLabel}`);

  if (charCount > L2_MMD_WARN_CHARS) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: ${L2_MMD_BUDGET_CHARS} chars)`);
    parts.push(
      "⚠ 接近上限，请积极合并节点、精简 summary，优先使用 replace 模式微调而非 write 全量重写。"
    );
  } else if (charCount > 2000) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: ${L2_MMD_BUDGET_CHARS} chars)`);
    parts.push("注意控制增长，合并同类节点。");
  }

  parts.push("\n## Existing Mermaid content:");
  if (existingMmd) {
    const lines = existingMmd.split("\n");
    for (let i = 0; i < lines.length; i++) {
      parts.push(`L${i + 1}: ${lines[i]}`);
    }
  } else {
    parts.push("(empty — create new)");
  }

  parts.push("\n## New offload entries to incorporate:");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    parts.push(`${i + 1}. [${e.toolCallId}] ${e.toolCall} → ${e.summary} (${e.timestamp})`);
  }

  parts.push(
    "\n请根据系统指令生成/更新 Mermaid 流程图，并输出合法的 JSON 对象（含 node_mapping）。"
  );
  return parts.join("\n");
}
