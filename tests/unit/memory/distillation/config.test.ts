import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDistillationConfig,
  isWorkerStartAllowed,
  parseDistillationModelOverride,
  DEFAULT_DISTILLATION_INTERVAL_SECONDS,
  DEFAULT_DISTILLATION_CONCURRENCY,
} from "../../../../src/memory/distillation/config.ts";

describe("distillation/config — env resolution", () => {
  it("is disabled by default (master switch off)", () => {
    const c = resolveDistillationConfig({} as NodeJS.ProcessEnv);
    assert.equal(c.enabled, false);
    assert.equal(c.intervalMs, DEFAULT_DISTILLATION_INTERVAL_SECONDS * 1000);
    assert.equal(c.concurrency, DEFAULT_DISTILLATION_CONCURRENCY);
  });

  it("flips enabled only on exact 'true'", () => {
    const yes = resolveDistillationConfig({
      MEMORY_DISTILLATION_ENABLED: "true",
    } as NodeJS.ProcessEnv);
    const no1 = resolveDistillationConfig({
      MEMORY_DISTILLATION_ENABLED: "TRUE",
    } as NodeJS.ProcessEnv);
    const no2 = resolveDistillationConfig({
      MEMORY_DISTILLATION_ENABLED: "1",
    } as NodeJS.ProcessEnv);
    assert.equal(yes.enabled, true);
    assert.equal(no1.enabled, false);
    assert.equal(no2.enabled, false);
  });

  it("clamps interval/permits/depth to positive integers within max", () => {
    const c = resolveDistillationConfig({
      MEMORY_DISTILLATION_INTERVAL: "garbage",
      MEMORY_DISTILLATION_CONCURRENCY: "0",
      MEMORY_DISTILLATION_MAX_DEPTH: "999999",
    } as NodeJS.ProcessEnv);
    assert.equal(c.intervalMs, DEFAULT_DISTILLATION_INTERVAL_SECONDS * 1000);
    assert.equal(c.concurrency, DEFAULT_DISTILLATION_CONCURRENCY);
    assert.equal(c.maxDepth, 64);
  });

  it("accepts a positive integer interval and converts to ms", () => {
    const c = resolveDistillationConfig({
      MEMORY_DISTILLATION_INTERVAL: "30",
    } as NodeJS.ProcessEnv);
    assert.equal(c.intervalMs, 30_000);
  });
});

describe("distillation/config — parseDistillationModelOverride", () => {
  it("accepts 'prov/model' (canonical)", () => {
    assert.deepEqual(parseDistillationModelOverride("openai/gpt-4o-mini"), {
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });
  it("accepts 'prov:model' (legacy)", () => {
    assert.deepEqual(parseDistillationModelOverride("anthropic:claude-3-5-sonnet"), {
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });
  });
  it("tolerates whitespace", () => {
    assert.deepEqual(parseDistillationModelOverride("  prov / model  "), {
      provider: "prov",
      model: "model",
    });
  });
  it("returns null on missing/empty/junk", () => {
    assert.equal(parseDistillationModelOverride(undefined), null);
    assert.equal(parseDistillationModelOverride(""), null);
    assert.equal(parseDistillationModelOverride("   "), null);
    assert.equal(parseDistillationModelOverride("just-a-name"), null);
    assert.equal(parseDistillationModelOverride("only-slash/"), null);
    assert.equal(parseDistillationModelOverride("/no-provider"), null);
  });
});

describe("distillation/config — isWorkerStartAllowed", () => {
  it("rejects in build phase", () => {
    assert.equal(isWorkerStartAllowed({} as NodeJS.ProcessEnv, true, false, false), false);
  });
  it("rejects in cloud runtime", () => {
    assert.equal(isWorkerStartAllowed({} as NodeJS.ProcessEnv, false, true, false), false);
  });
  it("rejects under automated test runner", () => {
    assert.equal(isWorkerStartAllowed({} as NodeJS.ProcessEnv, false, false, true), false);
  });
  it("honours OMNIROUTE_DISABLE_BACKGROUND_SERVICES", () => {
    assert.equal(
      isWorkerStartAllowed(
        { OMNIROUTE_DISABLE_BACKGROUND_SERVICES: "true" } as NodeJS.ProcessEnv,
        false,
        false,
        false
      ),
      false
    );
  });
  it("accepts a plain production environment", () => {
    assert.equal(isWorkerStartAllowed({} as NodeJS.ProcessEnv, false, false, false), true);
  });
});

describe("distillation/config — secret handling", () => {
  it("derives a stable secret from MEMORY_DISTILLATION_SECRET", () => {
    const a = resolveDistillationConfig({
      MEMORY_DISTILLATION_SECRET: "op-set-secret",
    } as NodeJS.ProcessEnv);
    const b = resolveDistillationConfig({
      MEMORY_DISTILLATION_SECRET: "op-set-secret",
    } as NodeJS.ProcessEnv);
    assert.equal(bytesEqual(a.secret, b.secret), true);
    assert.equal(a.secret.length, 32);
  });

  it("rejects a short MEMORY_DISTILLATION_SECRET (no predictable fallback)", () => {
    const c = resolveDistillationConfig({
      MEMORY_DISTILLATION_SECRET: "short",
    } as NodeJS.ProcessEnv);
    assert.ok(c.secret.length >= 16);
  });
});

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
