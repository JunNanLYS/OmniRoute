/**
 * Memory + Skills injection orchestrator.
 *
 * Hard cutover (this revision):
 *   - Removes legacy `retrieveMemories` / `injectMemory` / `shouldInjectMemory`
 *     imports and calls. The new 4-layer recall facade
 *     (`src/memory/recall/facade.ts`) and injection transformer
 *     (`src/memory/integration/injectionTransformer.ts`) take their place.
 *   - Per-owner `captureEnabled` / `injectionEnabled` resolve from
 *     `resolveMemoryPipelineSettings(ownerId)` and default to false.
 *   - Skills remain independent and delegate to `injectSkills`.
 *
 * The function returns the body + a `memorySettings` shape that callers
 * (chatCore.ts) use to decide whether to schedule L0 capture at the
 * finalization sites.
 */

import { injectSkills } from "@/lib/skills/injection";
import { getSettings } from "@/lib/db/settings";
import { FORMATS } from "../../translator/formats.ts";
import { detectCachingContext } from "../../services/compression/cachingAware.ts";
import {
  resolveMemoryPipelineSettings,
  DEFAULT_MEMORY_PIPELINE_SETTINGS,
  type MemoryPipelineSettings,
} from "@/memory/integration/settings.ts";
import { recallLayeredContext, type RecallOutput } from "@/memory/recall/facade.ts";
import {
  renderLayeredInjection,
  resolveTotalBudget,
  type RenderResult,
} from "@/memory/integration/injectionTransformer.ts";

type MemorySkillsLogger = { debug?: (...args: unknown[]) => void } | null | undefined;

export interface MemorySettingsForPipeline {
  /** Legacy `memoryEnabled` for callers that still key on it. */
  enabled: boolean;
  /** True when the new capture path is enabled. */
  captureEnabled: boolean;
  /** True when the new 4-layer recall/injection path is enabled. */
  injectionEnabled: boolean;
  /** Token budget for the maxTokens compatibility check. */
  maxTokens: number;
  /** Skills branch — unchanged. */
  skillsEnabled: boolean;
  /** Full pipeline settings for downstream pipeline integration. */
  pipeline: MemoryPipelineSettings;
}

export function getSkillsProviderForFormat(
  format: string
): "openai" | "anthropic" | "google" | "other" {
  switch (format) {
    case FORMATS.CLAUDE:
      return "anthropic";
    case FORMATS.GEMINI:
      return "google";
    default:
      return "openai";
  }
}

export interface InjectMemoryAndSkillsArgs {
  body: Record<string, unknown>;
  memoryOwnerId: string | null;
  provider: string;
  effectiveModel: string;
  sourceFormat: string;
  targetFormat: string;
  backgroundReason: string | null;
  log: MemorySkillsLogger;
}

export interface InjectMemoryAndSkillsResult {
  body: Record<string, unknown>;
  memorySettings: MemorySettingsForPipeline | null;
  /** Optional — the new layer render result, surfaced when injection ran. */
  renderResult?: RenderResult;
  /** Optional — the structured recall output (L1/L2/L3+status). */
  recall?: RecallOutput;
}

/**
 * Build the legacy-shape `memorySettings` object that callers key on. The
 * legacy `enabled` follows the new `injectionEnabled` flag. Skills is
 * independently controlled by the legacy `skillsEnabled` setting.
 */
export function buildMemorySettingsForPipeline(
  pipeline: MemoryPipelineSettings,
  legacySkillsEnabled: boolean
): MemorySettingsForPipeline {
  return {
    enabled: pipeline.injectionEnabled,
    captureEnabled: pipeline.captureEnabled,
    injectionEnabled: pipeline.injectionEnabled,
    maxTokens: pipeline.l1CharBudget,
    skillsEnabled: legacySkillsEnabled,
    pipeline,
  };
}

/**
 * Extract the last user-visible text from the body for the L1 dynamic query.
 * Pure helper — no IO, no DB.
 */
export function extractLastUserQuery(body: Record<string, unknown>): string {
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const item = body.messages[i] as Record<string, unknown> | undefined;
      if (!item) continue;
      if (item.role !== "user") continue;
      const content = item.content;
      if (typeof content === "string" && content.trim()) return content;
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const p of content) {
          if (typeof p === "string") parts.push(p);
          else if (p && typeof p === "object") {
            const t = (p as Record<string, unknown>).text;
            if (typeof t === "string") parts.push(t);
          }
        }
        if (parts.length > 0) return parts.join("\n");
      }
    }
  }
  if (Array.isArray(body.input)) {
    for (let i = body.input.length - 1; i >= 0; i--) {
      const item = body.input[i] as Record<string, unknown> | undefined;
      if (!item) continue;
      const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
      if (role && role !== "user") continue;
      const content = item.content;
      if (typeof content === "string" && content.trim()) return content;
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const p of content) {
          if (typeof p === "string") parts.push(p);
          else if (p && typeof p === "object") {
            const t = (p as Record<string, unknown>).text;
            if (typeof t === "string") parts.push(t);
          }
        }
        if (parts.length > 0) return parts.join("\n");
      }
    }
  }
  return "";
}

