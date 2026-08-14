/**
 * Unit tests for the new pipeline memory settings resolver + default adapter.
 *
 * Covers:
 *   - captureEnabled / injectionEnabled default FALSE.
 *   - No silent default owner (no settings -> no capture, no injection).
 *   - Removed legacy MEMORY_ENABLED and alias env vars never enable the pipeline.
 *   - Only the dedicated four-layer capture/injection env vars are honored.
 *   - The returned settings shape carries no legacy migration marker.
 *   - normalizePipelineSettings clamp behavior.
 *   - setMemoryPipelineSettingsResolver / reset for tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MEMORY_PIPELINE_SETTINGS,
  defaultMemoryPipelineSettingsResolver,
  normalizePipelineSettings,
  resolveMemoryPipelineSettings,
  resetMemoryPipelineSettingsResolverForTests,
  setMemoryPipelineSettingsResolver,
} from "../../src/memory/integration/settings.ts";

describe("memory pipeline settings — defaults", () => {
  it("all defaults are off / conservative", () => {
    assert.equal(DEFAULT_MEMORY_PIPELINE_SETTINGS.captureEnabled, false);
    assert.equal(DEFAULT_MEMORY_PIPELINE_SETTINGS.injectionEnabled, false);
    assert.equal("migratedFromLegacy" in DEFAULT_MEMORY_PIPELINE_SETTINGS, false);
    assert.equal(DEFAULT_MEMORY_PIPELINE_SETTINGS.l3CharBudget, 600);
    assert.equal(DEFAULT_MEMORY_PIPELINE_SETTINGS.l2CharBudget, 600);
    assert.equal(DEFAULT_MEMORY_PIPELINE_SETTINGS.l1CharBudget, 600);
    assert.equal(DEFAULT_MEMORY_PIPELINE_SETTINGS.totalCharBudget, 8000);
    assert.equal(DEFAULT_MEMORY_PIPELINE_SETTINGS.recallTimeoutMs, 5000);
  });
});

describe("defaultMemoryPipelineSettingsResolver (env/DB adapter)", () => {
  it("returns defaults when no env vars are set", () => {
    const prev = { ...process.env };
    delete process.env.OMNIROUTE_MEMORY_CAPTURE_ENABLED;
    delete process.env.OMNIROUTE_MEMORY_INJECTION_ENABLED;
    delete process.env.OMNIROUTE_MEMORY_L0_CAPTURE;
    delete process.env.OMNIROUTE_MEMORY_INJECTION;
    delete process.env.MEMORY_ENABLED;
    const out = defaultMemoryPipelineSettingsResolver("apikey-1");
    assert.equal(out.captureEnabled, false);
    assert.equal(out.injectionEnabled, false);
    assert.equal("migratedFromLegacy" in out, false);
    process.env = prev;
  });

  it("removed MEMORY_ENABLED=true does not enable the four-layer pipeline", () => {
    const prev = { ...process.env };
    delete process.env.OMNIROUTE_MEMORY_CAPTURE_ENABLED;
    delete process.env.OMNIROUTE_MEMORY_INJECTION_ENABLED;
    delete process.env.OMNIROUTE_MEMORY_L0_CAPTURE;
    delete process.env.OMNIROUTE_MEMORY_INJECTION;
    process.env.MEMORY_ENABLED = "true";
    const out = defaultMemoryPipelineSettingsResolver("apikey-1");
    assert.equal("migratedFromLegacy" in out, false);
    assert.equal(out.captureEnabled, false);
    assert.equal(out.injectionEnabled, false);
    process.env = prev;
  });

  it("legacy memoryEnabled=false does NOT enable capture or injection", () => {
    const prev = { ...process.env };
    delete process.env.OMNIROUTE_MEMORY_CAPTURE_ENABLED;
    delete process.env.OMNIROUTE_MEMORY_INJECTION_ENABLED;
    delete process.env.OMNIROUTE_MEMORY_L0_CAPTURE;
    delete process.env.OMNIROUTE_MEMORY_INJECTION;
    process.env.MEMORY_ENABLED = "false";
    const out = defaultMemoryPipelineSettingsResolver("apikey-1");
    assert.equal("migratedFromLegacy" in out, false);
    assert.equal(out.captureEnabled, false);
    assert.equal(out.injectionEnabled, false);
    process.env = prev;
  });

  it("dedicated capture env enables capture independently", () => {
    const prev = { ...process.env };
    process.env.OMNIROUTE_MEMORY_CAPTURE_ENABLED = "true";
    process.env.MEMORY_ENABLED = "false";
    const out = defaultMemoryPipelineSettingsResolver("apikey-1");
    assert.equal(out.captureEnabled, true);
    // injection should still be false (no override)
    assert.equal(out.injectionEnabled, false);
    process.env = prev;
  });

  it("OMNIROUTE_MEMORY_INJECTION_ENABLED=true enables injection only", () => {
    const prev = { ...process.env };
    process.env.OMNIROUTE_MEMORY_INJECTION_ENABLED = "true";
    const out = defaultMemoryPipelineSettingsResolver("apikey-2");
    assert.equal(out.injectionEnabled, true);
    assert.equal(out.captureEnabled, false);
    process.env = prev;
  });

  it("removed alias OMNIROUTE_MEMORY_L0_CAPTURE is ignored", () => {
    const prev = { ...process.env };
    delete process.env.OMNIROUTE_MEMORY_CAPTURE_ENABLED;
    process.env.OMNIROUTE_MEMORY_L0_CAPTURE = "1";
    const out = defaultMemoryPipelineSettingsResolver("apikey-3");
    assert.equal(out.captureEnabled, false);
    process.env = prev;
  });

  it("removed alias OMNIROUTE_MEMORY_INJECTION is ignored", () => {
    const prev = { ...process.env };
    delete process.env.OMNIROUTE_MEMORY_INJECTION_ENABLED;
    process.env.OMNIROUTE_MEMORY_INJECTION = "true";
    const out = defaultMemoryPipelineSettingsResolver("apikey-3");
    assert.equal(out.injectionEnabled, false);
    process.env = prev;
  });

  it("explicit empty string env is treated as false", () => {
    const prev = { ...process.env };
    process.env.OMNIROUTE_MEMORY_CAPTURE_ENABLED = "";
    const out = defaultMemoryPipelineSettingsResolver("apikey-4");
    assert.equal(out.captureEnabled, false);
    process.env = prev;
  });

  it("unrecognized env values resolve to false", () => {
    const prev = { ...process.env };
    process.env.OMNIROUTE_MEMORY_CAPTURE_ENABLED = "definitely";
    const out = defaultMemoryPipelineSettingsResolver("apikey-5");
    assert.equal(out.captureEnabled, false);
    process.env = prev;
  });
});

describe("normalizePipelineSettings", () => {
  it("returns defaults for null/undefined", () => {
    assert.deepEqual(normalizePipelineSettings(null), DEFAULT_MEMORY_PIPELINE_SETTINGS);
    assert.deepEqual(normalizePipelineSettings(undefined), DEFAULT_MEMORY_PIPELINE_SETTINGS);
  });

  it("clamps negative budgets to 0", () => {
    const out = normalizePipelineSettings({
      l3CharBudget: -10,
      l2CharBudget: -1,
      l1CharBudget: -100,
      totalCharBudget: -5,
    });
    assert.equal(out.l3CharBudget, 0);
    assert.equal(out.l2CharBudget, 0);
    assert.equal(out.l1CharBudget, 0);
    assert.equal(out.totalCharBudget, 0);
  });

  it("clamps absurdly large budgets to 64000", () => {
    const out = normalizePipelineSettings({
      l3CharBudget: 1_000_000,
      l2CharBudget: 1_000_000,
      l1CharBudget: 1_000_000,
      totalCharBudget: 1_000_000,
    });
    assert.equal(out.l3CharBudget, 64000);
    assert.equal(out.l2CharBudget, 64000);
    assert.equal(out.l1CharBudget, 64000);
    assert.equal(out.totalCharBudget, 64000);
  });

  it("clamps recallTimeoutMs to [1, 60000]", () => {
    assert.equal(normalizePipelineSettings({ recallTimeoutMs: 0 }).recallTimeoutMs, 1);
    assert.equal(normalizePipelineSettings({ recallTimeoutMs: -5 }).recallTimeoutMs, 1);
    assert.equal(normalizePipelineSettings({ recallTimeoutMs: 999_999 }).recallTimeoutMs, 60000);
  });

  it("forces booleans (1/0 -> not accepted, string -> not coerced)", () => {
    const out = normalizePipelineSettings({
      captureEnabled: 1,
      injectionEnabled: "true",
    });
    assert.equal(out.captureEnabled, false);
    assert.equal(out.injectionEnabled, false);
  });

  it("normalizes without adding removed migration metadata", () => {
    const out = normalizePipelineSettings({
      captureEnabled: true,
      injectionEnabled: true,
      migratedFromLegacy: true,
    } as never);
    assert.equal(out.captureEnabled, true);
    assert.equal(out.injectionEnabled, true);
    assert.equal("migratedFromLegacy" in out, false);
  });
});

describe("setMemoryPipelineSettingsResolver + resolveMemoryPipelineSettings", () => {
  it("swappable resolver wins", async () => {
    setMemoryPipelineSettingsResolver(() => ({
      ...DEFAULT_MEMORY_PIPELINE_SETTINGS,
      captureEnabled: true,
      injectionEnabled: true,
    }));
    const out = await resolveMemoryPipelineSettings("apikey-x");
    assert.equal(out.captureEnabled, true);
    assert.equal(out.injectionEnabled, true);
    resetMemoryPipelineSettingsResolverForTests();
  });

  it("swappable resolver throwing yields defaults", async () => {
    setMemoryPipelineSettingsResolver(() => {
      throw new Error("boom");
    });
    const out = await resolveMemoryPipelineSettings("apikey-y");
    assert.deepEqual(out, DEFAULT_MEMORY_PIPELINE_SETTINGS);
    resetMemoryPipelineSettingsResolverForTests();
  });

  it("null apiKeyId still resolves via the resolver", async () => {
    const out = await resolveMemoryPipelineSettings(null);
    assert.equal(out.captureEnabled, false);
    assert.equal(out.injectionEnabled, false);
  });
});
