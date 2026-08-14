/**
 * Unit tests for the L0 capture pipeline module.
 *
 * Covers:
 *   - Full >64KB extraction (no length cap on L0).
 *   - strip code blocks via local fallback.
 *   - Capture gate (no-memory header, internal marker, captureEnabled, combo).
 *   - ID stability (idempotency-derived hash).
 *   - Concurrency / failure isolation (setImmediate + fail-open).
 *   - Stream/nonstream capture hooks structurally (buildL0CaptureRecords).
 *   - L0 NEVER auto-injected (sanity: no return shape that injects).
 *   - No-memory header → owner null → gate rejects.
 *   - is_internal true → gate rejects.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildL0CaptureRecords,
  buildL0MessageId,
  createInMemoryL0Store,
  evaluateL0CaptureGate,
  extractLastVisibleAssistantText,
  extractLastVisibleUserText,
  noopL1Enqueuer,
  scheduleL0Capture,
  shouldCaptureComboResult,
  stripCodeBlocks,
  stripCodeBlocksLocal,
} from "../../src/memory/integration/l0Capture.ts";

describe("L0 — full >64KB extraction (no length cap)", () => {
  it("extracts the last user text without truncating, even past 64KB", () => {
    const big = "x".repeat(200_000);
    const body = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: big },
      ],
    };
    assert.equal(extractLastVisibleUserText(body), big);
    assert.equal(extractLastVisibleUserText(body).length, 200_000);
  });

  it("extracts the last user text from Responses-style input[]", () => {
    const body = {
      input: [{ role: "user", type: "message", content: [{ type: "input_text", text: "hello" }] }],
    };
    assert.equal(extractLastVisibleUserText(body), "hello");
  });

  it("skips assistant messages when scanning for the last user text", () => {
    const body = {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "no" },
        { role: "user", content: "second" },
      ],
    };
    assert.equal(extractLastVisibleUserText(body), "second");
  });

  it("skips non-user input types (reasoning, tool_call, etc.)", () => {
    const body = {
      input: [
        { type: "reasoning", content: "thinking" },
        { role: "user", type: "message", content: "user text" },
      ],
    };
    assert.equal(extractLastVisibleUserText(body), "user text");
  });

  it("returns '' for null/undefined/non-object bodies", () => {
    assert.equal(extractLastVisibleUserText(null), "");
    assert.equal(extractLastVisibleUserText(undefined), "");
    assert.equal(extractLastVisibleUserText({}), "");
  });
});

describe("L0 — assistant snapshot extraction", () => {
  it("reads OpenAI choices[0].message.content", () => {
    assert.equal(
      extractLastVisibleAssistantText({ choices: [{ message: { content: " hi  " } }] }),
      " hi  "
    );
  });

  it("reads Anthropic content[] text blocks", () => {
    const out = extractLastVisibleAssistantText({
      content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
    });
    assert.equal(out, "a\nb");
  });

  it("falls back to Responses output_text", () => {
    assert.equal(extractLastVisibleAssistantText({ output_text: " out " }), " out ");
  });

  it("prefers OpenAI content over Responses output_text", () => {
    const out = extractLastVisibleAssistantText({
      choices: [{ message: { content: "openai" } }],
      output_text: "responses",
    });
    assert.equal(out, "openai");
  });

  it("returns '' for empty/no-text shapes", () => {
    assert.equal(extractLastVisibleAssistantText(null), "");
    assert.equal(extractLastVisibleAssistantText({}), "");
    assert.equal(extractLastVisibleAssistantText({ content: [{ type: "image" }] }), "");
  });
});

describe("L0 — stripCodeBlocksLocal (pure fallback)", () => {
  it("strips a single outer fence", () => {
    assert.equal(stripCodeBlocksLocal('```json\n{"ok":true}\n```'), '{"ok":true}');
  });

  it("leaves text alone when no outer fence", () => {
    assert.equal(stripCodeBlocksLocal("plain text"), "plain text");
  });

  it("returns non-strings unchanged", () => {
    // @ts-expect-error - non-string is intentionally passed.
    assert.equal(stripCodeBlocksLocal(123), 123);
    // @ts-expect-error - non-string is intentionally passed.
    assert.equal(stripCodeBlocksLocal(null), null);
  });

  it("strips only the outer fence, leaves nested fences intact", () => {
    const input = "```\n```js\ninner\n```\n```";
    const out = stripCodeBlocksLocal(input);
    assert.equal(out, "```js\ninner\n```");
  });
});

describe("L0 — Tencent sanitizer integration", () => {
  it("removes an embedded fenced block through the shipped Tencent helper", async () => {
    const input = "visible before\n```ts\nconst secret = 1;\n```\nvisible after";
    assert.deepEqual(await stripCodeBlocks(input), {
      text: "visible before\n\nvisible after",
      stripped: true,
    });
  });
});

describe("L0 — capture gate", () => {
  it("rejects when no owner (no-memory header or anonymous)", () => {
    const r = evaluateL0CaptureGate({
      ownerId: null,
      isInternal: false,
      captureEnabled: true,
      isCombo: false,
      comboExecutionKey: null,
      comboStepId: null,
    });
    assert.equal(r.shouldCapture, false);
    assert.equal(r.reason, "no-memory-header-or-no-owner");
  });

  it("rejects when is_internal is true", () => {
    const r = evaluateL0CaptureGate({
      ownerId: "k",
      isInternal: true,
      captureEnabled: true,
      isCombo: false,
      comboExecutionKey: null,
      comboStepId: null,
    });
    assert.equal(r.shouldCapture, false);
    assert.equal(r.reason, "internal-marker");
  });

  it("rejects when captureEnabled=false", () => {
    const r = evaluateL0CaptureGate({
      ownerId: "k",
      isInternal: false,
      captureEnabled: false,
      isCombo: false,
      comboExecutionKey: null,
      comboStepId: null,
    });
    assert.equal(r.shouldCapture, false);
    assert.equal(r.reason, "capture-disabled");
  });

  it("rejects combo subrequests (conservative)", () => {
    const r = evaluateL0CaptureGate({
      ownerId: "k",
      isInternal: false,
      captureEnabled: true,
      isCombo: true,
      comboExecutionKey: "combo-1",
      comboStepId: "step-1",
    });
    assert.equal(r.shouldCapture, false);
    assert.equal(r.reason, "combo-subrequest-skipped");
  });

  it("allows direct requests when all gates pass", () => {
    const r = evaluateL0CaptureGate({
      ownerId: "k",
      isInternal: false,
      captureEnabled: true,
      isCombo: false,
      comboExecutionKey: null,
      comboStepId: null,
    });
    assert.equal(r.shouldCapture, true);
    assert.equal(r.reason, null);
  });
});

describe("shouldCaptureComboResult — explicit combo-final helper", () => {
  it("returns true for non-combo requests (direct requests always allowed)", () => {
    assert.equal(
      shouldCaptureComboResult({
        isCombo: false,
        comboExecutionKey: null,
        comboStepId: null,
      }),
      true
    );
  });

  it("returns false for combo subrequests (no final-target flag yet)", () => {
    assert.equal(
      shouldCaptureComboResult({
        isCombo: true,
        comboExecutionKey: "ck",
        comboStepId: "cs",
      }),
      false
    );
  });
});

describe("L0 — stable idempotency-derived IDs", () => {
  it("builds the same id for identical inputs (stable)", () => {
    const id1 = buildL0MessageId({
      ownerId: "k1",
      sessionId: "s1",
      correlationId: "c1",
      role: "user",
      content: "hi",
    });
    const id2 = buildL0MessageId({
      ownerId: "k1",
      sessionId: "s1",
      correlationId: "c1",
      role: "user",
      content: "hi",
    });
    assert.equal(id1, id2);
  });

  it("different role => different id", () => {
    const a = buildL0MessageId({
      ownerId: "k",
      sessionId: "s",
      correlationId: null,
      role: "user",
      content: "x",
    });
    const b = buildL0MessageId({
      ownerId: "k",
      sessionId: "s",
      correlationId: null,
      role: "assistant",
      content: "x",
    });
    assert.notEqual(a, b);
  });

  it("provided idempotency key wins when present", () => {
    const id = buildL0MessageId({
      ownerId: "k",
      sessionId: "s",
      correlationId: "c",
      role: "user",
      content: "x",
      providedIdempotencyKey: "abc-123",
    });
    assert.ok(id.startsWith("l0_abc-123"));
  });

  it("ids start with l0_", () => {
    const id = buildL0MessageId({
      ownerId: "k",
      sessionId: "s",
      correlationId: null,
      role: "user",
      content: "x",
    });
    assert.ok(id.startsWith("l0_"));
  });
});

describe("L0 — buildL0CaptureRecords", () => {
  it("returns [] when no user text and no assistant text", () => {
    assert.deepEqual(
      buildL0CaptureRecords({
        ownerId: "k",
        sessionId: "s",
        correlationId: null,
        comboExecutionKey: null,
        requestBody: {},
        responseBody: {},
        source: "chat",
        provider: "openai",
        model: "gpt-4o",
      }),
      []
    );
  });

  it("inserts two messages: user + assistant", () => {
    const records = buildL0CaptureRecords({
      ownerId: "k1",
      sessionId: "s1",
      correlationId: "corr-1",
      comboExecutionKey: "combo-1",
      requestBody: { messages: [{ role: "user", content: "hi there" }] },
      responseBody: { choices: [{ message: { content: "hello" } }] },
      source: "chat",
      provider: "openai",
      model: "gpt-4o",
    });
    assert.equal(records.length, 2);
    assert.equal(records[0].role, "user");
    assert.equal(records[1].role, "assistant");
    assert.equal(records[0].ownerId, "k1");
    assert.equal(records[0].sessionId, "s1");
    assert.equal(records[0].metadata.user_id, "k1");
    assert.equal(records[0].metadata.is_internal, false);
    assert.equal(records[0].metadata.correlation_id, "corr-1");
    assert.equal(records[0].metadata.combo_execution_key, "combo-1");
    assert.equal(records[0].metadata.provider, "openai");
    assert.equal(records[0].metadata.model, "gpt-4o");
  });

  it("assistant content has outer code fence stripped (local fallback)", () => {
    const records = buildL0CaptureRecords({
      ownerId: "k",
      sessionId: "s",
      correlationId: null,
      comboExecutionKey: null,
      requestBody: { messages: [{ role: "user", content: "u" }] },
      responseBody: { choices: [{ message: { content: '```json\n{"k":"v"}\n```' } }] },
      source: "chat",
      provider: null,
      model: null,
    });
    assert.equal(records.length, 2);
    assert.equal(records[1].content, '{"k":"v"}');
  });

  it("nonstream path uses the response snapshot (no client/tool content)", () => {
    const records = buildL0CaptureRecords({
      ownerId: "k",
      sessionId: "s",
      correlationId: null,
      comboExecutionKey: null,
      requestBody: { messages: [{ role: "user", content: "u" }] },
      responseBody: { choices: [{ message: { content: "final assistant text" } }] },
      source: "chat",
      provider: "anthropic",
      model: "claude-3-5",
    });
    assert.equal(records[1].content, "final assistant text");
  });

  it("stream path uses the assembled streamResponseBody snapshot", () => {
    const records = buildL0CaptureRecords({
      ownerId: "k",
      sessionId: "s",
      correlationId: "st",
      comboExecutionKey: null,
      requestBody: { messages: [{ role: "user", content: "u" }] },
      responseBody: { choices: [{ message: { content: "stream final" } }] },
      source: "stream",
      provider: "anthropic",
      model: "claude-3-5",
    });
    assert.equal(records[1].content, "stream final");
    assert.equal(records[0].metadata.source, "stream");
  });

  it("stable IDs across two builds (idempotent)", () => {
    const args = {
      ownerId: "k",
      sessionId: "s",
      correlationId: "c",
      comboExecutionKey: null,
      requestBody: { messages: [{ role: "user", content: "hi" }] },
      responseBody: { choices: [{ message: { content: "ho" } }] },
      source: "chat",
      provider: null,
      model: null,
    } as const;
    const r1 = buildL0CaptureRecords(args);
    const r2 = buildL0CaptureRecords(args);
    assert.equal(r1[0].id, r2[0].id);
    assert.equal(r1[1].id, r2[1].id);
  });
});

describe("L0 — scheduleL0Capture (fail-open async)", () => {
  it("does not throw when records are empty", () => {
    assert.doesNotThrow(() => {
      scheduleL0Capture([], {
        store: createInMemoryL0Store(),
        enqueueL1: noopL1Enqueuer,
      });
    });
  });

  it("does not throw when the store throws", () => {
    const throwingStore = {
      insert: () => {
        throw new Error("db down");
      },
      insertMany: () => {
        throw new Error("db down");
      },
    };
    assert.doesNotThrow(() => {
      scheduleL0Capture(
        [
          {
            id: "l0_x",
            ownerId: "k",
            sessionId: "s",
            role: "user",
            content: "u",
            metadata: {
              session_key: "s",
              pipelineSessionId: "s",
              user_id: "k",
              role: "user",
              source: "chat",
              timestamp: new Date().toISOString(),
              correlation_id: null,
              combo_execution_key: null,
              is_internal: false,
              provider: null,
              model: null,
            },
            createdAt: new Date().toISOString(),
          },
        ],
        { store: throwingStore, enqueueL1: noopL1Enqueuer }
      );
    });
  });

  it("writes records asynchronously (after setImmediate)", async () => {
    const store = createInMemoryL0Store();
    scheduleL0Capture(
      [
        {
          id: "l0_async",
          ownerId: "k",
          sessionId: "s",
          role: "user",
          content: "u",
          metadata: {
            session_key: "s",
            pipelineSessionId: "s",
            user_id: "k",
            role: "user",
            source: "chat",
            timestamp: new Date().toISOString(),
            correlation_id: null,
            combo_execution_key: null,
            is_internal: false,
            provider: null,
            model: null,
          },
          createdAt: new Date().toISOString(),
        },
      ],
      { store, enqueueL1: noopL1Enqueuer }
    );
    // Synchronous return — store should NOT have the record yet.
    assert.equal(store.records.length, 0);
    // After a setImmediate tick, the record should be present.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.records.length, 1);
  });

  it("uses insertMany when the store provides it", async () => {
    let called = false;
    const bulk = {
      insert() {
        throw new Error("insert should not be called");
      },
      insertMany() {
        called = true;
      },
    };
    scheduleL0Capture(
      [
        {
          id: "l0_b",
          ownerId: "k",
          sessionId: "s",
          role: "user",
          content: "u",
          metadata: {
            session_key: "s",
            pipelineSessionId: "s",
            user_id: "k",
            role: "user",
            source: "chat",
            timestamp: new Date().toISOString(),
            correlation_id: null,
            combo_execution_key: null,
            is_internal: false,
            provider: null,
            model: null,
          },
          createdAt: new Date().toISOString(),
        },
      ],
      { store: bulk, enqueueL1: noopL1Enqueuer }
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, true);
  });
});

describe("L0 — never auto-injected (shape sanity)", () => {
  it("buildL0CaptureRecords returns only L0 records, not injection shapes", () => {
    const records = buildL0CaptureRecords({
      ownerId: "k",
      sessionId: "s",
      correlationId: null,
      comboExecutionKey: null,
      requestBody: { messages: [{ role: "user", content: "hi" }] },
      responseBody: { choices: [{ message: { content: "hello" } }] },
      source: "chat",
      provider: "openai",
      model: "gpt-4o",
    });
    for (const r of records) {
      // records are PURE L0 capture records; the renderer (separate module) injects them
      assert.ok(r.id.startsWith("l0_"));
      assert.ok(["user", "assistant"].includes(r.role));
      assert.equal(typeof r.content, "string");
    }
  });
});
