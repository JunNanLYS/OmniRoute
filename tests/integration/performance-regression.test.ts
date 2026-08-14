/**
 * Performance regression tests for OmniRoute
 *
 * Tests bulk data operations against acceptable time thresholds.
 * Thresholds are 2x the expected target to account for slow CI machines.
 *
 * Run: node --import tsx --test tests/integration/performance-regression.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Environment setup (must come before dynamic imports) ---
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-perf-regression-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.REQUIRE_API_KEY = "false";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
if (!process.env.API_KEY_SECRET) {
  process.env.API_KEY_SECRET = "test-perf-secret-" + Date.now();
}

// --- Dynamic imports after env setup ---
const core = await import("../../src/lib/db/core.ts");
const memoryCore = await import("../../src/memory/db/core.ts");
const { createMemory } = await import("../../src/memory/l1.ts");
const { ownerFromApiKeyId, PRODUCTION_RECALL_PROVIDER } =
  await import("../../src/memory/integration/runtime.ts");
const { skillRegistry } = await import("../../src/lib/skills/registry.ts");

// --- Constants ---
const TEST_API_KEY_ID = "perf-test-api-key";
const MEMORY_COUNT = 1000;
const SKILL_COUNT = 100;

// --- Thresholds (2x buffer for CI) ---
const THRESHOLD_L1_RECALL_MS = 400;
const THRESHOLD_SKILLS_CACHED_MS = 100;
const THRESHOLD_SKILLS_UNCACHED_MS = 400;

// --- Helpers ---
function makeMemoryData(index: number) {
  return {
    owner: ownerFromApiKeyId(TEST_API_KEY_ID),
    type: "work_fact" as const,
    priority: 50,
    sceneName: "performance",
    sourceMessageIds: [],
    metadata: { index, tag: "perf-test" },
    content: `This is test memory content number ${index} for performance regression testing purposes`,
    lastModifiedBy: "pipeline" as const,
    editedByUser: false,
  };
}

// ============================================================
// Test 1: Live four-layer L1 recall over 1000 owner-scoped records
// ============================================================
describe("Performance: four-layer L1 recall (1000 records)", () => {
  before(() => {
    for (let i = 0; i < MEMORY_COUNT; i++) {
      createMemory(makeMemoryData(i));
    }
  });

  after(() => {
    memoryCore.resetMemoryDbInstance();
  });

  it(`should recall query-matching L1 memories in <${THRESHOLD_L1_RECALL_MS}ms`, async () => {
    const start = performance.now();
    const results = await PRODUCTION_RECALL_PROVIDER.fetchL1({
      ownerId: TEST_API_KEY_ID,
      sessionId: "perf-test-session",
      query: "performance regression testing",
    });
    const elapsed = performance.now() - start;

    assert.equal(results.length, MEMORY_COUNT, "Should find all matching owner memories");
    assert.ok(
      results.every((memory) => /performance regression testing/i.test(memory.content)),
      "Every recalled item should match the focused query"
    );
    assert.ok(
      elapsed < THRESHOLD_L1_RECALL_MS,
      `Four-layer L1 recall took ${elapsed.toFixed(1)}ms, expected <${THRESHOLD_L1_RECALL_MS}ms`
    );
  });
});

// ============================================================
// Test 2: Skills registry - cached vs uncached list
// ============================================================
describe("Performance: skills registry cached vs uncached", () => {
  before(async () => {
    // Register 100 skills in the database
    for (let i = 0; i < SKILL_COUNT; i++) {
      await skillRegistry.register({
        name: `perf-skill-${i}`,
        version: "1.0.0",
        description: `Performance test skill ${i}`,
        schema: { input: {}, output: {} },
        handler: `echo "skill ${i}"`,
        enabled: true,
        apiKeyId: TEST_API_KEY_ID,
      });
    }
  });

  after(async () => {
    // Clean up skills
    const db = core.getDbInstance();
    db.prepare("DELETE FROM skills WHERE api_key_id = ?").run(TEST_API_KEY_ID);
    skillRegistry.invalidateCache();
  });

  it(`should load skills from DB (uncached) in <${THRESHOLD_SKILLS_UNCACHED_MS}ms`, async () => {
    // Force cache invalidation so loadFromDatabase actually hits DB
    skillRegistry.invalidateCache();

    const start = performance.now();
    await skillRegistry.loadFromDatabase();
    const elapsed = performance.now() - start;

    assert.ok(
      elapsed < THRESHOLD_SKILLS_UNCACHED_MS,
      `Uncached loadFromDatabase took ${elapsed.toFixed(1)}ms, expected <${THRESHOLD_SKILLS_UNCACHED_MS}ms`
    );
  });

  it(`should list skills from cache in <${THRESHOLD_SKILLS_CACHED_MS}ms`, async () => {
    // Ensure cache is warm (loadFromDatabase was just called above)
    // Call list() which reads from in-memory Map
    const start = performance.now();
    const skills = skillRegistry.list();
    const elapsed = performance.now() - start;

    assert.ok(skills.length >= SKILL_COUNT, `Should have at least ${SKILL_COUNT} skills`);
    assert.ok(
      elapsed < THRESHOLD_SKILLS_CACHED_MS,
      `Cached list() took ${elapsed.toFixed(1)}ms, expected <${THRESHOLD_SKILLS_CACHED_MS}ms`
    );
  });
});

after(() => {
  memoryCore.resetMemoryDbInstance();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
