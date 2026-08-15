import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES_DIR = path.join(REPO_ROOT, "tests/fixtures/memory-e2e");

// ── Fixture loader ───────────────────────────────────────────────────────────

test("parseFixture accepts the real case-01 fixture and preserves judge fields", async () => {
  const { parseFixture } = await import("../../scripts/memory-e2e/types.ts");
  const raw = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, "case-01-engineering-preferences.json"), "utf8")
  );
  const fixture = parseFixture(raw);
  assert.equal(fixture.id, "01");
  assert.ok(fixture.history.length >= 4);
  assert.equal(fixture.history[0]?.role, "user");
  assert.equal(fixture.history.at(-1)?.role, "assistant");
  assert.ok(fixture.finalUser.length > 0);
  assert.ok(fixture.mandatoryPoints.length >= 1);
  assert.ok(fixture.negativePoints.length >= 0);
  assert.ok(fixture.rubrics.l1.length > 0);
});

test("all shipped memory-e2e fixtures parse and have unique judge-ready ids", async () => {
  const { loadFixtures } = await import("../../scripts/memory-e2e/types.ts");
  const fixtures = await loadFixtures(FIXTURES_DIR);
  const ids = fixtures.map((fixture) => fixture.id);
  assert.ok(ids.includes("01"), "case-01 must be present");
  assert.ok(ids.includes("02"), "case-02 must be present");
  assert.equal(new Set(ids).size, ids.length, "fixture ids must be unique");
  for (const fixture of fixtures) {
    assert.ok(fixture.title.length > 0, `${fixture.id}: title required`);
    assert.ok(fixture.history.length >= 2, `${fixture.id}: history too short`);
    assert.equal(fixture.history.at(-1)?.role, "assistant", `${fixture.id}: must end assistant`);
    assert.ok(fixture.finalUser.length > 0, `${fixture.id}: finalUser required`);
    assert.ok(fixture.mandatoryPoints.length >= 1, `${fixture.id}: mandatoryPoints required`);
    assert.ok(
      fixture.rubrics.l1 && fixture.rubrics.l2 && fixture.rubrics.l3,
      `${fixture.id}: rubrics l1/l2/l3 required`
    );
  }
});

test("parseFixture rejects structurally invalid fixtures", async () => {
  const { parseFixture } = await import("../../scripts/memory-e2e/types.ts");
  const validHistory = [
    { role: "user", content: "u" },
    { role: "assistant", content: "a" },
  ];
  assert.throws(() => parseFixture({ id: "01", history: validHistory }));
  assert.throws(() =>
    parseFixture({
      id: "01",
      history: validHistory,
      finalUser: "",
      mandatoryPoints: [],
      rubrics: {},
    })
  );
  assert.throws(() =>
    parseFixture({
      id: "01",
      history: [{ role: "user", content: "u" }],
      finalUser: "f",
      mandatoryPoints: [],
      rubrics: { l1: "x", l2: "x", l3: "x" },
    })
  );
  assert.throws(() =>
    parseFixture({
      id: "01",
      history: [
        { role: "user", content: "u" },
        { role: "system", content: "s" },
      ],
      finalUser: "f",
      mandatoryPoints: [],
      rubrics: { l1: "x", l2: "x", l3: "x" },
    })
  );
});

// ── Mock upstream dispatch ───────────────────────────────────────────────────

test("classifyMockCall routes each distillation layer and gateway chat", async () => {
  const mock = await import("../../scripts/memory-e2e/mockUpstream.ts");
  const wrap = (system: string) => ({ messages: [{ role: "system", content: system }] });
  assert.equal(
    mock.classifyMockCall(wrap("Extract durable memories from the conversation.")),
    "l1"
  );
  assert.equal(
    mock.classifyMockCall(wrap("Update one durable scene from the supplied memories.")),
    "l2"
  );
  assert.equal(
    mock.classifyMockCall(wrap("Synthesize the supplied scenes into durable persona.")),
    "l3"
  );
  assert.equal(mock.classifyMockCall({ messages: [{ role: "user", content: "hi" }] }), "chat");
  assert.equal(mock.classifyMockCall({}), "chat");
});

