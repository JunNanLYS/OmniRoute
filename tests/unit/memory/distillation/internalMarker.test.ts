import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  signInternalMarker,
  verifyInternalMarker,
  verifyLoopbackOrigin,
  INTERNAL_MARKER_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_DEPTH_HEADER,
  INTERNAL_CALLS_HEADER,
} from "../../../../src/memory/distillation/internalMarker.ts";

function getSecret(seed = 1): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i++) out[i] = (seed + i) & 0xff;
  return out;
}

describe("distillation/internalMarker — sign/verify round-trip", () => {
  it("produces a marker that verifies under the same secret", () => {
    const secret = getSecret();
    const { parts, headers } = signInternalMarker(secret, {
      depth: 0,
      callsRemaining: 10,
      nowMs: 1_000_000,
    });
    const result = verifyInternalMarker(secret, headers, {
      maxDepth: 5,
      maxCalls: 10,
      nowMs: 1_000_000,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.depth, parts.depth);
      assert.equal(result.callsRemaining, parts.callsRemaining);
    }
  });

  it("rejects a forged marker (different secret)", () => {
    const secret = getSecret();
    const { headers } = signInternalMarker(secret, { depth: 0, callsRemaining: 10, nowMs: 1 });
    const result = verifyInternalMarker(getSecret(99), headers, {
      maxDepth: 5,
      maxCalls: 10,
      nowMs: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "bad_signature");
  });

  it("rejects a marker past its TTL", () => {
    const secret = getSecret();
    const { headers } = signInternalMarker(secret, { depth: 0, callsRemaining: 10, nowMs: 1 });
    const result = verifyInternalMarker(secret, headers, {
      maxDepth: 5,
      maxCalls: 10,
      nowMs: 100_000,
      ttlMs: 30_000,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "expired");
  });

  it("rejects a marker with no X-Omniroute-No-Memory flag", () => {
    const secret = getSecret();
    const headers: Record<string, string> = {};
    const result = verifyInternalMarker(secret, headers, { maxDepth: 5, maxCalls: 10 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "missing");
  });

  it("rejects a depth that exceeds the cap", () => {
    const secret = getSecret();
    const { headers } = signInternalMarker(secret, { depth: 10, callsRemaining: 10, nowMs: 1 });
    const result = verifyInternalMarker(secret, headers, { maxDepth: 5, maxCalls: 10, nowMs: 1 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "depth_exceeded");
  });

  it("rejects when nested calls are exhausted", () => {
    const secret = getSecret();
    const { headers } = signInternalMarker(secret, { depth: 1, callsRemaining: 0, nowMs: 1 });
    const result = verifyInternalMarker(secret, headers, { maxDepth: 5, maxCalls: 10, nowMs: 1 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "calls_exhausted");
  });

  it("emits the canonical header names", () => {
    const secret = getSecret();
    const { headers } = signInternalMarker(secret);
    assert.equal(headers[INTERNAL_MARKER_HEADER], "true");
    assert.ok(headers[INTERNAL_SIGNATURE_HEADER]);
    assert.ok(INTERNAL_DEPTH_HEADER in headers);
    assert.ok(INTERNAL_CALLS_HEADER in headers);
  });
});

describe("distillation/internalMarker — verifyLoopbackOrigin", () => {
  it("accepts 127.0.0.1", () => {
    const v = verifyLoopbackOrigin("127.0.0.1", {}, []);
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.reason, "loopback_ip");
  });
  it("accepts ::1 and ::ffff:127.0.0.1", () => {
    assert.equal(verifyLoopbackOrigin("::1", {}, []).ok, true);
    assert.equal(verifyLoopbackOrigin("::ffff:127.0.0.1", {}, []).ok, true);
  });
  it("rejects an untrusted remote address", () => {
    const v = verifyLoopbackOrigin("203.0.113.1", {}, []);
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "untrusted_origin");
  });
  it("accepts a trusted loopback token when no IP is present", () => {
    const v = verifyLoopbackOrigin(null, { "x-omniroute-loopback-token": "tok-1" }, ["tok-1"]);
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.reason, "trusted_loopback_token");
  });
});
