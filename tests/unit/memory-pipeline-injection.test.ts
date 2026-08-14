/**
 * Hard cutover tests for the memorySkillsInjection orchestration.
 *
 * Covers:
 *   - With injectionEnabled=false: body is returned unchanged, no recall fetch.
 *   - With injectionEnabled=true: recall is fetched and rendered.
 *   - Skills branch is unchanged (when skillsEnabled=true).
 *   - No-memory header (owner null) -> memorySettings=null, no body mutation.
 *   - Legacy `memoryEnabled` is the only path that defaults to true (migrated,
 *     via the env adapter). The migration is documented but never silent.
 *   - The migration-friendly resolver is honored.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  setMemoryPipelineSettingsResolver,
  resetMemoryPipelineSettingsResolverForTests,
  DEFAULT_MEMORY_PIPELINE_SETTINGS,
} from "../../src/memory/integration/settings.ts";
import { setRecallProvider, resetRecallProviderForTests } from "../../src/memory/recall/facade.ts";
import {
  injectMemoryAndSkills,
  getSkillsProviderForFormat,
  buildMemorySettingsForPipeline,
} from "../../open-sse/handlers/chatCore/memorySkillsInjection.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

describe("getSkillsProviderForFormat — unchanged", () => {
  it("CLAUDE -> anthropic", () => {
    assert.equal(getSkillsProviderForFormat(FORMATS.CLAUDE), "anthropic");
  });
  it("GEMINI -> google", () => {
    assert.equal(getSkillsProviderForFormat(FORMATS.GEMINI), "google");
  });
  it("OPENAI + unknown -> openai", () => {
    assert.equal(getSkillsProviderForFormat(FORMATS.OPENAI), "openai");
    assert.equal(getSkillsProviderForFormat("z"), "openai");
  });
});

describe("buildMemorySettingsForPipeline", () => {
  it("maps pipelineSettings -> memorySettings shape for callers", () => {
    const m = buildMemorySettingsForPipeline(
      { ...DEFAULT_MEMORY_PIPELINE_SETTINGS, captureEnabled: true, injectionEnabled: true },
      true
    );
    assert.equal(m.enabled, true);
    assert.equal(m.captureEnabled, true);
    assert.equal(m.injectionEnabled, true);
    assert.equal(m.skillsEnabled, true);
  });

  it("skillsEnabled=false keeps skills branch off", () => {
    const m = buildMemorySettingsForPipeline(
      { ...DEFAULT_MEMORY_PIPELINE_SETTINGS, injectionEnabled: true },
      false
    );
    assert.equal(m.skillsEnabled, false);
    assert.equal(m.injectionEnabled, true);
  });
});

describe("injectMemoryAndSkills — owner null short-circuit", () => {
  it("with memoryOwnerId=null returns memorySettings=null and body unchanged", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
    const out = await injectMemoryAndSkills({
      body,
      memoryOwnerId: null,
      provider: "openai",
      effectiveModel: "gpt-4o",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      backgroundReason: null,
      log: null,
    });
    assert.equal(out.memorySettings, null);
    assert.equal(out.body, body);
  });
});

describe("injectMemoryAndSkills — injectionEnabled=false no-op", () => {
  before(() => {
    setMemoryPipelineSettingsResolver(() => ({
      ...DEFAULT_MEMORY_PIPELINE_SETTINGS,
      captureEnabled: false,
      injectionEnabled: false,
    }));
    resetRecallProviderForTests();
  });
  after(() => {
    resetMemoryPipelineSettingsResolverForTests();
  });

  it("does not mutate the body when injectionEnabled is false", async () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    };
    const out = await injectMemoryAndSkills({
      body,
      memoryOwnerId: "k1",
      provider: "openai",
      effectiveModel: "gpt-4o",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      backgroundReason: null,
      log: null,
    });
    assert.equal(out.body, body);
    assert.equal(out.memorySettings?.injectionEnabled, false);
  });
});

describe("injectMemoryAndSkills — injectionEnabled=true renders layers", () => {
  before(() => {
    setMemoryPipelineSettingsResolver(() => ({
      ...DEFAULT_MEMORY_PIPELINE_SETTINGS,
      captureEnabled: true,
      injectionEnabled: true,
    }));
    setRecallProvider({
      fetchL3: async () => [{ id: "L3-1", title: "Project", content: "Postgres" }],
      fetchL2: async () => [{ id: "L2-1", title: "Overview", summary: "How to use OmniRoute" }],
      fetchL1: async () => [
        { id: "m1", content: "user mentioned dark mode", score: 0.9, tags: [] },
      ],
    });
  });
  after(() => {
    resetMemoryPipelineSettingsResolverForTests();
    resetRecallProviderForTests();
  });

  it("renders L3+L2+guide into leading system and L1 into user prefix", async () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are OmniRoute" },
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
    };
    const out = await injectMemoryAndSkills({
      body,
      memoryOwnerId: "k1",
      provider: "openai",
      effectiveModel: "gpt-4o",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      backgroundReason: null,
      log: null,
    });
    const messages = out.body.messages as Record<string, unknown>[];
    const sys = messages[0];
    assert.equal(sys.role, "system");
    assert.ok((sys.content as string).includes("L3 stable context"));
    assert.ok((sys.content as string).includes("L2 navigation index"));
    assert.ok((sys.content as string).includes("MEMORY TOOLS GUIDE"));
    // L1 placed before the last user message.
    const l1Idx = messages.findIndex(
      (m) => typeof m.content === "string" && (m.content as string).includes("<relevant-memories>")
    );
    const lastUserIdx = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return i;
      }
      return -1;
    })();
    assert.ok(l1Idx >= 0);
    assert.ok(l1Idx < lastUserIdx);
    assert.equal(out.renderResult?.l1Placement, "pre-last-user");
    assert.equal(out.renderResult?.injectedL1Count, 1);
    assert.equal(out.renderResult?.injectedL2Count, 1);
    assert.equal(out.renderResult?.injectedL3Count, 1);
  });
});

describe("injectMemoryAndSkills — explicit four-layer settings", () => {
  before(() => {
    setMemoryPipelineSettingsResolver(() => ({
      ...DEFAULT_MEMORY_PIPELINE_SETTINGS,
      captureEnabled: true,
      injectionEnabled: true,
    }));
    setRecallProvider({
      fetchL3: async () => [],
      fetchL2: async () => [],
      fetchL1: async () => [],
    });
  });
  after(() => {
    resetMemoryPipelineSettingsResolverForTests();
    resetRecallProviderForTests();
  });

  it("surfaces explicit capture and injection flags without migration metadata", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
    const out = await injectMemoryAndSkills({
      body,
      memoryOwnerId: "k1",
      provider: "openai",
      effectiveModel: "gpt-4o",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      backgroundReason: null,
      log: null,
    });
    assert.equal("migratedFromLegacy" in (out.memorySettings ?? {}), false);
    assert.equal(out.memorySettings?.captureEnabled, true);
    assert.equal(out.memorySettings?.injectionEnabled, true);
  });
});

describe("injectMemoryAndSkills — recall fetch failure is swallowed", () => {
  before(() => {
    setMemoryPipelineSettingsResolver(() => ({
      ...DEFAULT_MEMORY_PIPELINE_SETTINGS,
      captureEnabled: true,
      injectionEnabled: true,
    }));
    setRecallProvider({
      fetchL3: async () => {
        throw new Error("boom");
      },
      fetchL2: async () => [],
      fetchL1: async () => [],
    });
  });
  after(() => {
    resetMemoryPipelineSettingsResolverForTests();
    resetRecallProviderForTests();
  });

  it("does not throw when recall layer errors", async () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    };
    let didThrow = false;
    let out;
    try {
      out = await injectMemoryAndSkills({
        body,
        memoryOwnerId: "k1",
        provider: "openai",
        effectiveModel: "gpt-4o",
        sourceFormat: FORMATS.OPENAI,
        targetFormat: FORMATS.OPENAI,
        backgroundReason: null,
        log: null,
      });
    } catch {
      didThrow = true;
    }
    assert.equal(didThrow, false);
    // Render still completed (with empty L3; L1/L2 still fetched).
    assert.ok(out);
  });
});
