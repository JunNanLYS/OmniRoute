import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const L0_ITEMS = [
  {
    id: "m_l0_1",
    sessionId: "s1",
    content: "raw trace",
    recordedAt: "2026-05-10T10:00:00Z",
  },
];

const L1_ITEMS = [
  {
    id: "m_l1_1",
    sceneName: "ops",
    content: "curated memory",
    priority: 80,
    createdAt: "2026-05-09T10:00:00Z",
  },
];

const L2_SCENE = {
  id: "scene_x",
  sceneName: "release",
  summary: "Release work",
  content: "scene payload",
  createdAt: "2026-05-09T10:00:00Z",
};

const L3_ENTRY = {
  id: "persona_1",
  content: "persona body",
  promptMode: "code",
  updatedAt: "2026-05-09T11:00:00Z",
};

const SELECTOR = {
  provider: "anthropic",
  modelId: "claude-sonnet-5",
  sourceLayer: "per-key",
  apiKeyId: "owner-a",
  scope: "self",
};

const DLQ_ENTRY = {
  id: "17",
  sourceLayer: "l1",
  sourceId: "m_l1_1",
  errorMessage: "provider unavailable",
  errorAt: "2026-05-10T10:00:00Z",
  retryCount: 2,
  status: "failed",
  lastErrorCode: "UPSTREAM_503",
};

function makeResp(data: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}

function makeCmd(output = "json") {
  return { optsWithGlobals: () => ({ output, quiet: output !== "table" }) };
}

function installFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function requestPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

test("runL0Search queries the real L0 collection and reads the data envelope", async () => {
  let capturedUrl = "";
  const restore = installFetch((url) => {
    capturedUrl = String(url);
    return Promise.resolve(
      makeResp({ data: L0_ITEMS, pagination: { page: 1, limit: 10, total: 1 } })
    );
  });
  try {
    const { runL0Search } = await import("../../bin/cli/commands/memory.mjs");
    const output = await captureStdout(() =>
      runL0Search("raw query", { limit: "10", session: "s1", scene: "release" }, makeCmd() as never)
    );
    const parsed = JSON.parse(output) as Array<{ id: string }>;
    const url = new URL(capturedUrl);
    assert.equal(url.pathname, "/api/memory/l0");
    assert.equal(url.searchParams.get("q"), "raw query");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("sessionId"), "s1");
    assert.equal(url.searchParams.get("sceneName"), "release");
    assert.equal(parsed[0]?.id, "m_l0_1");
  } finally {
    restore();
  }
});

test("runL1Search queries the real L1 collection and reads the data envelope", async () => {
  let capturedUrl = "";
  const restore = installFetch((url) => {
    capturedUrl = String(url);
    return Promise.resolve(
      makeResp({ data: L1_ITEMS, pagination: { page: 1, limit: 5, total: 1 } })
    );
  });
  try {
    const { runL1Search } = await import("../../bin/cli/commands/memory.mjs");
    const output = await captureStdout(() =>
      runL1Search("curated query", { limit: "5", scene: "ops" }, makeCmd() as never)
    );
    const parsed = JSON.parse(output) as Array<{ id: string; scene: string }>;
    const url = new URL(capturedUrl);
    assert.equal(url.pathname, "/api/memory/l1");
    assert.equal(url.searchParams.get("q"), "curated query");
    assert.equal(url.searchParams.get("sceneName"), "ops");
    assert.equal(parsed[0]?.id, "m_l1_1");
    assert.equal(parsed[0]?.scene, "ops");
  } finally {
    restore();
  }
});

test("runL2Read unwraps the real detail data envelope", async () => {
  let capturedUrl = "";
  const restore = installFetch((url) => {
    capturedUrl = String(url);
    return Promise.resolve(makeResp({ data: L2_SCENE }));
  });
  try {
    const { runL2Read } = await import("../../bin/cli/commands/memory.mjs");
    const output = await captureStdout(() => runL2Read("scene_x", {}, makeCmd() as never));
    const parsed = JSON.parse(output) as Array<{ id: string; content: string }>;
    assert.equal(new URL(capturedUrl).pathname, "/api/memory/l2/scene_x");
    assert.equal(parsed[0]?.id, "scene_x");
    assert.equal(parsed[0]?.content, "scene payload");
  } finally {
    restore();
  }
});

