/**
 * L0 text sanitization & chunking helpers — selectively adapted from
 * TencentDB Agent Memory (MIT).
 *
 * Upstream source:
 *   MemoryCore/src/utils/sanitize.ts (functions: sanitizeText, stripCodeBlocks,
 *   sanitizeJsonForParse, escapeControlCharsInJsonStrings, escapeXmlTags,
 *   shouldExtractL1, shouldCaptureL0, looksLikePromptInjection, isFrameworkNoise)
 *   MemoryCore/src/core/skill/conversation-add/oversize-strategy.ts
 *     (applyOversizeStrategy + DEFAULT_OVERSIZE_OPTIONS)
 *
 * Local adaptation:
 *   - The chatCore/storage/cos adapters are NOT ported. Only the pure helpers
 *     that operate on text (no fs/IO) are reproduced here so they can be reused
 *     by the native memory worker without an SDK boundary.
 *   - All scan/regex patterns kept identical (they are part of the upstream
 *     contract). Markers (logs, tags) and unused storage-aware branches are
 *     trimmed.
 *   - `sanitizeJsonForParse` and `escapeControlCharsInJsonStrings` are ported
 *     verbatim because RFC-8259 control-char escaping is contractually stable.
 *   - `applyOversizeStrategy` is ported verbatim because the head/tail
 *     budget + placeholder semantics are the load-bearing contract.
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * ADAPTED FROM TencentDB Agent Memory (MIT). Copyright (C) 2026 Tencent.
 */

/**
 * Clean text for the memory pipeline: remove injected tags, framework metadata,
 * timestamps, media markers, base64 image data.
 *
 * Same set of substitutions as upstream `sanitizeText` — kept identical so the
 * existing extraction/recall code can rely on identical behavior.
 */
export function sanitizeText(text: string): string {
  let cleaned = text;

  // Remove injected memory context tags (prevent feedback loops)
  cleaned = cleaned.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, "");
  cleaned = cleaned.replace(/<user-persona>[\s\S]*?<\/user-persona>/g, "");
  cleaned = cleaned.replace(/<relevant-scenes>[\s\S]*?<\/relevant-scenes>/g, "");
  cleaned = cleaned.replace(/<scene-navigation>[\s\S]*?<\/scene-navigation>/g, "");

  // Remove offload-injected task context blocks (MMD mermaid diagrams)
  cleaned = cleaned.replace(/<current_task_context>[\s\S]*?<\/current_task_context>/g, "");
  cleaned = cleaned.replace(/<history_task_context[\s\S]*?<\/history_task_context>/g, "");

  // Remove framework-injected inbound metadata blocks (label:\n```json\n...\n```)
  cleaned = cleaned.replace(
    /(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply)\s*\(untrusted[\s\S]*?\):\s*```json\s*[\s\S]*?```/g,
    ""
  );

  // Remove conversation metadata JSON blocks (legacy pattern)
  cleaned = cleaned.replace(/```json\s*\{[\s\S]*?"session[\s\S]*?\}\s*```/g, "");

  // Remove framework reply directive tags: [[reply_to_current]], etc.
  cleaned = cleaned.replace(/\[\[reply_to[^\]]*\]\]\s*/g, "");

  // Remove injected skill-selection wrappers, e.g. ¥¥[...]¥¥
  cleaned = cleaned.replace(/¥¥\[[\s\S]*?\]¥¥/g, "");

  // Remove line-leading timestamps, e.g. "[Tue 2026-03-24 03:48 UTC]"
  cleaned = cleaned.replace(/^\[[\w\d\-:+ ]+\]\s*/gm, "");

  // Remove gateway media-attachment markers
  cleaned = cleaned.replace(/\[media attached:[^\]]*\]\s*/g, "");

  // Remove gateway image-reply instructions injected after media attachments.
  cleaned = cleaned.replace(
    /To send an image back,[\s\S]*?(?:Keep caption in the text body\.)\s*/g,
    ""
  );

  // Remove "System: [timestamp] Exec completed ..." blocks appended by the framework.
  cleaned = cleaned.replace(/^System:\s*\[[\s\S]*?$/gm, "");

  // Remove inline base64 image data URIs
  cleaned = cleaned.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, "");

  // Remove null chars + compress whitespace
  cleaned = cleaned
    .replace(/\0/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
}

