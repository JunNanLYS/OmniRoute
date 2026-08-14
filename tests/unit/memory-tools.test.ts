/**
 * tests/unit/memory-tools.test.ts
 *
 * Hard-cutover — the legacy MCP `omniroute_memory_search` / `add` / `clear`
 * tool surface is gone. This file now asserts the cutover shape:
 *
 *   1. The legacy three tools are absent from `memoryTools`.
 *   2. The new five tools are present with the right scopes and input shape.
 *   3. The new tools sanitize thrown messages (no raw stack / paths).
 *   4. Cross-tenant `apiKeyId` / `ownerId` args are rejected (IDOR guard).
 *   5. The `resolveCallerOwner` helper fails closed (no anonymous read).
 *
 * The handlers themselves call a new `/api/memory/*` REST surface; runtime
 * behavior against the backing store is out of scope for this unit test
 * (the storage layer is unchanged, only the MCP-tool wrapper is).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-memory-tools-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tmpDir;

const core = await import("../../src/lib/db/core.ts");

test.after(() => {
  core.resetDbInstance();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("memoryTools drops the legacy three handlers", async () => {
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

test("memoryTools exposes the new five read handlers with read:memory scope", async () => {
  const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  const expected = [
    "omniroute_memory_l0_search",
    "omniroute_memory_l1_search",
    "omniroute_memory_l2_read",
    "omniroute_memory_l3_read",
    "omniroute_memory_list",
  ] as const;
  for (const name of expected) {
    const tool = (memoryTools as Record<string, { scopes: readonly string[] }>)[name];
    assert.ok(tool, `tool ${name} must be present`);
    assert.ok(
      Array.isArray(tool.scopes) && tool.scopes.includes("read:memory"),
      `${name} must require read:memory`
    );
  }
});

test("new read handlers reject `apiKeyId` arg that does not match the caller principal", async () => {
  const { memoryTools, assertCallerOwner } =
    await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  // principal derived from sessionId, not authInfo; "anonymous" is rejected.
  const extra = { authInfo: { clientId: "owner-A", scopes: [] }, sessionId: "owner-A" };
  await assert.rejects(
    () => assertCallerOwner(extra, { apiKeyId: "owner-B" }),
    /not authorized/i,
    "must reject cross-tenant apiKeyId"
  );
  await assert.rejects(
    () => assertCallerOwner(extra, { ownerId: "owner-B" }),
    /not authorized/i,
    "must reject cross-tenant ownerId"
  );
  // Same principal is allowed
  const owner = await assertCallerOwner(extra, { apiKeyId: "owner-A", ownerId: "owner-A" });
  assert.equal(owner, "owner-A");
});

test("assertCallerOwner fails closed when no owner is resolvable", async () => {
  const { assertCallerOwner } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  // No authInfo, no sessionId → no resolvable principal
  const extra = { authInfo: { clientId: "anonymous", scopes: [] } };
  await assert.rejects(
    () => assertCallerOwner(extra, {}),
    /no resolvable owner/i,
    "must fail closed without an owner"
  );
});

test("new tool handlers clamp the limit Zod field (1-100)", async () => {
  const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  const schema = memoryTools.omniroute_memory_l0_search.inputSchema;
  // Above the cap → Zod fails
  assert.throws(() => schema.parse({ query: "x", limit: 9999 }), /100|too_big/i);
  // Below the cap → Zod passes
  assert.doesNotThrow(() => schema.parse({ query: "x", limit: 1 }));
  // Missing limit → optional, allowed
  assert.doesNotThrow(() => schema.parse({ query: "x" }));
});

test("l0/l1 input requires `query` (1-1024 chars)", async () => {
  const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  const schema = memoryTools.omniroute_memory_l0_search.inputSchema;
  assert.throws(() => schema.parse({}), /Required|query/i);
  assert.throws(() => schema.parse({ query: "" }), /at least 1|min/i);
  assert.throws(() => schema.parse({ query: "x".repeat(1025) }), /at most 1024|max/i);
  assert.doesNotThrow(() => schema.parse({ query: "ok" }));
});

test("l2 input requires `id` (1-256 chars)", async () => {
  const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  const schema = memoryTools.omniroute_memory_l2_read.inputSchema;
  assert.throws(() => schema.parse({}), /Required|id/i);
  assert.throws(() => schema.parse({ id: "" }), /at least 1|min/i);
  assert.throws(() => schema.parse({ id: "x".repeat(257) }), /at most 256|max/i);
  assert.doesNotThrow(() => schema.parse({ id: "scene-1" }));
});

test("sessionId filter is optional but bounded (1-256)", async () => {
  const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  const schema = memoryTools.omniroute_memory_l3_read.inputSchema;
  assert.doesNotThrow(() => schema.parse({}));
  assert.throws(() => schema.parse({ sessionId: "x".repeat(257) }), /at most 256|max/i);
  assert.doesNotThrow(() => schema.parse({ sessionId: "session-1" }));
});

test("list input schema accepts optional session/scene/limit", async () => {
  const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
  const schema = memoryTools.omniroute_memory_list.inputSchema;
  assert.doesNotThrow(() => schema.parse({}));
  assert.doesNotThrow(() => schema.parse({ sessionId: "s1", scene: "ops", limit: 50 }));
  assert.throws(() => schema.parse({ limit: 9999 }), /100|too_big/i);
});

function mockResponse(data: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(typeof data === "string" ? data : JSON.stringify(data)),
  } as unknown as Response;
}

function installFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const callerExtra = {
  authInfo: { clientId: "owner-A", scopes: ["read:memory"] },
  sessionId: "owner-A",
};

test("L0 and L1 search handlers use real collection routes and data envelopes", async () => {
  const requests: string[] = [];
  const restore = installFetch((url) => {
    const parsed = new URL(String(url));
    requests.push(`${parsed.pathname}${parsed.search}`);
    const layer = parsed.pathname.endsWith("/l0") ? "l0" : "l1";
    return Promise.resolve(
      mockResponse({
        data: [{ id: `${layer}-1`, content: `${layer} memory` }],
        pagination: { page: 1, limit: 7, total: 1 },
      })
    );
  });
  try {
    const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
    const l0 = (await memoryTools.omniroute_memory_l0_search.handler(
      { query: "raw", sessionId: "s1", scene: "release", limit: 7 },
      callerExtra
    )) as { items: Array<{ id: string }>; count: number; total: number };
    const l1 = (await memoryTools.omniroute_memory_l1_search.handler(
      { query: "curated", scene: "ops", limit: 7 },
      callerExtra
    )) as { items: Array<{ id: string }>; count: number; total: number };

    const l0Url = new URL(requests[0], "http://localhost");
    assert.equal(l0Url.pathname, "/api/memory/l0");
    assert.equal(l0Url.searchParams.get("q"), "raw");
    assert.equal(l0Url.searchParams.get("sessionId"), "s1");
    assert.equal(l0Url.searchParams.get("sceneName"), "release");
    assert.equal(l0Url.searchParams.get("owner"), null);
    assert.equal(l0Url.searchParams.get("layer"), null);

    const l1Url = new URL(requests[1], "http://localhost");
    assert.equal(l1Url.pathname, "/api/memory/l1");
    assert.equal(l1Url.searchParams.get("q"), "curated");
    assert.equal(l1Url.searchParams.get("sceneName"), "ops");
    assert.deepEqual(l0, {
      layer: "L0",
      items: [{ id: "l0-1", content: "l0 memory" }],
      count: 1,
      total: 1,
    });
    assert.deepEqual(l1, {
      layer: "L1",
      items: [{ id: "l1-1", content: "l1 memory" }],
      count: 1,
      total: 1,
    });
  } finally {
    restore();
  }
});

test("L2 and L3 read handlers unwrap real detail and collection envelopes", async () => {
  const requests: string[] = [];
  const restore = installFetch((url) => {
    const parsed = new URL(String(url));
    requests.push(`${parsed.pathname}${parsed.search}`);
    if (parsed.pathname.startsWith("/api/memory/l2/")) {
      return Promise.resolve(mockResponse({ data: { id: "scene-1", content: "scene" } }));
    }
    return Promise.resolve(
      mockResponse({
        data: [{ id: "working-1", content: "working context" }],
        pagination: { page: 1, limit: 1, total: 1 },
      })
    );
  });
  try {
    const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
    const l2 = (await memoryTools.omniroute_memory_l2_read.handler(
      { id: "scene-1" },
      callerExtra
    )) as { found: boolean; scene: unknown };
    const l3 = (await memoryTools.omniroute_memory_l3_read.handler(
      { sessionId: "s1" },
      callerExtra
    )) as { found: boolean; persona: unknown };

    assert.equal(new URL(requests[0], "http://localhost").pathname, "/api/memory/l2/scene-1");
    assert.equal(new URL(requests[0], "http://localhost").searchParams.get("owner"), null);
    const l3Url = new URL(requests[1], "http://localhost");
    assert.equal(l3Url.pathname, "/api/memory/l3");
    assert.equal(l3Url.searchParams.get("limit"), "1");
    assert.equal(l3Url.searchParams.get("sessionId"), "s1");
    assert.deepEqual(l2.scene, { id: "scene-1", content: "scene" });
    assert.deepEqual(l3.persona, { id: "working-1", content: "working context" });
    assert.equal(l2.found, true);
    assert.equal(l3.found, true);
  } finally {
    restore();
  }
});

test("cross-layer list aggregates all four real collection routes", async () => {
  const requests: string[] = [];
  const restore = installFetch((url) => {
    const parsed = new URL(String(url));
    requests.push(`${parsed.pathname}${parsed.search}`);
    const layer = parsed.pathname.split("/").at(-1)?.toUpperCase() ?? "";
    return Promise.resolve(
      mockResponse({
        data: [{ id: `${layer.toLowerCase()}-1`, content: layer }],
        pagination: { page: 1, limit: 3, total: layer === "L1" ? 4 : 1 },
      })
    );
  });
  try {
    const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
    const result = (await memoryTools.omniroute_memory_list.handler(
      { sessionId: "s1", scene: "release", limit: 3 },
      callerExtra
    )) as {
      owner: string;
      layers: Record<string, number>;
      items: Array<{ layer: string; id: string }>;
      count: number;
    };

    assert.deepEqual(
      requests.map((request) => new URL(request, "http://localhost").pathname).sort(),
      ["/api/memory/l0", "/api/memory/l1", "/api/memory/l2", "/api/memory/l3"]
    );
    assert.ok(requests.every((request) => request.includes("limit=3")));
    assert.ok(requests.every((request) => request.includes("sessionId=s1")));
    assert.ok(requests.every((request) => request.includes("sceneName=release")));
    assert.ok(requests.every((request) => !request.includes("owner=")));
    assert.deepEqual(result.layers, { L0: 1, L1: 4, L2: 1, L3: 1 });
    assert.deepEqual(
      result.items.map((item) => item.layer),
      ["L0", "L1", "L2", "L3"]
    );
    assert.equal(result.count, 4);
    assert.equal(result.owner, "owner-A");
  } finally {
    restore();
  }
});

test("collection failures are surfaced as sanitized errors instead of empty success", async () => {
  const restore = installFetch(() =>
    Promise.resolve(mockResponse("database failed\n    at /private/server/memory.ts:9:1", 500))
  );
  try {
    const { memoryTools } = await import("../../open-sse/mcp-server/tools/memoryTools.ts");
    await assert.rejects(
      () => memoryTools.omniroute_memory_l0_search.handler({ query: "raw", limit: 5 }, callerExtra),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /memory API error \[500\]/i);
        assert.doesNotMatch(message, /\/private\/server|memory\.ts:9|\n/);
        return true;
      }
    );
  } finally {
    restore();
  }
});
