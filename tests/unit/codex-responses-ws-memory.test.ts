import test from "node:test";
import assert from "node:assert/strict";

import {
  extractResponsesWsMemoryQuery,
  injectResponsesWsLayeredMemory,
  injectResponsesWsMemoryInstructions,
} from "../../src/app/api/internal/codex-responses-ws/route.ts";

test("Responses WS memory query uses the latest user text and skips tool/reasoning items", () => {
  const query = extractResponsesWsMemoryQuery({
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "old question" }],
      },
      {
        type: "reasoning",
        content: [{ type: "output_text", text: "do not retrieve from this" }],
      },
      {
        type: "function_call_output",
        output: "do not retrieve from tool output",
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "latest question" },
          { type: "input_text", text: "with detail" },
        ],
      },
    ],
    instructions: "fallback instructions",
  });

  assert.equal(query, "latest question\nwith detail");
});

test("Responses WS memory query falls back to prompt or instructions", () => {
  assert.equal(extractResponsesWsMemoryQuery({ prompt: "  prompt text  " }), "prompt text");
  assert.equal(
    extractResponsesWsMemoryQuery({ instructions: "  instruction text  " }),
    "instruction text"
  );
});

test("Responses WS four-layer injection uses owner-scoped recall and Responses input", async () => {
  const calls: Array<{ ownerId: string; sessionId: string; query: string }> = [];
  const request = {
    model: "gpt-5.5",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "latest question" }],
      },
    ],
  };

  const result = await injectResponsesWsLayeredMemory(request, "owner-1", {
    async resolveSettings(ownerId) {
      assert.equal(ownerId, "owner-1");
      return {
        captureEnabled: false,
        injectionEnabled: true,
        l3CharBudget: 600,
        l2CharBudget: 600,
        l1CharBudget: 600,
        totalCharBudget: 8000,
        recallTimeoutMs: 5000,
      };
    },
    async recall(input) {
      calls.push(input);
      return {
        layers: {
          l3: [{ id: "p1", title: "Persona", content: "Concise builder" }],
          l2: [{ id: "s1", title: "Current", summary: "Memory cutover" }],
          l1: [{ id: "m1", content: "Prefers tests first", score: 1, tags: [] }],
          toolsGuide: "Reference memory tools only.",
        },
        l1Status: "ok",
        l2Status: "ok",
        l3Status: "ok",
      };
    },
  });

  assert.deepEqual(calls, [{ ownerId: "owner-1", sessionId: "shared", query: "latest question" }]);
  const input = result.input as Array<{ role?: string; content?: unknown }>;
  assert.equal(input[0]?.role, "system");
  assert.match(JSON.stringify(input), /Concise builder/);
  assert.match(JSON.stringify(input), /Memory cutover/);
  assert.match(JSON.stringify(input), /Prefers tests first/);
});

test("Responses WS four-layer injection skips recall when disabled", async () => {
  let recallCalls = 0;
  const request = { input: [{ role: "user", content: "hello" }] };
  const result = await injectResponsesWsLayeredMemory(request, "owner-1", {
    async resolveSettings() {
      return {
        captureEnabled: false,
        injectionEnabled: false,
        l3CharBudget: 600,
        l2CharBudget: 600,
        l1CharBudget: 600,
        totalCharBudget: 8000,
        recallTimeoutMs: 5000,
      };
    },
    async recall() {
      recallCalls++;
      throw new Error("must not run");
    },
  });

  assert.equal(result, request);
  assert.equal(recallCalls, 0);
});

test("Responses WS route has no legacy memory runtime imports", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const source = fs.readFileSync(
    path.join(root, "src/app/api/internal/codex-responses-ws/route.ts"),
    "utf8"
  );
  assert.doesNotMatch(source, /@\/lib\/memory\//);
});

test("Responses WS memory injection prepends memory to instructions without mutating input", () => {
  const request = {
    model: "gpt-5.5",
    instructions: "follow the user request",
    input: "hello",
  };

  const result = injectResponsesWsMemoryInstructions(
    request,
    "Memory context: user prefers concise replies"
  );

  assert.notEqual(result, request);
  assert.equal(request.instructions, "follow the user request");
  assert.equal(
    result.instructions,
    "Memory context: user prefers concise replies\n\nfollow the user request"
  );
});

test("Responses WS memory injection does not duplicate an existing memory block", () => {
  const request = {
    model: "gpt-5.5",
    instructions: "Memory context: existing\n\nfollow the user request",
  };

  const result = injectResponsesWsMemoryInstructions(request, "Memory context: duplicate");

  assert.equal(result, request);
  assert.equal(result.instructions, "Memory context: existing\n\nfollow the user request");
});
