/**
 * Tests for L1 / L1.5 / L2 offload prompt builders and L1 / L2 / L3 prompt families.
 *
 * Verifies:
 *   - prompt-mode switch (chat vs code) returns the right system prompt
 *   - chat-persona cap = 2000 chars, team-doctrine cap = 1200 chars
 *   - prompt content for known templates
 *   - L1 compress marker kicks in past threshold
 *   - L2 budget warnings at 2000/2500 chars
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getExtractMemoriesSystemPrompt,
  formatExtractionPrompt,
  getConflictDetectionSystemPrompt,
  formatBatchConflictPrompt,
  buildPersonaPrompt,
  PERSONA_MAX_CHARS,
  TEAM_DOCTRINE_MAX_CHARS,
  buildSceneExtractionPrompt,
  buildL1UserPrompt,
  buildL15UserPrompt,
  buildL2UserPrompt,
  L1_COMPRESS_THRESHOLD,
  L1_PARAMS_MAX_LEN,
  L1_RESULT_MAX_LEN,
  L2_MMD_BUDGET_CHARS,
  L2_MMD_WARN_CHARS,
  type L1ExtractionMessage,
  type DedupCandidateMatch,
} from "../../../../src/memory/tencent/index.js";

describe("L1 extraction prompt family", () => {
  it("returns chat prompt by default and work prompt in code mode", () => {
    const chat = getExtractMemoriesSystemPrompt();
    const code = getExtractMemoriesSystemPrompt("code");
    assert.notEqual(chat, code);
    assert.match(chat, /persona|episodic|instruction/);
    assert.match(code, /work_fact|work_task|work_method|work_artifact/);
  });

  it("formatExtractionPrompt renders message ids, roles, ISO timestamps", () => {
    const msgs: L1ExtractionMessage[] = [
      { id: "m1", role: "user", content: "hello", timestamp: Date.UTC(2026, 0, 1) },
      { id: "m2", role: "assistant", content: "hi back", timestamp: Date.UTC(2026, 0, 1, 1) },
    ];
    const out = formatExtractionPrompt({
      newMessages: msgs,
      backgroundMessages: [],
      previousSceneName: "first context",
    });
    assert.match(out, /\[m1\] \[user\] \[/);
    assert.match(out, /\[m2\] \[assistant\] \[/);
    assert.match(out, /hello/);
    assert.match(out, /first context/);
  });

  it("renders background messages as context only (with warning not to extract)", () => {
    const out = formatExtractionPrompt({
      newMessages: [
        { id: "n1", role: "user", content: "current", timestamp: Date.UTC(2026, 0, 1) },
      ],
      backgroundMessages: [
        { id: "b1", role: "user", content: "old", timestamp: Date.UTC(2025, 11, 31) },
      ],
      previousSceneName: "无",
    });
    assert.match(out, /仅供理解上下文推断关系\/时间，严禁从中提取记忆/);
    assert.match(out, /\[b1\]/);
  });
});

describe("L1 dedup prompt family", () => {
  it("returns chat dedup by default and work dedup in code mode", () => {
    const chat = getConflictDetectionSystemPrompt();
    const code = getConflictDetectionSystemPrompt("code");
    assert.notEqual(chat, code);
    assert.match(chat, /persona\|episodic\|instruction\|work_fact/);
    assert.match(code, /work_fact\|work_task\|work_method\|work_artifact/);
  });

  it("formatBatchConflictPrompt builds a unified candidate pool", () => {
    const matches: DedupCandidateMatch[] = [
      {
        newMemory: {
          record_id: "new1",
          content: "user prefers TS",
          type: "persona",
          priority: 70,
          scene_name: "tech",
        },
        candidates: [
          {
            id: "c1",
            content: "user knows JS",
            type: "persona",
            priority: 60,
            scene_name: "tech",
            timestamps: ["2026-01-01"],
          },
        ],
      },
    ];
    const out = formatBatchConflictPrompt(matches);
    assert.match(out, /统一候选记忆池/);
    assert.match(out, /共 1 条已有记忆/);
    assert.match(out, /关联候选 ID/);
    assert.match(out, /new1/);
  });

  it("formatBatchConflictPrompt handles empty pool", () => {
    const matches: DedupCandidateMatch[] = [
      {
        newMemory: {
          record_id: "x",
          content: "x",
          type: "episodic",
          priority: 50,
          scene_name: "s",
        },
        candidates: [],
      },
    ];
    const out = formatBatchConflictPrompt(matches);
    assert.match(out, /空，没有已有记忆/);
    assert.match(out, /\[\]（无相似候选，直接 store）/);
  });
});

describe("L3 persona prompt family", () => {
  it("PERSONA_MAX_CHARS = 2000 and TEAM_DOCTRINE_MAX_CHARS = 1200 (template contract)", () => {
    assert.equal(PERSONA_MAX_CHARS, 2000);
    assert.equal(TEAM_DOCTRINE_MAX_CHARS, 1200);
  });

  it("buildPersonaPrompt surfaces the cap in the system prompt", () => {
    const out = buildPersonaPrompt({
      mode: "first",
      currentTime: "2026-01-01T00:00:00Z",
      totalProcessed: 100,
      sceneCount: 3,
      changedSceneCount: 3,
      changedScenesContent: "(empty)",
      personaFilePath: "persona.md",
      checkpointPath: "unused",
    });
    assert.match(out.systemPrompt, /不要超过 2000 字符/);
    assert.match(out.systemPrompt, /Chapter 1/);
  });

  it("buildPersonaPrompt uses the team-doctrine prompt + cap in code mode", () => {
    const out = buildPersonaPrompt({
      mode: "incremental",
      promptMode: "code",
      currentTime: "2026-01-01T00:00:00Z",
      totalProcessed: 100,
      sceneCount: 3,
      changedSceneCount: 3,
      changedScenesContent: "(empty)",
      personaFilePath: "persona.md",
      checkpointPath: "unused",
    });
    assert.match(out.systemPrompt, /Team Operating Doctrine/);
    assert.match(out.systemPrompt, /(?:禁止|不要)超过 1200/);
    assert.match(out.userPrompt, /迭代决策指南/);
  });
});

describe("L2 scene prompt family", () => {
  it("buildSceneExtractionPrompt returns system + user prompts with the maxScenes constraint", () => {
    const out = buildSceneExtractionPrompt({
      memoriesJson: "[{}]",
      sceneSummaries: "summary",
      currentTimestamp: "2026-01-01T00:00:00Z",
      maxScenes: 15,
    });
    assert.match(out.systemPrompt, /场景文件数量上限：15/);
    assert.match(out.userPrompt, /New Memories List/);
  });

  it("buildSceneExtractionPrompt surfaces the warning when provided", () => {
    const out = buildSceneExtractionPrompt({
      memoriesJson: "[]",
      sceneSummaries: "",
      currentTimestamp: "2026-01-01T00:00:00Z",
      sceneCountWarning: "approaching limit",
      existingSceneFiles: ["A.md", "B.md"],
      maxScenes: 5,
    });
    assert.match(out.userPrompt, /场景数量警告/);
    assert.match(out.userPrompt, /已有场景文件清单/);
    assert.match(out.userPrompt, /A\.md/);
  });
});

describe("L1 / L1.5 / L2 offload prompts", () => {
  it("buildL1UserPrompt truncates params/result and tags [NEEDS_COMPRESS] above threshold", () => {
    // Large enough that the stringified JSON exceeds L1_PARAMS_MAX_LEN
    const big = "x".repeat(L1_PARAMS_MAX_LEN * 2);
    const out = buildL1UserPrompt("recent", [
      {
        toolName: "exec",
        toolCallId: "t1",
        params: { cmd: big },
        result: "ok",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
    assert.match(out, /\[NEEDS_COMPRESS\]/);
    // The Params: line carries the truncated stringified JSON, which ends with "..."
    assert.match(out, /^Params: .*\.\.\.$/m, "Params line should end with '...' after truncation");
  });

  it("buildL1UserPrompt uses original values when [NEEDS_COMPRESS] is not triggered", () => {
    const out = buildL1UserPrompt("recent", [
      {
        toolName: "exec",
        toolCallId: "t1",
        params: { cmd: "ls" },
        result: "ok",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
    assert.ok(!out.includes("[NEEDS_COMPRESS]"));
    assert.match(out, /Tool: exec/);
  });

  it("buildL15UserPrompt handles (none) currentMmd and empty metas", () => {
    const out = buildL15UserPrompt("recent", null, []);
    assert.match(out, /none - 当前处于闲置状态/);
    assert.match(out, /暂无历史长任务/);
  });

  it("buildL15UserPrompt renders metas with line numbers and progress", () => {
    const out = buildL15UserPrompt("recent", null, [
      {
        filename: "task-1.md",
        path: "/x/task-1.md",
        taskGoal: "ship v2",
        doneCount: 2,
        doingCount: 1,
        todoCount: 1,
        updatedTime: "2026-01-01T00:00:00Z",
      },
    ]);
    assert.match(out, /task-1\.md/);
    assert.match(out, /ship v2/);
    assert.match(out, /progress: 2\/4 done/);
    assert.match(out, /lastUpdated/);
  });

  it("buildL2UserPrompt appends a budget warning at the threshold", () => {
    const out = buildL2UserPrompt({
      existingMmd: "L1: foo\nL2: bar",
      entries: [
        { toolCallId: "t1", toolCall: "x", summary: "y", timestamp: "2026-01-01T00:00:00Z" },
      ],
      recentHistory: null,
      currentTurn: null,
      taskLabel: "task-1",
      mmdPrefix: "P",
      charCount: L2_MMD_WARN_CHARS + 1,
    });
    assert.match(out, /Current MMD size: \d+ chars/);
    assert.match(out, new RegExp(`budget: ${L2_MMD_BUDGET_CHARS}`));
    assert.match(out, /积极合并节点/);
  });

  it("buildL2UserPrompt number-prefixes existing MMD lines", () => {
    const out = buildL2UserPrompt({
      existingMmd: "A\nB\nC",
      entries: [],
      recentHistory: null,
      currentTurn: null,
      taskLabel: "t",
      mmdPrefix: "X",
      charCount: 0,
    });
    assert.match(out, /L1: A/);
    assert.match(out, /L2: B/);
    assert.match(out, /L3: C/);
  });
});
