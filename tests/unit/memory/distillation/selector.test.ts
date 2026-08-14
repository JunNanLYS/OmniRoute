import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDistillationSelection,
  validateModelStillUsable,
} from "../../../../src/memory/distillation/selector.ts";
import type {
  DistillationTask,
  SelectorDeps,
} from "../../../../src/memory/distillation/selector.ts";

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

function makeDeps(over: Partial<SelectorDeps> = {}): SelectorDeps {
  return {
    resolvePerKeySettings: async () => ({ provider: null, model: null }),
    resolveGlobalSettings: async () => ({ provider: null, model: null }),
    loadCatalogSnapshot: async () => ({
      providers: new Map<string, readonly string[]>(),
      isModelUsable: () => true,
    }),
    env: {} as NodeJS.ProcessEnv,
    ...over,
  };
}

describe("distillation/selector — 4-tier chain", () => {
  it("honours task hint first (no silent switch)", async () => {
    const task = makeTask({ providerHint: "openai", modelHint: "gpt-4o" });
    const deps = makeDeps({
      resolvePerKeySettings: async () => ({ provider: "anthropic", model: "claude" }),
      resolveGlobalSettings: async () => ({ provider: "google", model: "gemini" }),
      env: { MEMORY_DISTILLATION_MODEL: "meta/llama" } as NodeJS.ProcessEnv,
    });
    const sel = await resolveDistillationSelection(task, deps);
    assert.deepEqual(sel, { provider: "openai", model: "gpt-4o", source: "task_hint" });
  });

  it("falls through to per-key when task hint is null", async () => {
    const task = makeTask({});
    const deps = makeDeps({
      resolvePerKeySettings: async () => ({ provider: "anthropic", model: "claude-3-5-sonnet" }),
    });
    const sel = await resolveDistillationSelection(task, deps);
    assert.deepEqual(sel, {
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      source: "per_key",
    });
  });

  it("falls through to global when per-key is empty", async () => {
    const task = makeTask({});
    const deps = makeDeps({
      resolveGlobalSettings: async () => ({ provider: "google", model: "gemini-1.5" }),
    });
    const sel = await resolveDistillationSelection(task, deps);
    assert.deepEqual(sel, { provider: "google", model: "gemini-1.5", source: "global" });
  });

  it("falls through to env when global is empty", async () => {
    const task = makeTask({});
    const deps = makeDeps({
      env: { MEMORY_DISTILLATION_MODEL: "openai/gpt-4o-mini" } as NodeJS.ProcessEnv,
    });
    const sel = await resolveDistillationSelection(task, deps);
    assert.deepEqual(sel, { provider: "openai", model: "gpt-4o-mini", source: "env" });
  });

  it("falls through to first-active provider × first synced model", async () => {
    const task = makeTask({});
    const deps = makeDeps({
      loadCatalogSnapshot: async () => ({
        providers: new Map<string, readonly string[]>([
          ["openai", ["gpt-4o", "gpt-4o-mini"]],
          ["anthropic", ["claude-3-5-sonnet"]],
        ]),
        isModelUsable: () => true,
      }),
    });
    const sel = await resolveDistillationSelection(task, deps);
    // Map iteration order is insertion order — "openai" wins.
    assert.deepEqual(sel, { provider: "openai", model: "gpt-4o", source: "first_active" });
  });

  it("returns null (model_unset) when every source is empty", async () => {
    const task = makeTask({});
    const sel = await resolveDistillationSelection(task, makeDeps());
    assert.equal(sel, null);
  });
});

describe("distillation/selector — validateModelStillUsable", () => {
  it("returns model_deleted when not in catalog", () => {
    const catalog = {
      providers: new Map<string, readonly string[]>([["openai", ["gpt-4o"]]]),
      isModelUsable: () => true,
    };
    const v = validateModelStillUsable(
      { provider: "openai", model: "gpt-3.5", source: "first_active" },
      catalog
    );
    assert.equal(v.ok, false);
    assert.equal(v.reason, "model_deleted");
  });

  it("returns model_unset when provider is missing", () => {
    const catalog = {
      providers: new Map<string, readonly string[]>(),
      isModelUsable: () => true,
    };
    const v = validateModelStillUsable(
      { provider: "ghost", model: "m", source: "first_active" },
      catalog
    );
    assert.equal(v.ok, false);
    assert.equal(v.reason, "model_unset");
  });

  it("returns model_deleted when isModelUsable is false", () => {
    const catalog = {
      providers: new Map<string, readonly string[]>([["openai", ["gpt-4o"]]]),
      isModelUsable: () => false,
    };
    const v = validateModelStillUsable(
      { provider: "openai", model: "gpt-4o", source: "first_active" },
      catalog
    );
    assert.equal(v.ok, false);
    assert.equal(v.reason, "model_deleted");
  });
});