test("runL3Read uses the real L3 collection and returns its current entry", async () => {
  let capturedUrl = "";
  const restore = installFetch((url) => {
    capturedUrl = String(url);
    return Promise.resolve(
      makeResp({ data: [L3_ENTRY], pagination: { page: 1, limit: 1, total: 1 } })
    );
  });
  try {
    const { runL3Read } = await import("../../bin/cli/commands/memory.mjs");
    const output = await captureStdout(() => runL3Read({ session: "s1" }, makeCmd() as never));
    const parsed = JSON.parse(output) as Array<{ id: string; content: string }>;
    const url = new URL(capturedUrl);
    assert.equal(url.pathname, "/api/memory/l3");
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(url.searchParams.get("sessionId"), "s1");
    assert.equal(parsed[0]?.id, "persona_1");
    assert.equal(parsed[0]?.content, "persona body");
  } finally {
    restore();
  }
});

test("runMemoryList aggregates the four real collection routes", async () => {
  const capturedPaths: string[] = [];
  const restore = installFetch((url) => {
    const parsed = new URL(String(url));
    capturedPaths.push(`${parsed.pathname}${parsed.search}`);
    const dataByLayer: Record<string, unknown[]> = {
      l0: L0_ITEMS,
      l1: L1_ITEMS,
      l2: [L2_SCENE],
      l3: [L3_ENTRY],
    };
    const layer = parsed.pathname.split("/").at(-1) ?? "";
    const data = dataByLayer[layer] ?? [];
    return Promise.resolve(
      makeResp({ data, pagination: { page: 1, limit: 5, total: data.length } })
    );
  });
  try {
    const { runMemoryList } = await import("../../bin/cli/commands/memory.mjs");
    const output = await captureStdout(() =>
      runMemoryList({ limit: "5", session: "s1", scene: "release" }, makeCmd() as never)
    );
    const parsed = JSON.parse(output) as Array<{ layer: string; id: string }>;
    assert.deepEqual(
      capturedPaths.map((value) => new URL(value, "http://localhost").pathname).sort(),
      ["/api/memory/l0", "/api/memory/l1", "/api/memory/l2", "/api/memory/l3"]
    );
    assert.deepEqual(
      parsed.map((entry) => entry.layer),
      ["L0", "L1", "L2", "L3"]
    );
    assert.ok(capturedPaths.every((value) => value.includes("limit=5")));
    assert.ok(capturedPaths.every((value) => value.includes("sceneName=release")));
  } finally {
    restore();
  }
});

test("runDistillationModelGet reads the selector data envelope", async () => {
  let capturedUrl = "";
  const restore = installFetch((url) => {
    capturedUrl = String(url);
    return Promise.resolve(makeResp({ data: SELECTOR }));
  });
  try {
    const { runDistillationModelGet } = await import("../../bin/cli/commands/memory.mjs");
    const output = await captureStdout(() => runDistillationModelGet({}, makeCmd() as never));
    const parsed = JSON.parse(output) as typeof SELECTOR;
    assert.equal(new URL(capturedUrl).pathname, "/api/memory/distillation-model");
    assert.equal(parsed.modelId, "claude-sonnet-5");
  } finally {
    restore();
  }
});

test("runDistillationModelSet PUTs the real selector schema", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const restore = installFetch((url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return Promise.resolve(makeResp({ data: SELECTOR }));
  });
  try {
    const { runDistillationModelSet } = await import("../../bin/cli/commands/memory.mjs");
    await captureStdout(() =>
      runDistillationModelSet("anthropic", "claude-sonnet-5", { scope: "self" }, makeCmd() as never)
    );
    assert.equal(new URL(capturedUrl).pathname, "/api/memory/distillation-model");
    assert.equal(capturedInit?.method, "PUT");
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      scope: "self",
    });
  } finally {
    restore();
  }
});

test("runDistillationModelDelete DELETEs by real selector scope", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const restore = installFetch((url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return Promise.resolve(makeResp({ success: true, scope: "global" }));
  });
  try {
    const { runDistillationModelDelete } = await import("../../bin/cli/commands/memory.mjs");
    await captureStdout(() => runDistillationModelDelete({ scope: "global" }, makeCmd() as never));
    const url = new URL(capturedUrl);
    assert.equal(url.pathname, "/api/memory/distillation-model");
    assert.equal(url.searchParams.get("scope"), "global");
    assert.equal(capturedInit?.method, "DELETE");
  } finally {
    restore();
  }
});

test("runDlqList queries the real DLQ route and data envelope", async () => {
  let capturedUrl = "";
  const restore = installFetch((url) => {
    capturedUrl = String(url);
    return Promise.resolve(
      makeResp({
        data: [DLQ_ENTRY],
        statusCounts: { failed: 1 },
        pagination: { limit: 25 },
      })
    );
  });
  try {
    const { runDlqList } = await import("../../bin/cli/commands/memory.mjs");
    const output = await captureStdout(() =>
      runDlqList({ limit: "25", statuses: "failed,pending" }, makeCmd() as never)
    );
    const parsed = JSON.parse(output) as Array<{ id: string; status: string }>;
    const url = new URL(capturedUrl);
    assert.equal(url.pathname, "/api/memory/distillation-model/dlq");
    assert.equal(url.searchParams.get("limit"), "25");
    assert.equal(url.searchParams.get("statuses"), "failed,pending");
    assert.equal(parsed[0]?.id, "17");
    assert.equal(parsed[0]?.status, "failed");
  } finally {
    restore();
  }
});

