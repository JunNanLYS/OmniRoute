/**
 * Tests for the L1 dedup decision parser and the L2 scene-action parser.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseL1DedupResponse,
  parseSceneExtractionResponse,
  isValidSceneFilename,
  SCENE_ACTION_PRIORITY,
  SCENE_BODY_MAX_CHARS,
  SCENE_DELETED_MARKER,
  recoverPersonaUpdateRequest,
  PERSONA_UPDATE_REQUEST_OPEN,
} from "../../../../src/memory/tencent/index.js";

describe("parseL1DedupResponse", () => {
  it("parses a mixed-action response", () => {
    const raw = JSON.stringify([
      {
        record_id: "r1",
        action: "store",
        target_ids: [],
      },
      {
        record_id: "r2",
        action: "merge",
        target_ids: ["old1", "old2"],
        merged_content: "merged",
        merged_type: "persona",
        merged_priority: 80,
        merged_timestamps: ["2026-01-01", "2026-02-01"],
      },
      {
        record_id: "r3",
        action: "skip",
      },
      {
        record_id: "r4",
        action: "update",
        target_ids: ["old3"],
        merged_content: "updated",
        merged_type: "episodic",
        merged_priority: 75,
        merged_timestamps: ["2026-03-01"],
      },
    ]);
    const out = parseL1DedupResponse(raw);
    assert.equal(out.length, 4);
    assert.equal(out[0]!.action, "store");
    assert.equal(out[1]!.action, "merge");
    assert.equal(out[1]!.target_ids.length, 2);
    assert.equal(out[1]!.merged_priority, 80);
    assert.equal(out[2]!.action, "skip");
    assert.equal(out[3]!.action, "update");
  });

  it("drops entries with invalid action", () => {
    const raw = JSON.stringify([
      { record_id: "r1", action: "delete" },
      { record_id: "r2", action: "store" },
    ]);
    const out = parseL1DedupResponse(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.action, "store");
  });

  it("drops entries with missing record_id", () => {
    const raw = JSON.stringify([{ action: "store" }, { record_id: "r1", action: "skip" }]);
    const out = parseL1DedupResponse(raw);
    assert.equal(out.length, 1);
  });

  it("clamps priority to [0, 100]", () => {
    const raw = JSON.stringify([
      { record_id: "r1", action: "merge", target_ids: ["t"], merged_priority: 999 },
      { record_id: "r2", action: "merge", target_ids: ["t"], merged_priority: -10 },
      { record_id: "r3", action: "merge", target_ids: ["t"], merged_priority: "75" },
    ]);
    const out = parseL1DedupResponse(raw);
    assert.equal(out[0]!.merged_priority, 100);
    assert.equal(out[1]!.merged_priority, 0);
    assert.equal(out[2]!.merged_priority, 75);
  });

  it("leaves merged_* fields undefined for store/skip", () => {
    const raw = JSON.stringify([
      { record_id: "r1", action: "store", merged_content: "should be ignored" },
    ]);
    const out = parseL1DedupResponse(raw);
    assert.equal(out[0]!.merged_content, undefined);
  });

  it("filters target_ids to strings only", () => {
    const raw = JSON.stringify([
      { record_id: "r1", action: "merge", target_ids: ["a", 42, null, "b"] },
    ]);
    const out = parseL1DedupResponse(raw);
    assert.deepEqual(out[0]!.target_ids, ["a", "b"]);
  });

  it("returns [] when input is empty / non-JSON", () => {
    assert.deepEqual(parseL1DedupResponse(""), []);
    assert.deepEqual(parseL1DedupResponse("not json"), []);
  });
});

describe("parseSceneExtractionResponse", () => {
  it("sorts actions by UPDATE > MERGE > CREATE priority", () => {
    const raw = JSON.stringify([
      { action: "create", target: "NewScene.md", content: "body" },
      { action: "update", target: "Existing.md", content: "updated body" },
      {
        action: "merge",
        target: "Merged.md",
        sources: ["Old1.md", "Old2.md"],
        content: "merged body",
      },
    ]);
    const out = parseSceneExtractionResponse(raw);
    assert.equal(out.actions[0]!.kind, "update");
    assert.equal(out.actions[1]!.kind, "merge");
    assert.equal(out.actions[2]!.kind, "create");

    assert.equal(SCENE_ACTION_PRIORITY.update, 0);
    assert.equal(SCENE_ACTION_PRIORITY.merge, 1);
    assert.equal(SCENE_ACTION_PRIORITY.create, 2);
  });

  it("returns structured actions without file writes", () => {
    const raw = JSON.stringify([
      { action: "update", target: "Daily-Rhythm.md", content: "## update\nnew content" },
    ]);
    const out = parseSceneExtractionResponse(raw);
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0]!.kind, "update");
    assert.equal(out.actions[0]!.target, "Daily-Rhythm.md");
  });

  it("treats edit/rewrite as update", () => {
    const raw = JSON.stringify([
      { action: "edit", target: "A.md", content: "x" },
      { action: "rewrite", target: "B.md", content: "y" },
    ]);
    const out = parseSceneExtractionResponse(raw);
    assert.equal(out.actions.length, 2);
    assert.equal(out.actions[0]!.kind, "update");
    assert.equal(out.actions[1]!.kind, "update");
  });

  it("rejects invalid filenames (spaces, brackets, slashes)", () => {
    assert.equal(isValidSceneFilename("ok-name.md"), true);
    assert.equal(isValidSceneFilename("Has Space.md"), false);
    assert.equal(isValidSceneFilename("Has(Space).md"), false);
    assert.equal(isValidSceneFilename("path/traversal.md"), false);
    assert.equal(isValidSceneFilename("colon:test.md"), false);
    assert.equal(isValidSceneFilename("no_extension"), false);
    assert.equal(isValidSceneFilename("UPPER.MD"), true); // case-insensitive check on .md
  });

  it("drops invalid filenames and missing required fields", () => {
    const raw = JSON.stringify([
      { action: "update", target: "Bad Name.md", content: "x" }, // invalid name
      { action: "merge", target: "ok.md", sources: [], content: "x" }, // no sources
      { action: "create", target: "ok.md" }, // no content
      { action: "update", target: "ok.md", content: "x" }, // valid
    ]);
    const out = parseSceneExtractionResponse(raw);
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0]!.target, "ok.md");
  });

  it("truncates bodies to SCENE_BODY_MAX_CHARS by codepoint", () => {
    const big = "x".repeat(SCENE_BODY_MAX_CHARS + 100);
    const raw = JSON.stringify([{ action: "create", target: "Big.md", content: big }]);
    const out = parseSceneExtractionResponse(raw);
    const body = out.actions[0]!;
    if (body.kind === "create" || body.kind === "update" || body.kind === "merge") {
      // codepoint count
      assert.equal(Array.from(body.content).length, SCENE_BODY_MAX_CHARS);
    } else {
      assert.fail("expected update/merge/create");
    }
  });

  it("recovers a persona-update request from raw text", () => {
    const rawJson = JSON.stringify([]);
    const rawText = `before\n${PERSONA_UPDATE_REQUEST_OPEN}\nreason: cross-cutting insight\n${"[/PERSONA_UPDATE_REQUEST]"}\nafter`;
    const out = parseSceneExtractionResponse(rawJson, rawText);
    assert.ok(out.personaUpdateRequest);
    assert.match(out.personaUpdateRequest!.reason, /cross-cutting insight/);
  });

  it("returns no persona-update request when markers are absent", () => {
    const out = parseSceneExtractionResponse("[]", "no markers here");
    assert.equal(out.personaUpdateRequest, undefined);
  });

  it("preserves the SCENE_DELETED_MARKER constant", () => {
    assert.equal(SCENE_DELETED_MARKER, "[DELETED]");
  });

  it("handles code-fenced mermaid in content", () => {
    const raw = JSON.stringify([
      { action: "update", target: "A.md", content: "```mermaid\nflowchart TD\n  A-->B\n```" },
    ]);
    const out = parseSceneExtractionResponse(raw);
    const body = out.actions[0]!;
    if (body.kind === "update" || body.kind === "merge" || body.kind === "create") {
      assert.ok(!body.content.includes("```"), "fence markers stripped");
      assert.ok(body.content.includes("flowchart TD"));
    } else {
      assert.fail("expected update/merge/create");
    }
  });

  it("uses default heatDelta=1 when not provided", () => {
    const raw = JSON.stringify([{ action: "update", target: "A.md", content: "x" }]);
    const out = parseSceneExtractionResponse(raw);
    assert.equal(out.actions[0]!.heatDelta, 1);
  });

  it("accepts explicit heat_delta", () => {
    const raw = JSON.stringify([{ action: "update", target: "A.md", content: "x", heat_delta: 5 }]);
    const out = parseSceneExtractionResponse(raw);
    assert.equal(out.actions[0]!.heatDelta, 5);
  });
});

describe("recoverPersonaUpdateRequest", () => {
  it("returns undefined for input without markers", () => {
    assert.equal(recoverPersonaUpdateRequest("no markers"), undefined);
  });

  it("returns undefined for input with open marker but no close marker", () => {
    const input = `${PERSONA_UPDATE_REQUEST_OPEN}\nreason: x`;
    assert.equal(recoverPersonaUpdateRequest(input), undefined);
  });

  it("falls back to inner text when reason: line is missing", () => {
    const input = `${PERSONA_UPDATE_REQUEST_OPEN}\njust an explanation\n${"[/PERSONA_UPDATE_REQUEST]"}`;
    const out = recoverPersonaUpdateRequest(input)!;
    assert.match(out.reason, /just an explanation/);
  });
});
