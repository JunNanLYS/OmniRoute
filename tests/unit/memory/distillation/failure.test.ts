import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure,
  decideRetry,
  sanitizeMessage,
  extractStatusCode,
  isNetworkError,
  MAX_STORED_ERROR_LENGTH,
} from "../../../../src/memory/distillation/failure.ts";
import { MAX_RETRY_ATTEMPTS } from "../../../../src/memory/distillation/scheduler.ts";

describe("distillation/failure — classifyFailure", () => {
  it("returns retry_429 for HTTP 429", () => {
    const f = classifyFailure({ status: 429, message: "rate limited" });
    assert.equal(f.kind, "retry_429");
    assert.equal(f.retryable, true);
  });

  it("returns retry_5xx for 503", () => {
    const f = classifyFailure({ status: 503, message: "unavailable" });
    assert.equal(f.kind, "retry_5xx");
    assert.equal(f.retryable, true);
  });

  it("returns retry_network for ECONNRESET", () => {
    const f = classifyFailure({ code: "ECONNRESET", message: "socket hang up" });
    assert.equal(f.kind, "retry_network");
    assert.equal(f.retryable, true);
  });

  it("returns no_retry_4xx + model_lockout for HTTP 400/401/403/404", () => {
    for (const s of [400, 401, 403, 404]) {
      const f = classifyFailure({ status: s, message: `http ${s}` });
      assert.equal(f.kind, "no_retry_4xx");
      assert.equal(f.retryable, false);
      assert.equal(f.triggersModelLockout, true);
    }
  });

  it("returns budget_exceeded for BUDGET_EXCEEDED code (no retry)", () => {
    const f = classifyFailure({ code: "BUDGET_EXCEEDED", message: "too big" });
    assert.equal(f.kind, "budget_exceeded");
    assert.equal(f.retryable, false);
  });

  it("returns parse_failed for PARSE_FAILED code (no retry)", () => {
    const f = classifyFailure({ code: "PARSE_FAILED", message: "no json" });
    assert.equal(f.kind, "parse_failed");
    assert.equal(f.retryable, false);
  });

  it("returns model_unset for MODEL_UNSET (no retry)", () => {
    const f = classifyFailure({ code: "MODEL_UNSET", message: "" });
    assert.equal(f.kind, "model_unset");
  });

  it("returns model_deleted + lockout for MODEL_DELETED", () => {
    const f = classifyFailure({ code: "MODEL_DELETED", message: "" });
    assert.equal(f.kind, "model_deleted");
    assert.equal(f.triggersModelLockout, true);
  });

  it("returns credentials_invalid for CREDENTIALS_INVALID (no retry)", () => {
    const f = classifyFailure({ code: "CREDENTIALS_INVALID", message: "" });
    assert.equal(f.kind, "credentials_invalid");
    assert.equal(f.retryable, false);
  });

  it("extracts the status from common shapes", () => {
    assert.equal(extractStatusCode({ status: 429 }), 429);
    assert.equal(extractStatusCode({ statusCode: 503 }), 503);
    assert.equal(extractStatusCode({ response: { status: 502 } }), 502);
    assert.equal(extractStatusCode({ code: "HTTP_404" }), 404);
    assert.equal(extractStatusCode({ message: "nope" }), null);
  });

  it("detects network-class errors", () => {
    assert.equal(isNetworkError({ code: "ETIMEDOUT" }), true);
    assert.equal(isNetworkError({ name: "AbortError" }), true);
    assert.equal(isNetworkError({ message: "request timeout" }), true);
    assert.equal(isNetworkError({ message: "totally normal" }), false);
  });

  it("falls back to no_retry_4xx for unknown errors (conservative)", () => {
    const f = classifyFailure({ message: "what is this?" });
    assert.equal(f.kind, "no_retry_4xx");
    assert.equal(f.retryable, false);
  });
});

describe("distillation/failure — decideRetry", () => {
  it("retries a retryable failure up to MAX_RETRY_ATTEMPTS times", () => {
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      const f = classifyFailure({ status: 429, message: "x" });
      const d = decideRetry(f, attempt);
      assert.equal(d.retry, true);
      assert.equal(d.nextAttempt, attempt + 1);
      assert.ok(d.backoffMs > 0);
    }
  });

  it("DLQs after MAX_RETRY_ATTEMPTS exhausted", () => {
    const f = classifyFailure({ status: 429, message: "x" });
    const d = decideRetry(f, MAX_RETRY_ATTEMPTS);
    assert.equal(d.retry, false);
    assert.equal(d.dlq, true);
    assert.equal(d.dlqKind, "retry_exhausted");
  });

  it("DLQs immediately for non-retryable failure kinds", () => {
    const f = classifyFailure({ code: "PARSE_FAILED", message: "x" });
    const d = decideRetry(f, 0);
    assert.equal(d.retry, false);
    assert.equal(d.dlqKind, "parse_failed");
  });
});

describe("distillation/failure — sanitizeMessage", () => {
  it("strips stack frames", () => {
    const out = sanitizeMessage("boom at /workspace/repo/src/x.ts:1:1\n  at fn");
    assert.ok(!/at\s+\//.test(out));
  });

  it("redacts Bearer tokens", () => {
    const out = sanitizeMessage("Authorization: Bearer abc.def.ghi==");
    assert.ok(!/abc\.def\.ghi/.test(out));
    assert.ok(/Bearer <redacted>/.test(out));
  });

  it("redacts api_key / access_token assignments", () => {
    const out = sanitizeMessage("api_key=sk-1234567890abcdef");
    assert.ok(!/sk-1234567890/.test(out));
  });

  it("redacts filesystem paths", () => {
    const out = sanitizeMessage("Cannot read /home/me/.omniroute/storage.sqlite");
    assert.ok(!/home\/me/.test(out));
  });

  it("caps length", () => {
    const huge = "x".repeat(MAX_STORED_ERROR_LENGTH + 100);
    const out = sanitizeMessage(huge);
    assert.ok(out.length <= MAX_STORED_ERROR_LENGTH + 1);
  });
});