/**
 * Strip fenced code blocks from assistant replies before L0 capture.
 *
 * Only applied to assistant messages; user/recall queries are NOT affected.
 */
export function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[^\n]*\n[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Escape XML-like tags in text to prevent tag injection attacks when memory
 * content is injected into XML-delimited sections.
 *
 * Ported verbatim from upstream `escapeXmlTags`.
 */
export function escapeXmlTags(text: string): string {
  return text.replace(
    /<\/?(?:user-persona|relevant-memories|scene-navigation|relevant-scenes|memory-tools-guide|system|assistant)>/gi,
    (match) => match.replace(/</g, "&lt;").replace(/>/g, "&gt;")
  );
}

/**
 * L0 capture filter — intentionally permissive.
 *
 * Only messages that are *structurally* useless are dropped.
 */
export function shouldCaptureL0(text: string): boolean {
  if (!text || !text.trim()) return false;

  if (isFrameworkNoise(text)) return false;
  if (text.startsWith("/")) return false;

  return true;
}

/**
 * L1 extraction filter — strict quality gate.
 *
 * Superset of `shouldCaptureL0` plus length/content-quality checks.
 */
export function shouldExtractL1(text: string): boolean {
  if (!shouldCaptureL0(text)) return false;

  // Match strings composed entirely of non-word, non-space, non-CJK chars
  if (/^[^\w\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{1,5}$/.test(text)) return false;
  if (/^[?？]+$/.test(text)) return false;

  return true;
}

/**
 * Detect likely prompt-injection / jailbreak attempts.
 *
 * Pattern set kept identical to upstream `looksLikePromptInjection`.
 */
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\b.{0,30}\b(instructions|rules|guidelines)/i,
  /disregard\b.{0,30}\b(instructions|rules|guidelines)/i,
  /forget\b.{0,30}\b(instructions|rules|context)/i,
  /override\b.{0,30}\b(instructions|rules|guidelines|safety)/i,

  /you are now (?!going|about|ready)/i,
  /act as (?:if you are |if you were )?(?:a |an )?(?:root|admin|unrestricted|unfiltered|jailbroken)/i,
  /enter (?:DAN|jailbreak|god|sudo|developer|dev|debug|unrestricted|unfiltered) mode/i,
  /switch to (?:DAN|jailbreak|god|sudo|developer|dev|debug|unrestricted|unfiltered) mode/i,

  /(?:show|reveal|print|output|display|repeat|leak|dump|give)\b.{0,20}\bsystem prompt/i,
  /reveal (?:your |the )?(?:system|hidden|secret|internal) (?:prompt|instructions|rules)/i,
  /what (?:are|is) your (?:system|hidden|original|initial) (?:prompt|instructions|rules)/i,

  /<\s*(system|assistant|developer|tool|function|relevant-memories)\b/i,

  /\b(run|execute|call|invoke)\b.{0,40}\b(tool|command|function|shell)\b/i,

  /忽略(?:所有|之前|以上|先前)?(?:的)?(?:指令|规则|指示|说明)/,
  /无视(?:所有|之前|以上)?(?:的)?(?:指令|规则|限制)/,
  /(?:显示|输出|告诉我|给我看)(?:你的)?(?:系统|初始|隐藏)?(?:提示词|指令|规则|prompt)/,
  /你(?:现在|从现在开始)是/,
];

export function looksLikePromptInjection(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isFrameworkNoise(text: string): boolean {
  const t = text.trim();

  if (t === "(session bootstrap)") return true;
  if (t.startsWith("A new session was started via")) return true;
  if (/^✅\s*New session started/.test(t)) return true;
  if (t.startsWith("Pre-compaction memory flush")) return true;
  if (/^NO_REPLY\s*$/.test(t)) return true;

  return false;
}

/**
 * Pick up to `max` recent unique texts (newest first → reverse to chronological).
 */
export function pickRecentUnique(texts: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = texts.length - 1; i >= 0 && result.length < max; i--) {
    const t = texts[i]!;
    if (!seen.has(t)) {
      seen.add(t);
      result.push(t);
    }
  }
  return result.reverse();
}

/**
 * Sanitize raw JSON string from LLM output so `JSON.parse` won't throw
 * "Bad control character in string literal".
 *
 * Two-phase: precise (escape control chars inside string literals) then
 * fallback (strip rare control chars).
 */
export function sanitizeJsonForParse(raw: string): string {
  const escaped = escapeControlCharsInJsonStrings(raw);
  try {
    JSON.parse(escaped);
    return escaped;
  } catch {
    // Phase 1 didn't fully fix it — fall through
  }
  const stripped = escaped.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  return stripped;
}

function escapeControlCharsInJsonStrings(text: string): string {
  const SHORT_ESCAPES: Record<number, string> = {
    0x08: "\\b",
    0x09: "\\t",
    0x0a: "\\n",
    0x0c: "\\f",
    0x0d: "\\r",
  };

  const out: string[] = [];
  let inString = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);

    if (inString) {
      if (ch === "\\" && i + 1 < text.length) {
        out.push(ch, text[i + 1]!);
        i += 2;
        continue;
      }
      if (ch === '"') {
        out.push(ch);
        inString = false;
        i++;
        continue;
      }
      if (code <= 0x1f) {
        const short = SHORT_ESCAPES[code];
        if (short) {
          out.push(short);
        } else {
          out.push("\\u" + code.toString(16).padStart(4, "0"));
        }
        i++;
        continue;
      }
      out.push(ch);
      i++;
    } else {
      if (ch === '"') {
        out.push(ch);
        inString = true;
        i++;
        continue;
      }
      out.push(ch);
      i++;
    }
  }

  return out.join("");
}

