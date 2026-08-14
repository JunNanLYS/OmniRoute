/**
 * Render 4-layer recall into the prompt.
 *
 *   L3 (stable system suffix) + L2 (nav) + static tools guide -> leading
 *       system message placed AFTER the caller's existing system
 *       instructions (merge into existing index-0 system when present,
 *       else prepend). This is the cacheable prefix.
 *
 *   L1 (dynamic top-5) -> `<relevant-memories>` reference-only user prefix
 *       inserted just before the last user message.
 *
 * Supports OpenAI / Anthropic / Gemini. For providers that reject a
 * non-first system message (systemMessageMustBeFirst), the L3+L2+guide are
 * prepended at index 0 as before. For providers without a system role
 * (GLM/Z.AI/Qianfan/o1), a single leading user reference is rendered.
 *
 * Cache safety: `provider|isCachingProvider` is treated as cache-safe; the
 * L1 dynamic content is placed in the per-query user prefix (always outside
 * the cacheable prefix) so the cacheable prefix stays byte-stable.
 *
 * Hard cutover rules:
 *   - L0 is NEVER auto-injected.
 *   - XML escape all controls inside the layer content; detect/drop
 *     prompt-injection payloads (content that LOOKS like instructions).
 *   - Budget caps per layer (default 600 chars) + total budget (default
 *     maxTokens*4 or 8000). Truncation suffix on overflow.
 */

import { createHash } from "node:crypto";
import { detector } from "./promptInjectionGuard.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Provider helpers (delegated to the existing legacy injection module)
// ──────────────────────────────────────────────────────────────────────────────

import {
  providerSupportsSystemMessage,
  systemMessageMustBeFirst,
} from "@/shared/utils/providerSystemMessages.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface LayerInjectionInput {
  /** Stable L3 system context. */
  l3: { id: string; title: string; content: string }[];
  /** Navigation index (≤15). */
  l2: { id: string; title: string; summary: string }[];
  /** L1 dynamic top-5. */
  l1: { id: string; content: string; score: number | null; tags: string[] }[];
  /** Static tools guide — always injected. */
  toolsGuide: string;
}

export interface InjectionBudgets {
  l3CharBudget: number;
  l2CharBudget: number;
  l1CharBudget: number;
  totalCharBudget: number;
}

export interface InjectionContext {
  provider: string;
  /** Source/target format — drives role naming for Gemini. */
  sourceFormat?: string;
  targetFormat?: string;
  /** Has the body explicitly set cache_control breakpoints? */
  hasCacheControl?: boolean;
  /** Is the provider known to use prompt caching? */
  isCachingProvider?: boolean;
  /** Estimated request tokens (used to default total budget). */
  maxTokens?: number;
}

export interface RenderResult {
  /** The new request body. */
  body: Record<string, unknown>;
  /** Diagnostic counts. */
  injectedL1Count: number;
  injectedL2Count: number;
  injectedL3Count: number;
  /** Where the system suffix was placed. */
  systemPlacement: "leading-merged" | "leading-prepended" | "fallback-user-leading";
  /** Where L1 was placed. */
  l1Placement: "pre-last-user" | "leading-user" | "skipped";
}

// ──────────────────────────────────────────────────────────────────────────────
// Budget helpers
// ──────────────────────────────────────────────────────────────────────────────

export const TRUNCATION_SUFFIX = "\n[...truncated]";

export function resolveTotalBudget(maxTokens: number | undefined, configured: number): number {
  if (typeof maxTokens === "number" && maxTokens > 0) return Math.max(0, maxTokens * 4);
  return configured;
}