async function resolveSkillsEnabled(): Promise<boolean> {
  try {
    const settings = await getSettings();
    return settings.skillsEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * Hard cutover entry point. The function NEVER throws on memory failure —
 * failures are swallowed and the body is returned unchanged.
 */
export async function injectMemoryAndSkills({
  body,
  memoryOwnerId,
  provider,
  effectiveModel,
  sourceFormat,
  targetFormat,
  backgroundReason,
  log,
}: InjectMemoryAndSkillsArgs): Promise<InjectMemoryAndSkillsResult> {
  // Resolve pipeline settings per API key (default OFF).
  const pipelineSettings = memoryOwnerId
    ? await resolveMemoryPipelineSettings(memoryOwnerId).catch(
        () => DEFAULT_MEMORY_PIPELINE_SETTINGS
      )
    : DEFAULT_MEMORY_PIPELINE_SETTINGS;

  const skillsEnabled = await resolveSkillsEnabled();
  const memorySettings = buildMemorySettingsForPipeline(pipelineSettings, skillsEnabled);

  if (!memoryOwnerId) {
    return { body, memorySettings: null };
  }

  // ── New 4-layer recall + injection ──────────────────────────────────────
  let renderResult: RenderResult | undefined;
  let recall: RecallOutput | undefined;

  if (pipelineSettings.injectionEnabled) {
    try {
      const query = extractLastUserQuery(body);
      recall = await recallLayeredContext(
        {
          ownerId: memoryOwnerId,
          sessionId: "shared",
          query,
        },
        { timeoutMs: pipelineSettings.recallTimeoutMs }
      );

      const cacheCtx = detectCachingContext(body, { provider, targetFormat });
      const totalBudget = resolveTotalBudget(
        typeof (body as Record<string, unknown>).max_tokens === "number"
          ? ((body as Record<string, unknown>).max_tokens as number)
          : undefined,
        pipelineSettings.totalCharBudget
      );

      const result = renderLayeredInjection(
        body,
        {
          l3: recall.layers.l3,
          l2: recall.layers.l2,
          l1: recall.layers.l1,
          toolsGuide: recall.layers.toolsGuide,
        },
        {
          l3CharBudget: pipelineSettings.l3CharBudget,
          l2CharBudget: pipelineSettings.l2CharBudget,
          l1CharBudget: pipelineSettings.l1CharBudget,
          totalCharBudget: totalBudget,
        },
        {
          provider,
          sourceFormat,
          targetFormat,
          hasCacheControl: cacheCtx.hasCacheControl,
          isCachingProvider: cacheCtx.isCachingProvider,
          maxTokens: (body as Record<string, unknown>).max_tokens as number | undefined,
        }
      );
      body = result.body;
      renderResult = result;
      log?.debug?.(
        "MEMORY",
        `Injected L3=${result.injectedL3Count} L2=${result.injectedL2Count} L1=${result.injectedL1Count} ` +
          `placement=${result.systemPlacement}/${result.l1Placement} key=${memoryOwnerId}`
      );
    } catch (memErr) {
      log?.debug?.(
        "MEMORY",
        `Memory injection skipped: ${memErr instanceof Error ? memErr.message : String(memErr)}`
      );
    }
  }

  // ── Skills branch — unchanged ────────────────────────────────────────────
  if (memoryOwnerId && skillsEnabled) {
    const existingTools = Array.isArray(body.tools) ? body.tools : [];
    const mergedTools = injectSkills({
      provider: getSkillsProviderForFormat(sourceFormat),
      existingTools,
      apiKeyId: memoryOwnerId,
      model: typeof effectiveModel === "string" ? effectiveModel : undefined,
      sourceFormat,
      targetFormat,
      backgroundReason,
      messages: Array.isArray(body.messages)
        ? body.messages
        : Array.isArray(body.input)
          ? body.input
          : undefined,
    });

    if (mergedTools.length > existingTools.length) {
      body = {
        ...body,
        tools: mergedTools,
      };
      log?.debug?.("SKILLS", `Injected ${mergedTools.length - existingTools.length} skills`);
    }
  }

  return { body, memorySettings, renderResult, recall };
}
