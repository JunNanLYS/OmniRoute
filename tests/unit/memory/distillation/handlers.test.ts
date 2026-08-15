import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HANDLERS, clampPrompt } from "../../../../src/memory/distillation/handlers.ts";
import type { DistillationTask } from "../../../../src/memory/distillation/store.ts";

function makeTask(over: Partial<DistillationTask>): DistillationTask {
  return {
    id: "t1",
    kind: "L1_extract",
    scope: "scope-A",
    payload: {},
    priority: 0,
    attempt: 0,
    notBefore: 0,
    status: "queued",
    providerHint: null,
    modelHint: null,
    lastError: null,
    version: 1,
    ...over,
  };
}

describe("distillation/handlers — clampPrompt", () => {
  it("returns the original under the cap", () => {
    assert.equal(clampPrompt("hi", 10), "hi");
  });
  it("truncates over-cap strings", () => {
    const out = clampPrompt("a".repeat(20), 5);
    assert.equal(out.length, 5);
  });
});

describe("distillation/handlers — L1_extract", () => {
  it("parses JSON output and exposes fallback evidence", async () => {
    const handler = DEFAULT_HANDLERS.L1_extract;
    let captured: { messages: unknown } | null = null;
    const out = await handler({
      task: makeTask({
        payload: { conversation: "I prefer dark mode and I always drink coffee." },
      }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 1024, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async (args) => {
        captured = args;
        return {
          text: JSON.stringify([
            {
              scene_name: "preferences",
              message_ids: ["l0-user"],
              memories: [
                {
                  content: "Prefers dark mode",
                  type: "persona",
                  priority: 80,
                  source_message_ids: ["l0-user"],
                  metadata: { key: "theme" },
                },
              ],
            },
          ]),
          promptTokens: 10,
          completionTokens: 5,
        };
      },
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      const scenes = (out.result.payload as { scenes: unknown[] }).scenes;
      assert.ok(Array.isArray(scenes));
      assert.ok(out.result.fallbackEvidence.length >= 1);
    }
    assert.ok(captured);
  });

  it("normalizes Tencent scene arrays into the seven canonical L1 types", async () => {
    const handler = DEFAULT_HANDLERS.L1_extract;
    const out = await handler({
      task: makeTask({ payload: { conversation: "typed memories" } }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 1024, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async () => ({
        text: JSON.stringify([
          {
            scene_name: "project-a",
            message_ids: ["l0-1", "l0-2"],
            memories: [
              {
                content: "Prefers dark mode",
                type: "preference",
                priority: 80,
                source_message_ids: ["l0-1"],
                metadata: { key: "theme" },
              },
              { content: "Completed migration", type: "episode", source_message_ids: ["l0-2"] },
              { content: "Use pnpm", type: "instruct", priority: "invalid" },
              { content: "API uses REST", type: "work_fact", priority: 60 },
              { content: "Ship release", type: "work_task", priority: 70 },
              { content: "Run tests first", type: "work_method", priority: 90 },
              { content: "ADR-12", type: "work_artifact", priority: 55 },
              { content: "drop me", type: "unknown" },
              { type: "persona" },
            ],
          },
          {
            memories: [{ content: "Fallback scene", type: "persona" }],
          },
        ]),
        promptTokens: 12,
        completionTokens: 8,
      }),
    });

    assert.equal(out.ok, true);
    if (!out.ok) return;
    const payload = out.result.payload as {
      scenes: Array<{
        sceneName: string;
        messageIds: string[];
        memories: Array<{
          content: string;
          type: string;
          priority: number;
          sourceMessageIds: string[];
          metadata: Record<string, unknown>;
        }>;
      }>;
    };
    assert.deepEqual(
      payload.scenes[0]?.memories.map((memory) => memory.type),
      [
        "persona",
        "episodic",
        "instruction",
        "work_fact",
        "work_task",
        "work_method",
        "work_artifact",
      ]
    );
    assert.equal(payload.scenes[0]?.sceneName, "project-a");
    assert.deepEqual(payload.scenes[0]?.messageIds, ["l0-1", "l0-2"]);
    assert.equal(payload.scenes[0]?.memories[2]?.priority, 50);
    assert.deepEqual(payload.scenes[0]?.memories[0]?.sourceMessageIds, ["l0-1"]);
    assert.equal(payload.scenes[1]?.sceneName, "未知情境");
  });

  it("returns semantic_invalid when JSON contains no valid L1 memories", async () => {
    const handler = DEFAULT_HANDLERS.L1_extract;
    const out = await handler({
      task: makeTask({ payload: { conversation: "anything" } }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 1024, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async () => ({
        text: JSON.stringify([{ scene_name: "empty", memories: [{ type: "unknown" }] }]),
        promptTokens: 1,
        completionTokens: 1,
      }),
    });
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error.kind, "semantic_invalid");
  });

  it("returns parse_failed on non-JSON", async () => {
    const handler = DEFAULT_HANDLERS.L1_extract;
    const out = await handler({
      task: makeTask({ payload: { conversation: "anything" } }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 1024, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async () => ({ text: "not json at all", promptTokens: 1, completionTokens: 1 }),
    });
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error.kind, "parse_failed");
  });
});

describe("distillation/handlers — L2_scene", () => {
  it("normalizes the canonical scene result", async () => {
    const handler = DEFAULT_HANDLERS.L2_scene;
    const out = await handler({
      task: makeTask({
        kind: "L2_scene",
        payload: {
          sceneName: "project-a",
          conversation: "long convo",
          existingScene: "old scene",
        },
      }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 1024, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async () => ({
        text: JSON.stringify({
          summary: "We talked about dark mode.",
          tags: ["ui", "prefs"],
          content: "Reusable scene narrative",
          heat: 0.8,
          persona_update_requested: true,
        }),
        promptTokens: 10,
        completionTokens: 5,
      }),
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.deepEqual(out.result.payload, {
        summary: "We talked about dark mode.",
        tags: ["ui", "prefs"],
        content: "Reusable scene narrative",
        heat: 0.8,
        personaUpdateRequested: true,
      });
    }
  });

  it("rejects out-of-range heat instead of persisting model garbage", async () => {
    const handler = DEFAULT_HANDLERS.L2_scene;
    const out = await handler({
      task: makeTask({ kind: "L2_scene", payload: { conversation: "long convo" } }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 1024, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async () => ({
        text: JSON.stringify({ summary: "summary", tags: [], heat: 10 }),
        promptTokens: 1,
        completionTokens: 1,
      }),
    });
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error.kind, "semantic_invalid");
  });
});

describe("distillation/handlers — L3_persona", () => {
  it("normalizes string persona output into canonical content and prompt mode", async () => {
    const handler = DEFAULT_HANDLERS.L3_persona;
    const out = await handler({
      task: makeTask({
        kind: "L3_persona",
        payload: { samples: ["scene"], promptMode: "code" },
      }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 1024, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async () => ({
        text: JSON.stringify({ persona: "# Team Operating Doctrine\nRun tests first." }),
        promptTokens: 2,
        completionTokens: 3,
      }),
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.deepEqual(out.result.payload, {
        content: "# Team Operating Doctrine\nRun tests first.",
        promptMode: "code",
      });
    }
  });

  it("returns model_unset when no samples provided", async () => {
    const handler = DEFAULT_HANDLERS.L3_persona;
    const out = await handler({
      task: makeTask({ kind: "L3_persona", payload: { samples: [] } }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 1024, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async () => ({ text: "", promptTokens: 0, completionTokens: 0 }),
    });
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error.kind, "model_unset");
  });
});

describe("distillation/handlers — L0_chunk_embed", () => {
  it("parses a short summary", async () => {
    const handler = DEFAULT_HANDLERS.L0_chunk_embed;
    const out = await handler({
      task: makeTask({ kind: "L0_chunk_embed", payload: { chunk: "Some long chunk" } }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 1024, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async () => ({
        text: JSON.stringify({ summary: "tiny" }),
        promptTokens: 1,
        completionTokens: 1,
      }),
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      const payload = out.result.payload as { summary: string };
      assert.equal(payload.summary, "tiny");
    }
  });
});

it("does not use an unresolved variable dynamic import for Tencent prompts", () => {
  const source = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../src/memory/distillation/handlers.ts"
    ),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /import\(`\.\/prompts\/tencent\/\$\{kind\}\.ts`/,
    "variable prompt imports are statically resolved by Turbopack and emit Module-not-found warnings"
  );
});

describe("distillation/handlers — reasoning-aware per-kind max_tokens", () => {
  // Reasoning models (e.g. deepseek-v4) spend the completion budget on
  // hidden reasoning before the visible JSON: a live run measured 1448
  // reasoning tokens for a six-message L1 extraction, so the old caps
  // (2048/1024/512) truncated the answer to empty content. The per-kind
  // caps no longer second-guess the model: they sit at 1,000,000 and the
  // operator budget (MEMORY_DISTILLATION_MAX_TOKENS, default 131072) is the
  // single effective knob. Provider ceilings still apply — DeepSeek accepts
  // max_tokens up to 393216 (probed live; 1,000,000 is rejected with 400).
  const reasoningReply = async () => ({
    text: JSON.stringify([
      {
        scene_name: "preferences",
        message_ids: [],
        memories: [
          { content: "Prefers dark mode", type: "persona", priority: 80, source_message_ids: [] },
        ],
      },
    ]),
    promptTokens: 10,
    completionTokens: 5,
  });

  it("every kind passes the operator budget through untouched", async () => {
    let requested = 0;
    await DEFAULT_HANDLERS.L1_extract({
      task: makeTask({ payload: { conversation: "user: hello" } }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 131072, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async (args) => {
        requested = args.maxTokens;
        return reasoningReply();
      },
    });
    assert.equal(requested, 131072);
  });

  it("L2_scene and L3_persona also request the full budget", async () => {
    let l2Requested = 0;
    await DEFAULT_HANDLERS.L2_scene({
      task: makeTask({ kind: "L2_scene", payload: { conversation: "work_fact: hello" } }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 131072, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async (args) => {
        l2Requested = args.maxTokens;
        return {
          text: JSON.stringify({ summary: "s", tags: ["t"], content: "c", heat: 0.5 }),
          promptTokens: 1,
          completionTokens: 1,
        };
      },
    });
    assert.equal(l2Requested, 131072);

    let l3Requested = 0;
    await DEFAULT_HANDLERS.L3_persona({
      task: makeTask({ kind: "L3_persona", payload: { samples: ["[scene]\nsum\ncontent"] } }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 131072, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async (args) => {
        l3Requested = args.maxTokens;
        return {
          text: JSON.stringify({ content: "c", prompt_mode: "chat" }),
          promptTokens: 1,
          completionTokens: 1,
        };
      },
    });
    assert.equal(l3Requested, 131072);
  });

  it("still respects a smaller operator budget", async () => {
    let requested = 0;
    await DEFAULT_HANDLERS.L1_extract({
      task: makeTask({ payload: { conversation: "user: hello" } }),
      selection: { provider: "p", model: "m" },
      budget: { maxTokens: 1024, maxSteps: 8, maxCalls: 12, maxDepth: 6 },
      callModel: async (args) => {
        requested = args.maxTokens;
        return reasoningReply();
      },
    });
    assert.equal(requested, 1024);
  });
});