export function truncate(text: string, budget: number): { text: string; truncated: boolean } {
  if (budget <= 0) return { text: "", truncated: text.length > 0 };
  if (text.length <= budget) return { text, truncated: false };
  return {
    text: text.slice(0, Math.max(0, budget - TRUNCATION_SUFFIX.length)) + TRUNCATION_SUFFIX,
    truncated: true,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// XML escape + prompt injection detect/drop
// ──────────────────────────────────────────────────────────────────────────────

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const PROMPT_INJECTION_PATTERNS = [
  /\bignore\s+(?:all\s+)?previous\s+instructions\b/i,
  /\bdisregard\s+(?:the\s+)?system\b/i,
  /\bsystem\s*:\s*you\s+are\s+now\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bjailbreak\b/i,
  /\bforget\s+(?:everything|all)\b/i,
];

export function looksLikePromptInjection(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return PROMPT_INJECTION_PATTERNS.some((p) => p.test(text));
}

// ──────────────────────────────────────────────────────────────────────────────
// Layer rendering
// ──────────────────────────────────────────────────────────────────────────────

export function renderL3System(l3: LayerInjectionInput["l3"], budget: number): string {
  if (l3.length === 0 || budget <= 0) return "";
  const parts = ["[L3 stable context]"];
  for (const item of l3) {
    if (looksLikePromptInjection(item.content)) continue;
    const title = escapeXml(item.title);
    const content = escapeXml(item.content);
    parts.push(`- ${title}: ${content}`);
  }
  return truncate(parts.join("\n"), budget).text;
}

export function renderL2Nav(l2: LayerInjectionInput["l2"], budget: number): string {
  if (l2.length === 0 || budget <= 0) return "";
  const parts = ["[L2 navigation index]"];
  for (const item of l2) {
    if (looksLikePromptInjection(item.title) || looksLikePromptInjection(item.summary)) continue;
    parts.push(`- ${escapeXml(item.title)}: ${escapeXml(item.summary)}`);
  }
  return truncate(parts.join("\n"), budget).text;
}

export function renderL1Memories(l1: LayerInjectionInput["l1"], budget: number): string {
  if (l1.length === 0 || budget <= 0) return "";
  const parts = ["<relevant-memories>"];
  for (const item of l1) {
    if (looksLikePromptInjection(item.content)) continue;
    parts.push(`<memory id="${escapeXml(item.id)}">${escapeXml(item.content)}</memory>`);
  }
  parts.push("</relevant-memories>");
  return truncate(parts.join("\n"), budget).text;
}

// ──────────────────────────────────────────────────────────────────────────────
// Detection of cache-safe context
// ──────────────────────────────────────────────────────────────────────────────

export function isCacheSafeContext(ctx: InjectionContext): boolean {
  // Treat either hasCacheControl OR isCachingProvider as cache-safe — fixes
  // the prior bug where only hasCacheControl was honored.
  return Boolean(ctx.hasCacheControl || ctx.isCachingProvider);
}

/**
 * Detect the message array on the body. OpenAI / Anthropic use `messages[]`;
 * Gemini uses `contents[]`; Responses API uses `input[]`.
 */
export function detectMessageArrayKey(
  body: Record<string, unknown>,
  targetFormat?: string
): string {
  if (targetFormat?.toLowerCase() === "gemini") return "contents";
  if (Array.isArray(body.messages)) return "messages";
  if (Array.isArray(body.input)) return "input";
  if (Array.isArray(body.contents)) return "contents";
  return "messages";
}

// ──────────────────────────────────────────────────────────────────────────────
// Top-level render
// ──────────────────────────────────────────────────────────────────────────────

export function renderLayeredInjection(
  body: Record<string, unknown>,
  layers: LayerInjectionInput,
  budgets: InjectionBudgets,
  ctx: InjectionContext
): RenderResult {
  // Step 1: detect provider-specific message/key
  const messageKey = detectMessageArrayKey(body, ctx.targetFormat);
  const messages = Array.isArray(body[messageKey])
    ? [...(body[messageKey] as unknown[] as Record<string, unknown>[])]
    : [];
  const provider = ctx.provider;

  // Step 2: resolve system role support
  const supportsSystem = providerSupportsSystemMessage(provider);
  const mustBeFirst = supportsSystem && systemMessageMustBeFirst(provider);
  const isCacheSafe = isCacheSafeContext(ctx);

  // Step 3: render system suffix (L3+L2+guide). Truncate under per-layer + total budget.
  const l3Text = renderL3System(layers.l3, budgets.l3CharBudget);
  const l2Text = renderL2Nav(layers.l2, budgets.l2CharBudget);
  const toolsGuide = layers.toolsGuide || "";

  let systemSuffix = [l3Text, l2Text, toolsGuide].filter((p) => p.length > 0).join("\n\n");
  if (systemSuffix.length > 0) {
    const totalBudget = budgets.totalCharBudget;
    const totalSoFar = systemSuffix.length;
    if (totalSoFar > totalBudget) {
      systemSuffix =
        systemSuffix.slice(0, Math.max(0, totalBudget - TRUNCATION_SUFFIX.length)) +
        TRUNCATION_SUFFIX;
    }
  }

  // Step 4: render L1 dynamic <relevant-memories>
  const l1Text = renderL1Memories(
    layers.l1,
    Math.min(budgets.l1CharBudget, budgets.totalCharBudget)
  );
  const hasL1 = l1Text.length > 0;

  // Step 5: render final body
  const newBody: Record<string, unknown> = { ...body };
  let placement: RenderResult["systemPlacement"] = "leading-prepended";
  let l1Placement: RenderResult["l1Placement"] = "skipped";
  let injectedL1Count = 0;
  let injectedL2Count = 0;
  let injectedL3Count = 0;

  // Pre-render safe counts for diagnostics (after filter)
  injectedL3Count = layers.l3.filter((x) => !looksLikePromptInjection(x.content)).length;
  injectedL2Count = layers.l2.filter(
    (x) => !looksLikePromptInjection(x.title) && !looksLikePromptInjection(x.summary)
  ).length;
  injectedL1Count = layers.l1.filter((x) => !looksLikePromptInjection(x.content)).length;

  if (!supportsSystem) {
    // Fallback: single leading user reference.
    const fallbackParts: string[] = [];
    if (systemSuffix.length > 0) fallbackParts.push(systemSuffix);
    if (hasL1) fallbackParts.push(l1Text);
    if (fallbackParts.length > 0) {
      const fallbackUser = { role: "user", content: fallbackParts.join("\n\n") };
      newBody[messageKey] = [fallbackUser, ...messages];
      placement = "fallback-user-leading";
      l1Placement = hasL1 ? "leading-user" : "skipped";
    }
  } else {
    // System path: merge into existing leading system OR prepend.
    const first = messages[0];
    if (first && first.role === "system") {
      const merged = {
        ...first,
        content: systemSuffix.length > 0 ? `${first.content}\n${systemSuffix}` : first.content,
      };
      newBody[messageKey] = [merged, ...messages.slice(1)];
      placement = "leading-merged";
    } else if (systemSuffix.length > 0) {
      const sysMsg = { role: "system", content: systemSuffix };
      newBody[messageKey] = [sysMsg, ...messages];
      placement = "leading-prepended";
    } else {
      // No system suffix to add.
      newBody[messageKey] = messages;
      placement = "leading-prepended";
    }

    // L1 placement: before last user message (cache-safe) or leading user.
    if (hasL1) {
      const l1UserMsg = { role: "user", content: l1Text };
      if (isCacheSafe && !mustBeFirst) {
        const lastUserIdx = findLastUserIndex(newBody[messageKey] as Record<string, unknown>[]);
        if (lastUserIdx >= 0) {
          const next = [...(newBody[messageKey] as unknown[] as Record<string, unknown>[])];
          next.splice(lastUserIdx, 0, l1UserMsg);
          newBody[messageKey] = next;
          l1Placement = "pre-last-user";
        } else {
          newBody[messageKey] = [
            l1UserMsg,
            ...(newBody[messageKey] as unknown[] as Record<string, unknown>[]),
          ];
          l1Placement = "leading-user";
        }
      } else {
        // Non-cache-safe or strict-first provider: place L1 as the leading user
        // message just before the existing first user turn.
        const firstUserIdx = findFirstUserIndex(newBody[messageKey] as Record<string, unknown>[]);
        if (firstUserIdx > 0) {
          const next = [...(newBody[messageKey] as unknown[] as Record<string, unknown>[])];
          next.splice(firstUserIdx, 0, l1UserMsg);
          newBody[messageKey] = next;
          l1Placement = "pre-last-user";
        } else if (firstUserIdx === 0) {
          newBody[messageKey] = [
            l1UserMsg,
            ...(newBody[messageKey] as unknown[] as Record<string, unknown>[]),
          ];
          l1Placement = "leading-user";
        } else {
          // No user message at all — append L1 as a trailing user reference.
          const arr = [...(newBody[messageKey] as unknown[] as Record<string, unknown>[])];
          arr.push(l1UserMsg);
          newBody[messageKey] = arr;
          l1Placement = "leading-user";
        }
      }
    }
  }

  void isCacheSafe; // referenced above via isCacheSafeContext
  void mustBeFirst;

  // Apply the optional prompt-injection detector if available (lightweight, no-op when null).
  try {
    if (typeof detector === "function") {
      // detector is optional. Allow it to drop suspicious records.
      const arr = newBody[messageKey] as unknown[];
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i++) {
          const m = arr[i] as Record<string, unknown>;
          if (typeof m?.content === "string" && looksLikePromptInjection(m.content)) {
            arr[i] = { ...m, content: "[redacted: prompt-injection-detected]" };
          }
        }
      }
    }
  } catch {
    /* detector is optional — never throw */
  }

  return {
    body: newBody,
    injectedL1Count,
    injectedL2Count,
    injectedL3Count,
    systemPlacement: placement,
    l1Placement,
  };
}

function findLastUserIndex(messages: Record<string, unknown>[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as Record<string, unknown>).role === "user") return i;
  }
  return -1;
}

function findFirstUserIndex(messages: Record<string, unknown>[]): number {
  for (let i = 0; i < messages.length; i++) {
    if ((messages[i] as Record<string, unknown>).role === "user") return i;
  }
  return -1;
}

// ──────────────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────────────

export function hashMessageShape(body: Record<string, unknown>): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(body));
  return h.digest("hex").slice(0, 16);
}

export function _resetInjectionStateForTests(): void {
  /* no module-level state — placeholder for future */
}
