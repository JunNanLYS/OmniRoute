import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("memory-combo-capture");
const {
  buildOpenAIResponse,
  buildRequest,
  combosDb,
  handleChat,
  resetStorage,
  seedApiKey,
  seedConnection,
} = harness;

const memoryCore = await import("../../src/memory/db/core.ts");
const l0 = await import("../../src/memory/l0.ts");
const memoryRuntime = await import("../../src/memory/integration/runtime.ts");
const memorySettings = await import("../../src/memory/integration/settings.ts");

function resetMemoryDb(): void {
  memoryCore.resetMemoryDbInstance();
  const filePath = memoryCore.getMemoryDbFilePath();
  if (filePath === ":memory:") return;
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]) {
    try {
      fs.unlinkSync(candidate);
    } catch {
      // File may not exist yet.
    }
  }
}

function enableCaptureFor(ownerId: string): void {
  memorySettings.setMemoryPipelineSettingsResolver((resolvedOwnerId) => ({
    ...memorySettings.DEFAULT_MEMORY_PIPELINE_SETTINGS,
    captureEnabled: resolvedOwnerId === ownerId,
  }));
}

function listSessionRows(ownerId: string, sessionId: string) {
  return l0.listMessages({
    owner: memoryRuntime.ownerFromApiKeyId(ownerId),
    sessionId,
  });
}

async function waitForSessionRows(ownerId: string, sessionId: string, count: number) {
  let rows = listSessionRows(ownerId, sessionId);
  for (let attempt = 0; attempt < 80 && rows.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = listSessionRows(ownerId, sessionId);
  }
  return rows;
}

function buildOpenAIStreamResponse(text: string): Response {
  return new Response(
    [
      `data: ${JSON.stringify({
        id: "chatcmpl_combo_stream",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: text } }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl_combo_stream",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );
}

function buildSplitUtf8StreamResponse(text: string): { response: Response; bytes: Uint8Array } {
  const raw = [
    `data: ${JSON.stringify({
      id: "chatcmpl_combo_stream_utf8",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: text } }],
    })}`,
    "",
    `data: ${JSON.stringify({
      id: "chatcmpl_combo_stream_utf8",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const bytes = new TextEncoder().encode(raw);
  const multibyte = new TextEncoder().encode("汉");
  const boundary = bytes.findIndex(
    (_, index) =>
      bytes[index] === multibyte[0] &&
      bytes[index + 1] === multibyte[1] &&
      bytes[index + 2] === multibyte[2]
  );
  assert.ok(boundary >= 0);
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, boundary + 1));
        controller.enqueue(bytes.slice(boundary + 1, boundary + 2));
        controller.enqueue(bytes.slice(boundary + 2));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
  return { response, bytes };
}

test.beforeEach(async () => {
  memorySettings.resetMemoryPipelineSettingsResolverForTests();
  resetMemoryDb();
  await resetStorage();
});

test.afterEach(async () => {
  memorySettings.resetMemoryPipelineSettingsResolverForTests();
  resetMemoryDb();
  await resetStorage();
});

test.after(async () => {
  memorySettings.resetMemoryPipelineSettingsResolverForTests();
  resetMemoryDb();
  await harness.cleanup();
});

test("combo failover captures only the final JSON result", async () => {
  const apiKey = await seedApiKey({ name: "memory-combo-json-owner" });
  enableCaptureFor(apiKey.id);
  await seedConnection("openai", { apiKey: "sk-memory-combo-openai" });
  await seedConnection("deepseek", { apiKey: "sk-memory-combo-deepseek" });
  await combosDb.createCombo({
    name: "memory-final-json",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    models: ["openai/gpt-4.1", "deepseek/deepseek-v4-flash"],
  });

  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: { message: "first target failed" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return buildOpenAIResponse("final combo JSON", "deepseek/deepseek-v4-flash");
  };

  const response = await handleChat(
    buildRequest({
      authKey: apiKey.key,
      body: {
        model: "memory-final-json",
        stream: false,
        messages: [{ role: "user", content: "route this once" }],
      },
    })
  );
  const sessionId = response.headers.get("X-OmniRoute-Session-Id");
  assert.ok(sessionId);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(listSessionRows(apiKey.id, sessionId), []);

  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.equal(
    (payload.choices as Array<{ message: { content: string } }>)[0]?.message.content,
    "final combo JSON"
  );

  const rows = await waitForSessionRows(apiKey.id, sessionId, 2);
  assert.deepEqual(
    rows.map((row) => [row.role, row.content]),
    [
      ["user", "route this once"],
      ["assistant", "final combo JSON"],
    ]
  );
});

test("combo SSE capture preserves the client stream and stores one final result", async () => {
  const apiKey = await seedApiKey({ name: "memory-combo-stream-owner" });
  enableCaptureFor(apiKey.id);
  await seedConnection("openai", { apiKey: "sk-memory-combo-stream" });
  await combosDb.createCombo({
    name: "memory-final-stream",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: ["openai/gpt-4.1"],
  });

  globalThis.fetch = async () => buildOpenAIStreamResponse("final combo stream");

  const response = await handleChat(
    buildRequest({
      authKey: apiKey.key,
      body: {
        model: "memory-final-stream",
        stream: true,
        messages: [{ role: "user", content: "stream this once" }],
      },
    })
  );
  const sessionId = response.headers.get("X-OmniRoute-Session-Id");
  assert.ok(sessionId);
  assert.equal(response.bodyUsed, false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(listSessionRows(apiKey.id, sessionId), []);

  const raw = await response.text();
  assert.match(raw, /final combo stream/);
  assert.match(raw, /data: \[DONE\]/);

  const rows = await waitForSessionRows(apiKey.id, sessionId, 2);
  assert.deepEqual(
    rows.map((row) => [row.role, row.content]),
    [
      ["user", "stream this once"],
      ["assistant", "final combo stream"],
    ]
  );
});

test("combo SSE capture preserves UTF-8 split across byte chunks", async () => {
  const apiKey = await seedApiKey({ name: "memory-combo-utf8-owner" });
  enableCaptureFor(apiKey.id);
  await seedConnection("openai", { apiKey: "sk-memory-combo-utf8" });
  await combosDb.createCombo({
    name: "memory-final-utf8",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: ["openai/gpt-4.1"],
  });

  const assistantText = "最终汉字与 emoji 🚀";
  globalThis.fetch = async () => buildSplitUtf8StreamResponse(assistantText).response;

  const response = await handleChat(
    buildRequest({
      authKey: apiKey.key,
      body: {
        model: "memory-final-utf8",
        stream: true,
        messages: [{ role: "user", content: "preserve split bytes" }],
      },
    })
  );
  const sessionId = response.headers.get("X-OmniRoute-Session-Id");
  assert.ok(sessionId);

  const clientBytes = new Uint8Array(await response.arrayBuffer());
  const raw = new TextDecoder().decode(clientBytes);
  assert.match(raw, new RegExp(assistantText));
  assert.match(raw, /data: \[DONE\]/);
  assert.doesNotMatch(raw, /�/);

  const rows = await waitForSessionRows(apiKey.id, sessionId, 2);
  assert.equal(rows.find((row) => row.role === "assistant")?.content, assistantText);
  assert.doesNotMatch(rows.find((row) => row.role === "assistant")?.content ?? "", /�/);
});