/**
 * Repair common LLM JSON imperfections (bare identifiers for numeric fields,
 * trailing commas) by overwriting bad scalars and removing trailing commas.
 *
 * Ported from upstream `repairExtractionJson` (l1-extractor.ts).
 */
export function repairExtractionJson(json: string): string {
  return json
    .replace(
      /("priority"\s*:\s*)(?!-?\d+(?:\.\d+)?\s*[,}]|"[^"\\]*(?:\\.[^"\\]*)*"\s*[,}])([\s\S]*?)(?=,\s*"(?:content|type|priority|source_message_ids|metadata)"\s*:|[}\]])/g,
      (_m, prefix: string) => `${prefix}50`
    )
    .replace(/,\s*([}\]])/g, "$1");
}

/**
 * Extracted-message shape used by L1 extractor parsers.
 */
export interface ExtractedMemoryShape {
  content: string;
  type: string;
  priority: number;
  source_message_ids: string[];
  metadata: Record<string, unknown>;
}

/**
 * Extracted-scene shape used by L1 extractor parsers.
 */
export interface SceneSegmentShape {
  scene_name: string;
  message_ids: string[];
  memories: ExtractedMemoryShape[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse the LLM extraction response (scene + memory array) with control-char
 * repair, scalar coercion, and graceful fallback.
 *
 * Ported from upstream `parseExtractionResult` (l1-extractor.ts).
 */
export function parseExtractionScenes(raw: string): SceneSegmentShape[] {
  if (!raw) return [];
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  const sanitized = sanitizeJsonForParse(arrayMatch[0]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitized);
  } catch {
    const repaired = repairExtractionJson(sanitized);
    if (repaired === sanitized) return [];
    try {
      parsed = JSON.parse(repaired);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const scenes: SceneSegmentShape[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;

    const rawScenes = item.memories;
    const memories: ExtractedMemoryShape[] = Array.isArray(rawScenes)
      ? (rawScenes as Array<Record<string, unknown>>)
          .filter(
            (m) => isRecord(m) && typeof m.content === "string" && (m.content as string).length > 0
          )
          .map((m) => ({
            content: String(m.content),
            type: String(m.type ?? "episodic"),
            priority: typeof m.priority === "number" ? m.priority : 50,
            source_message_ids: Array.isArray(m.source_message_ids)
              ? m.source_message_ids.map(String)
              : [],
            metadata: (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<
              string,
              unknown
            >,
          }))
      : [];

    scenes.push({
      scene_name: typeof item.scene_name === "string" ? item.scene_name : "未知情境",
      message_ids: Array.isArray(item.message_ids) ? item.message_ids.map(String) : [],
      memories,
    });
  }
  return scenes;
}