test("runDlqRetry POSTs op=retry with the real selected-id schema", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const restore = installFetch((url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return Promise.resolve(makeResp({ success: true, retried: 2, skipped: 0 }));
  });
  try {
    const { runDlqRetry } = await import("../../bin/cli/commands/memory.mjs");
    await captureStdout(() => runDlqRetry(["17", "18"], { yes: true }, makeCmd() as never));
    const url = new URL(capturedUrl);
    assert.equal(url.pathname, "/api/memory/distillation-model/dlq");
    assert.equal(url.searchParams.get("op"), "retry");
    assert.equal(capturedInit?.method, "POST");
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), { ids: ["17", "18"] });
  } finally {
    restore();
  }
});

test("runDlqRetry supports the real all=true schema", async () => {
  let capturedInit: RequestInit | undefined;
  const restore = installFetch((_url, init) => {
    capturedInit = init;
    return Promise.resolve(makeResp({ success: true, retried: 3, skipped: 0 }));
  });
  try {
    const { runDlqRetry } = await import("../../bin/cli/commands/memory.mjs");
    await captureStdout(() => runDlqRetry([], { yes: true, all: true }, makeCmd() as never));
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), { all: true });
  } finally {
    restore();
  }
});

test("runDlqRetry refuses without --yes", async () => {
  const originalExit = process.exit;
  let exitCode: number | null = null;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__exit__");
  }) as never;
  try {
    const { runDlqRetry } = await import("../../bin/cli/commands/memory.mjs");
    await runDlqRetry(["17"], {}, makeCmd() as never).catch(() => undefined);
    assert.equal(exitCode, 2);
  } finally {
    process.exit = originalExit;
  }
});

test("memory CLI exports and command tree contain only live cutover surfaces", async () => {
  const mod = await import("../../bin/cli/commands/memory.mjs");
  for (const removed of [
    "runSettingsGet",
    "runSettingsSet",
    "runSettingsReset",
    "runDistilStatus",
    "runDistilRetryDlq",
  ]) {
    assert.equal(
      (mod as Record<string, unknown>)[removed],
      undefined,
      `${removed} must be removed`
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
    assert.equal(typeof (mod as Record<string, unknown>)[live], "function", `${live} must exist`);
  }

  const captured: Array<{ name: string; sub: string[] }> = [];
  type Fake = {
    name: string;
    sub: string[];
    description: () => Fake;
    command: (name: string) => Fake;
    option: () => Fake;
    action: () => Fake;
  };
  function makeNode(name: string): Fake {
    const node: Fake = {
      name,
      sub: [],
      description: () => node,
      command(commandName: string) {
        node.sub.push(commandName);
        return makeNode(`${node.name}>${commandName}`);
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
  mod.registerMemory(root);
  const memory = captured.find((entry) => entry.name === "memory");
  assert.ok(memory);
  assert.deepEqual(memory.sub, ["l0", "l1", "l2", "l3", "list", "distillation-model", "dlq"]);
});

test("memory CLI source contains no removed v3 or invented route paths", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const source = fs.readFileSync(path.join(root, "bin/cli/commands/memory.mjs"), "utf8");
  for (const banned of [
    "/api/memory/l0/search",
    "/api/memory/l1/search",
    "/api/memory/list",
    "/api/memory/settings",
    "/api/memory/distil/",
  ]) {
    assert.doesNotMatch(source, new RegExp(banned.replaceAll("/", "\\/")));
  }
});

test("CLI memory commands sanitize error responses", async () => {
  const originalExit = process.exit;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderrText = "";
  process.stderr.write = (chunk: string | Uint8Array) => {
    if (typeof chunk === "string") stderrText += chunk;
    return true;
  };
  process.exit = ((code?: number) => {
    throw new Error(`__exit__${String(code)}`);
  }) as never;
  const restore = installFetch(() =>
    Promise.resolve(makeResp("Some failure\n    at /abs/path/foo.ts:1:1", 500))
  );
  try {
    const { runL0Search } = await import("../../bin/cli/commands/memory.mjs");
    await runL0Search("boom", { limit: "5" }, makeCmd() as never).catch(() => undefined);
    assert.doesNotMatch(stderrText, /at \/abs\/path/);
    assert.doesNotMatch(stderrText, /foo\.ts/);
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalWrite;
    restore();
  }
});