test("buildMockAssistantText returns contract-valid JSON for every layer", async () => {
  const mock = await import("../../scripts/memory-e2e/mockUpstream.ts");
  const l1 = JSON.parse(mock.buildMockAssistantText("l1")) as Array<{
    scene_name: string;
    memories: Array<{ content: string; type: string; priority: number }>;
  }>;
  assert.ok(Array.isArray(l1));
  assert.ok(l1[0]?.memories.length >= 1);
  assert.ok(l1[0]!.memories[0]!.content.length > 0);

  const l2 = JSON.parse(mock.buildMockAssistantText("l2")) as {
    summary: string;
    tags: string[];
    heat: number;
    persona_update_requested: boolean;
  };
  assert.ok(l2.summary.length > 0);
  assert.ok(l2.tags.length >= 1);
  assert.ok(l2.heat >= 0 && l2.heat <= 1);
  assert.equal(l2.persona_update_requested, true);

  const l3 = JSON.parse(mock.buildMockAssistantText("l3")) as {
    content: string;
    prompt_mode: string;
  };
  assert.ok(l3.content.length > 0);
  assert.equal(l3.prompt_mode, "chat");

  assert.ok(mock.buildMockAssistantText("chat").length > 0);
});

// ── L0 gate ──────────────────────────────────────────────────────────────────

interface GateRow {
  id: string;
  ownerApiKeyId: string;
  sessionId: string;
  role: string;
  content: string;
  timestamp: string;
  recordedAt: string;
  source: string;
  correlationId: string | null;
  isInternal: boolean;
  truncated: boolean;
  provider: string | null;
  model: string | null;
}

const HISTORY = [
  { role: "user", content: "新服务全部用 TypeScript 写。" },
  { role: "assistant", content: "好的。" },
  { role: "user", content: "包管理用 pnpm。" },
  { role: "assistant", content: "记录。" },
];

const FINAL_USER = "整理成团队规范。";
const FINAL_ASSISTANT = "已整理：TypeScript、pnpm。";
const CORRELATION_ID = "req-e2e-1";

function makePassingRows(): GateRow[] {
  const base = {
    ownerApiKeyId: "owner-1",
    sessionId: "session-1",
    source: "chat",
    correlationId: CORRELATION_ID,
    isInternal: false,
    truncated: false,
    provider: "openai-compatible-chat-x",
    model: "mock/mock-model",
  };
  const row = (
    role: string,
    content: string,
    correlation: string | null,
    timestamp: string
  ): GateRow => ({
    ...base,
    id: `l0_${role}_${timestamp}`,
    role,
    content,
    timestamp,
    recordedAt: timestamp,
    correlationId: correlation,
  });
  const rows = HISTORY.map((item, index) =>
    row(item.role, item.content, null, new Date(2026, 0, 1, 0, 0, index).toISOString())
  );
  // The captured final pair shares one millisecond timestamp — the gate's
  // tie-break orders final user before final assistant by content.
  const finalTimestamp = new Date(2026, 0, 1, 0, 0, 10).toISOString();
  rows.push(row("user", FINAL_USER, CORRELATION_ID, finalTimestamp));
  rows.push(row("assistant", FINAL_ASSISTANT, CORRELATION_ID, finalTimestamp));
  return rows;
}

async function gate(inputs: {
  rows?: GateRow[];
  l1Rows?: Array<{
    sourceMessageIds: string[];
    metadata?: { sessionId?: string | null };
  }>;
  judgeRowCount?: number;
  gatewayModel?: string;
  requestedModel?: string;
  correlationId?: string;
}) {
  const gateModule = await import("../../scripts/memory-e2e/gate.ts");
  return gateModule.evaluateL0Gate({
    ownerApiKeyId: "owner-1",
    sessionId: "session-1",
    rows: inputs.rows ?? makePassingRows(),
    history: HISTORY,
    finalUser: FINAL_USER,
    finalAssistantContent: FINAL_ASSISTANT,
    correlationId: inputs.correlationId ?? CORRELATION_ID,
    requestedModel: inputs.requestedModel ?? "mock/mock-model",
    gatewayModel: inputs.gatewayModel ?? "mock/mock-model",
    l1Rows: inputs.l1Rows ?? [{ sourceMessageIds: [] }],
    judgeRowCount: inputs.judgeRowCount ?? 0,
  });
}

test("L0 gate passes a fully faithful capture", async () => {
  const result = await gate({});
  assert.deepEqual(result.failures, [], `unexpected failures: ${JSON.stringify(result.failures)}`);
  assert.equal(result.passed, true);
  assert.equal(result.checks.length, 10);
});

