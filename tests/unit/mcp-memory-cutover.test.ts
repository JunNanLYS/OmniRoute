/**
 * tests/unit/mcp-memory-cutover.test.ts
 *
 * Hard-cutover — focused TDD for the new four-layer MCP memory surface.
 *
 * This file pins the contract for the cutover:
 *   1. The five new tool names are present in `memoryTools`.
 *   2. The five new tool names are mapped in `MCP_TOOL_SCOPES` to read:memory.
 *   3. The legacy three tool names are absent from both.
 *   4. `read:memory` / `write:memory` are present in `MCP_SCOPE_LIST`.
 *   5. `evaluateToolScopes` correctly enforces `read:memory` for the new tools.
 *   6. `assertCallerOwner` rejects cross-tenant ids and fails closed.
 *   7. The five handler args CANNOT pick a different `apiKeyId` / `ownerId`.
 *   8. A2A skills do not import from `@/lib/memory` (Hard Rule #18 — A2A
 *      memory stripping — the five skill entities are kept but their memory
 *      imports were never present in this repo).
 *   9. Old CLI exports are absent; new ones are present.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mcp-memory-cutover-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tmpDir;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "cutover-test-secret-" + Date.now();

const core = await import("../../src/lib/db/core.ts");

test.after(() => {
  core.resetDbInstance();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. memoryTools exposes the new five tools ────────────────────────────────

test("memoryTools exposes the new five tools (l0/l1/l2/l3/list)", async () => {
  const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  const expected = [
    "omniroute_memory_l0_search",
    "omniroute_memory_l1_search",
    "omniroute_memory_l2_read",
    "omniroute_memory_l3_read",
    "omniroute_memory_list",
  ];
  for (const name of expected) {
    assert.ok((memoryTools as Record<string, unknown>)[name], `memoryTools must expose ${name}`);
  }
  assert.equal(Object.keys(memoryTools).length, expected.length);
});

// ── 2. memoryTools does NOT expose the legacy three tools ───────────────────

test("memoryTools drops the legacy search/add/clear tools", async () => {
  const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  for (const legacy of [
    "omniroute_memory_search",
    "omniroute_memory_add",
    "omniroute_memory_clear",
  ]) {
    assert.equal(
      (memoryTools as Record<string, unknown>)[legacy],
      undefined,
      `legacy tool ${legacy} must be removed`
    );
  }
});

// ── 3. MCP_SCOPE_LIST contains read:memory / write:memory ───────────────────

test("MCP_SCOPE_LIST contains read:memory and write:memory", async () => {
  const { MCP_SCOPE_LIST } = await import("../../src/shared/constants/mcpScopes.ts");
  assert.ok(
    (MCP_SCOPE_LIST as readonly string[]).includes("read:memory"),
    "MCP_SCOPE_LIST must include read:memory"
  );
  assert.ok(
    (MCP_SCOPE_LIST as readonly string[]).includes("write:memory"),
    "MCP_SCOPE_LIST must include write:memory"
  );
});

// ── 4. MCP_TOOL_SCOPES maps the new tools to read:memory ────────────────────

test("MCP_TOOL_SCOPES maps the new tools to read:memory", async () => {
  const { MCP_TOOL_SCOPES } = await import("../../src/shared/constants/mcpScopes.ts");
  const expected = [
    "omniroute_memory_l0_search",
    "omniroute_memory_l1_search",
    "omniroute_memory_l2_read",
    "omniroute_memory_l3_read",
    "omniroute_memory_list",
  ];
  for (const name of expected) {
    const scopes = (MCP_TOOL_SCOPES as Record<string, readonly string[]>)[name];
    assert.ok(scopes, `${name} must be in MCP_TOOL_SCOPES`);
    assert.ok(
      scopes.includes("read:memory"),
      `${name} must require read:memory (got ${JSON.stringify(scopes)})`
    );
  }
});

// ── 5. evaluateToolScopes enforces read:memory on the new tools ─────────────

test("evaluateToolScopes enforces read:memory on the new tools", async () => {
  const { evaluateToolScopes } = await import("../../open-sse/mcp-server/scopeEnforcement.ts");
  // Memory tools are NOT in MCP_TOOL_MAP (built from MCP_TOOLS in
  // schemas/tools.ts) — they live in the separate `memoryTools` collection,
  // and the server passes `toolDef.scopes` inline to withScopeEnforcement.
  // So the assertion must pass the inline scopes explicitly.
  const inline = ["read:memory"];
  const missing = evaluateToolScopes("omniroute_memory_l0_search", ["read:health"], true, inline);
  assert.equal(missing.allowed, false, "read:health alone must NOT unlock l0 search");
  assert.ok(missing.missing.includes("read:memory"));

  const ok = evaluateToolScopes("omniroute_memory_l0_search", ["read:memory"], true, inline);
  assert.equal(ok.allowed, true, "read:memory must unlock l0 search");
});

// ── 6. assertCallerOwner rejects cross-tenant ids (IDOR guard) ──────────────

test("assertCallerOwner rejects cross-tenant apiKeyId", async () => {
  const { assertCallerOwner } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  const extra = { authInfo: { clientId: "owner-A", scopes: ["read:memory"] } };
  await assert.rejects(() => assertCallerOwner(extra, { apiKeyId: "owner-B" }), /not authorized/i);
});

test("assertCallerOwner rejects cross-tenant ownerId", async () => {
  const { assertCallerOwner } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  const extra = { authInfo: { clientId: "owner-A", scopes: ["read:memory"] } };
  await assert.rejects(() => assertCallerOwner(extra, { ownerId: "owner-B" }), /not authorized/i);
});

// ── 7. assertCallerOwner fails closed when no owner is resolvable ───────────

test("assertCallerOwner fails closed with anonymous principal", async () => {
  const { assertCallerOwner } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  // Empty extra: authInfo.clientId undefined, sessionId undefined → callerId "anonymous"
  await assert.rejects(() => assertCallerOwner({}, {}), /no resolvable owner/i);
});

// ── 8. A2A skills do not import from @/lib/memory (structural) ─────────────

test("A2A skills do not import from @/lib/memory", async () => {
  const a2aDir = path.resolve(import.meta.dirname, "../../src/lib/a2a");
  const skillsDir = path.join(a2aDir, "skills");
  const files = fs
    .readdirSync(skillsDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(skillsDir, f));
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    assert.ok(
      !src.includes("@/lib/memory"),
      `${path.basename(file)} must not import from @/lib/memory`
    );
    // Also no direct retrieval/store imports.
    for (const banned of [
      "retrieveMemories",
      "createMemory",
      "listMemories",
      "deleteMemory",
      "MemoryType",
      "getMemorySettings",
      "toMemoryRetrievalConfig",
    ]) {
      assert.ok(!src.includes(banned), `${path.basename(file)} must not reference ${banned}`);
    }
  }
});

// ── 9. CLI legacy exports are absent, new exports are present ──────────────

test("CLI memory module exposes only live four-layer route adapters", async () => {
  const mod = await import("../../bin/cli/commands/memory.mjs");
  for (const removed of [
    "runMemorySearch",
    "runMemoryAdd",
    "runMemoryClear",
    "runMemoryGet",
    "runMemoryDelete",
    "runMemoryHealth",
    "runSettingsGet",
    "runSettingsSet",
    "runSettingsReset",
    "runDistilStatus",
    "runDistilRetryDlq",
  ]) {
    assert.equal(
      (mod as Record<string, unknown>)[removed],
      undefined,
      `removed export ${removed} must stay absent`
    );
  }
  for (const live of [
    "runL0Search",
    "runL1Search",
    "runL2Read",
    "runL3Read",
    "runMemoryList",
    "runDistillationModelGet",
    "runDistillationModelSet",
    "runDistillationModelDelete",
    "runDlqList",
    "runDlqRetry",
    "registerMemory",
  ]) {
    assert.equal(
      typeof (mod as Record<string, unknown>)[live],
      "function",
      `live export ${live} must be present`
    );
  }
});

// ── 10. CLI command tree contains l0/l1/l2/l3/settings/distil/list ─────────

test("CLI registerMemory registers only live four-layer command groups", async () => {
  // Build a real program and walk its command tree.
  const captured: { name: string; sub: string[] }[] = [];
  type Fake = {
    name: string;
    sub: string[];
    description: (s?: string) => Fake;
    command: (n: string) => Fake;
    option: () => Fake;
    action: () => Fake;
  };
  function makeNode(name: string): Fake {
    const node: Fake = {
      name,
      sub: [] as string[],
      description: () => node,
      command(n: string) {
        node.sub.push(n);
        return makeNode(`${node.name}>${n}`);
      },
      option: () => node,
      action: () => node,
    };
    return node;
  }
  const root = {
    command(name: string): Fake {
      const child = makeNode(name);
      captured.push(child);
      return child;
    },
  };
  // Re-import (cached) — module-level state is none.
  const mod = await import("../../bin/cli/commands/memory.mjs");
  (mod.registerMemory as (p: unknown) => void)(root);

  const memory = captured.find((c) => c.name === "memory");
  assert.ok(memory, "memory root command must be registered");
  for (const sub of ["l0", "l1", "l2", "l3", "list", "distillation-model", "dlq"]) {
    assert.ok(
      memory!.sub.includes(sub),
      `memory must register subcommand ${sub}; got ${JSON.stringify(memory!.sub)}`
    );
  }
});

// ── 11. Thrown error from handler is sanitized (no raw stack) ──────────────

test("tool adapter throws a sanitized error on cross-tenant arg (no raw stack)", async () => {
  const { assertCallerOwner } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  // The error message is composed at throw-time with no path or stack
  // information — verify the source path of the throw is hidden in error
  // chains the tool returns.
  try {
    await assertCallerOwner({ authInfo: { clientId: "x" } }, { apiKeyId: "y" });
    assert.fail("expected assertCallerOwner to throw");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.ok(
      !msg.includes("\n"),
      `error message must be single-line, got: ${JSON.stringify(msg)}`
    );
    assert.ok(!/at\s+\//i.test(msg), `error message must not contain raw stack, got: ${msg}`);
  }
});
