/**
 * Tests for L1 / L1.5 / L2 offload parsers — `src/memory/tencent/parsers/*`.
 *
 * Covers:
 *   - parseL1OffloadResponse: tool_call_id required, score clamp [0,10]
 *   - parseL15Response: task judgment + filename safety
 *   - parseL2OffloadResponse: write/replace structure + mermaid fence handling
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseL1OffloadResponse,
  parseL15Response,
  parseL2OffloadResponse,
  extractJson,
  extractMermaidFromFence,
} from "../../../../src/memory/tencent/index.js";

describe("parseL1OffloadResponse", () => {
  it("parses a well-formed L1 array", () => {
    const raw = JSON.stringify([
      {
        tool_call_id: "t1",
        tool_call: "exec ls",
        summary: "listed files",
        timestamp: "2026-01-01T00:00:00Z",
        score: 7,
      },
      {
        tool_call_id: "t2",
        tool_call: "write foo",
        summary: "wrote foo",
        timestamp: "2026-01-01T00:00:01Z",
        score: 5,
      },
    ]);
    const out = parseL1OffloadResponse(raw);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.tool_call_id, "t1");
    assert.equal(out[0]!.score, 7);
    assert.equal(out[0]!.node_id, null);
  });

  it("drops entries without tool_call_id", () => {
    const raw = JSON.stringify([
      { tool_call: "no id", summary: "x", score: 5 },
      { tool_call_id: "t1", tool_call: "ok", summary: "x", score: 5 },
    ]);
    const out = parseL1OffloadResponse(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.tool_call_id, "t1");
  });

  it("clamps score to [0, 10]", () => {
    const raw = JSON.stringify([
      { tool_call_id: "hi", tool_call: "x", summary: "x", timestamp: "", score: 99 },
      { tool_call_id: "lo", tool_call: "x", summary: "x", timestamp: "", score: -5 },
      { tool_call_id: "na", tool_call: "x", summary: "x", timestamp: "" },
    ]);
    const out = parseL1OffloadResponse(raw);
    assert.equal(out[0]!.score, 10);
    assert.equal(out[1]!.score, 0);
    assert.equal(out[2]!.score, 5); // default
  });

  it("recovers from ```json fences", () => {
    const raw =
      "```json\n" +
      JSON.stringify([{ tool_call_id: "t1", tool_call: "x", summary: "y", score: 3 }]) +
      "\n```";
    const out = parseL1OffloadResponse(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.tool_call_id, "t1");
  });

  it("returns [] when input is empty / non-JSON", () => {
    assert.deepEqual(parseL1OffloadResponse(""), []);
    assert.deepEqual(parseL1OffloadResponse("no json here"), []);
  });
});

describe("parseL15Response", () => {
  it("parses a well-formed task judgment", () => {
    const raw = JSON.stringify({
      taskCompleted: false,
      isLongTask: true,
      isContinuation: false,
      continuationMmdFile: null,
      newTaskLabel: "refactor-api",
    });
    const out = parseL15Response(raw)!;
    assert.equal(out.taskCompleted, false);
    assert.equal(out.isLongTask, true);
    assert.equal(out.isContinuation, false);
    assert.equal(out.continuationMmdFile, undefined);
    assert.equal(out.newTaskLabel, "refactor-api");
  });

  it("coerces string booleans", () => {
    const raw = JSON.stringify({
      taskCompleted: "false",
      isLongTask: "0",
      isContinuation: "",
      continuationMmdFile: null,
      newTaskLabel: null,
    });
    const out = parseL15Response(raw)!;
    assert.equal(out.taskCompleted, false); // "false" → false
    assert.equal(out.isLongTask, false); // "0" → false
    assert.equal(out.isContinuation, false); // "" → false
  });

  it("rejects unsafe filenames", () => {
    const raw = JSON.stringify({
      taskCompleted: true,
      isLongTask: false,
      isContinuation: true,
      continuationMmdFile: "../etc/passwd",
      newTaskLabel: null,
    });
    const out = parseL15Response(raw)!;
    assert.equal(out.continuationMmdFile, undefined);
  });

  it("accepts only safe filenames", () => {
    const raw = JSON.stringify({
      taskCompleted: true,
      isLongTask: false,
      isContinuation: true,
      continuationMmdFile: "task-abc_123.md",
      newTaskLabel: null,
    });
    const out = parseL15Response(raw)!;
    assert.equal(out.continuationMmdFile, "task-abc_123.md");
  });

  it("returns null when all decision fields are null", () => {
    const raw = JSON.stringify({ taskCompleted: null, isLongTask: null, isContinuation: null });
    assert.equal(parseL15Response(raw), null);
  });

  it("returns null for non-JSON input", () => {
    assert.equal(parseL15Response("not json"), null);
  });
});

describe("parseL2OffloadResponse", () => {
  it("parses a write action", () => {
    const mmd = "flowchart TD\n  A-->B";
    const raw = JSON.stringify({
      file_action: "write",
      mmd_content: "```mermaid\n" + mmd + "\n```",
      node_mapping: { t1: "N1", t2: "N2" },
    });
    const out = parseL2OffloadResponse(raw)!;
    assert.equal(out.fileAction, "write");
    assert.equal(out.mmdContent, mmd);
    assert.deepEqual(out.nodeMapping, { t1: "N1", t2: "N2" });
  });

  it("parses a replace action with multiple blocks", () => {
    const raw = JSON.stringify({
      file_action: "replace",
      mmd_content: null,
      replace_blocks: [
        { start_line: 5, end_line: 10, content: "```mermaid\nflowchart TD\n  N1-->N2\n```" },
        { start_line: 20, end_line: 25, content: "plain mermaid" },
      ],
      node_mapping: { t1: "N1" },
    });
    const out = parseL2OffloadResponse(raw)!;
    assert.equal(out.fileAction, "replace");
    assert.equal(out.mmdContent, undefined);
    assert.equal(out.replaceBlocks?.length, 2);
    assert.equal(out.replaceBlocks![0]!.startLine, 5);
    assert.equal(out.replaceBlocks![0]!.endLine, 10);
    assert.ok(out.replaceBlocks![0]!.content.includes("N1-->N2"));
  });

  it("drops replace_blocks with non-numeric line ranges", () => {
    const raw = JSON.stringify({
      file_action: "replace",
      mmd_content: null,
      replace_blocks: [
        { start_line: "five", end_line: 10, content: "x" },
        { start_line: 5, end_line: "ten", content: "y" },
        { start_line: 1, end_line: 2, content: "ok" },
      ],
      node_mapping: {},
    });
    const out = parseL2OffloadResponse(raw)!;
    assert.equal(out.replaceBlocks?.length, 1);
  });

  it("falls back to bare ```mermaid block when JSON parsing fails", () => {
    const raw = "before text\n```mermaid\nflowchart TD\n  A-->B\n```\nafter text";
    const out = parseL2OffloadResponse(raw)!;
    assert.equal(out.fileAction, "write");
    assert.ok(out.mmdContent?.includes("flowchart TD"));
  });

  it("returns null when nothing can be recovered", () => {
    assert.equal(parseL2OffloadResponse("totally not json"), null);
  });

  it("defaults file_action to write when unrecognized", () => {
    const raw = JSON.stringify({ file_action: "append", mmd_content: "x" });
    const out = parseL2OffloadResponse(raw)!;
    assert.equal(out.fileAction, "write");
  });
});

describe("extractJson (smoke)", () => {
  it("extracts object from prose", () => {
    const raw = 'noise {"a":1} more noise';
    assert.deepEqual(extractJson<{ a: number }>(raw), { a: 1 });
  });

  it("returns null on empty / non-string", () => {
    assert.equal(extractJson(""), null);
  });
});

describe("extractMermaidFromFence (smoke)", () => {
  it("extracts mermaid block", () => {
    assert.equal(extractMermaidFromFence("```mermaid\nfoo\n```"), "foo");
  });

  it("falls back to raw when no fence but mermaid-looking content", () => {
    const raw = "flowchart TD\n  A-->B";
    assert.equal(extractMermaidFromFence(raw), raw);
  });

  it("returns null when nothing matches", () => {
    assert.equal(extractMermaidFromFence("plain text"), null);
    assert.equal(extractMermaidFromFence(""), null);
  });
});