test("L0 gate fails on duplicate replay, truncation, wrong model, and dangling L1 refs", async () => {
  const duplicated = [...makePassingRows(), makePassingRows()[0]!];
  const duplicateResult = await gate({ rows: duplicated as never });
  assert.equal(duplicateResult.passed, false);
  assert.ok(duplicateResult.failures.some((f: string) => f.includes("no-duplicates")));

  const truncated = makePassingRows().map((row, index) =>
    index === 0 ? { ...row, truncated: true } : row
  );
  const truncatedResult = await gate({ rows: truncated as never });
  assert.ok(truncatedResult.failures.some((f: string) => f.includes("not-truncated-internal")));

  const wrongModel = await gate({ gatewayModel: "other/model" });
  assert.ok(wrongModel.failures.some((f: string) => f.includes("provider-model-match")));

  const dangling = await gate({
    l1Rows: [{ sourceMessageIds: ["l0_missing"], metadata: { sessionId: "session-1" } }],
  });
  assert.ok(dangling.failures.some((f: string) => f.includes("l1-references-l0")));

  const leaked = await gate({ judgeRowCount: 1 });
  assert.ok(leaked.failures.some((f: string) => f.includes("owner-session-isolation")));

  const wrongCorrelation = await gate({ correlationId: "req-other" });
  assert.ok(wrongCorrelation.failures.some((f: string) => f.includes("correlation-traceability")));
});

test("L0 gate ignores L1 rows distilled from other sessions", async () => {
  // Case-02 run in the same owner sees case-01's L1 rows. Those reference
  // case-01's L0 ids, which are absent from case-02's session — they must
  // not be treated as dangling evidence for the fixture under test.
  const other = await gate({
    l1Rows: [
      {
        sourceMessageIds: ["l0_other_session_id_1", "l0_other_session_id_2"],
        metadata: { sessionId: "session-other" },
      },
    ],
  });
  assert.equal(
    other.passed,
    true,
    `cross-session L1 must be ignored: ${JSON.stringify(other.failures)}`
  );

  // A row WITHOUT a session marker is not pipeline evidence either — it must
  // not fail the fixture's gate.
  const unmarked = await gate({ l1Rows: [{ sourceMessageIds: ["l0_unmarked_id"] }] });
  assert.equal(
    unmarked.passed,
    true,
    `unmarked L1 rows must be ignored: ${JSON.stringify(unmarked.failures)}`
  );
});

test("L0 gate verifies final assistant fidelity with whitespace normalization", async () => {
  const rows = makePassingRows();
  const last = rows.at(-1)!;
  last.content = `  ${FINAL_ASSISTANT}  \r\n`;
  const result = await gate({ rows: rows as never });
  assert.equal(
    (result as { passed: boolean }).passed,
    true,
    "whitespace-only differences must not fail fidelity"
  );
});

// ── Report ───────────────────────────────────────────────────────────────────

test("report builders render markdown and csv with pass/fail rows", async () => {
  const report = await import("../../scripts/memory-e2e/report.ts");
  const results = [
    {
      fixtureId: "01",
      title: "工程协作偏好",
      status: "pass" as const,
      stage: null,
      failures: [],
      l0RowCount: 6,
      l1Count: 1,
      l2Count: 1,
      l3Count: 1,
      durationMs: 1200,
    },
    {
      fixtureId: "02",
      title: "项目事实",
      status: "fail" as const,
      stage: "gate",
      failures: ["final-assistant-fidelity: content mismatch"],
      l0RowCount: 4,
      l1Count: 0,
      l2Count: 0,
      l3Count: 0,
      durationMs: 800,
    },
  ];
  const meta = {
    runId: "run-x",
    profile: "smoke",
    startedAt: "2026-08-15T00:00:00.000Z",
    finishedAt: "2026-08-15T00:01:00.000Z",
    gatewayModel: "mock/mock-model",
    fixturesDir: "tests/fixtures/memory-e2e",
  };
  const markdown = report.buildReportMarkdown(meta, results);
  assert.match(markdown, /# Memory E2E Report/);
  assert.match(markdown, /FAIL/);
  assert.match(markdown, /smoke/);
  assert.match(markdown, /\| 01 \|.*\| PASS \|/s);
  const csv = report.buildSummaryCsv(results);
  assert.match(csv, /fixture_id,title,status,stage/);
  assert.match(csv, /01,工程协作偏好,pass,/);
  assert.match(csv, /02,项目事实,fail,gate/);
  assert.equal(csv.trim().split("\n").length, 3);
});
