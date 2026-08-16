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

test("mock outputs derive per-session content so fixtures stay distinct", async () => {
  const mock = await import("../../scripts/memory-e2e/mockUpstream.ts");

  const convA = [
    "user: 我们决定把支付服务迁移到 AWS，弃用自建机房。",
    "assistant: 已记录。",
    "user: 订单库用 PostgreSQL 16。",
    "assistant: 明白。",
  ].join("\n");
  const convB = [
    "user: 评审时优先指出类型不安全问题。",
    "assistant: 好的。",
    "user: 包管理用 pnpm。",
    "assistant: 记录。",
  ].join("\n");

  // L1: scene_name and memory content follow the conversation, so each
  // session lands in its own scene instead of one shared row.
  const sceneA = JSON.parse(mock.buildMockAssistantText("l1", convA))[0] as {
    scene_name: string;
    memories: Array<{ content: string }>;
  };
  const sceneB = JSON.parse(mock.buildMockAssistantText("l1", convB))[0] as {
    scene_name: string;
    memories: Array<{ content: string }>;
  };
  assert.ok(sceneA.scene_name.length > 0 && sceneA.scene_name.length <= 240);
  assert.ok(sceneB.scene_name.length > 0 && sceneB.scene_name.length <= 240);
  assert.notEqual(sceneA.scene_name, sceneB.scene_name);
  assert.ok(sceneA.memories[0]!.content.includes("AWS"));
  assert.ok(sceneB.memories[0]!.content.includes("类型不安全"));

  // L2: the summary follows the supplied memories (applyL1 joins them as
  // "type: content" lines).
  const l2A = JSON.parse(mock.buildMockAssistantText("l2", "work_fact: 支付服务迁移 AWS")) as {
    summary: string;
  };
  const l2B = JSON.parse(mock.buildMockAssistantText("l2", "work_fact: 评审关注类型安全")) as {
    summary: string;
  };
  assert.ok(l2A.summary.includes("AWS"));
  assert.ok(l2B.summary.includes("类型安全"));
  assert.notEqual(l2A.summary, l2B.summary);

  // L3: the persona follows the supplied scene samples ("[scene]\nsummary\ncontent").
  const l3A = JSON.parse(mock.buildMockAssistantText("l3", "[支付迁移]\nAWS 迁移决策\n详情一")) as {
    content: string;
  };
  const l3B = JSON.parse(mock.buildMockAssistantText("l3", "[评审约定]\n类型安全优先\n详情二")) as {
    content: string;
  };
  assert.ok(l3A.content.includes("AWS"));
  assert.ok(l3B.content.includes("类型安全"));
  assert.notEqual(l3A.content, l3B.content);
});

test("mock L1 splits long conversations into two distinct scenes", async () => {
  const mock = await import("../../scripts/memory-e2e/mockUpstream.ts");

  // A typical single-topic suite: three history user turns + the final
  // gateway turn = four user lines — stays single-scene.
  const short = [
    "user: 主题甲第一句。",
    "assistant: 好。",
    "user: 主题甲第二句。",
    "assistant: 记下。",
    "user: 整理一下。",
    "assistant: 好。",
  ].join("\n");
  const shortScenes = JSON.parse(mock.buildMockAssistantText("l1", short)) as Array<{
    scene_name: string;
  }>;
  assert.equal(shortScenes.length, 1, "four user lines (3 history + final) stay single-scene");

  // A multi-topic suite: four history user turns + final = five lines —
  // splits at the midpoint into two scenes.
  const long = [
    "user: 支付迁移任务启动，先做双写方案。",
    "assistant: 已记录任务状态。",
    "user: 双写完成，开始灰度切流。",
    "assistant: 任务推进中。",
    "user: 另外报表重构任务也立项了，负责人是王磊。",
    "assistant: 已记录第二个任务。",
    "user: 报表重构先用临时表跑数，不动主表。",
    "assistant: 明白。",
    "user: 汇总一下两个任务。",
    "assistant: 好。",
  ].join("\n");
  const scenes = JSON.parse(mock.buildMockAssistantText("l1", long)) as Array<{
    scene_name: string;
    memories: Array<{ content: string }>;
  }>;
  assert.equal(scenes.length, 2, "five user lines split into two scenes");
  assert.notEqual(scenes[0]?.scene_name, scenes[1]?.scene_name);
  assert.ok(scenes[0]!.memories.length >= 1);
  assert.ok(scenes[1]!.memories.length >= 1);
  assert.ok(scenes[0]!.memories.some((memory) => memory.content.includes("支付迁移")));
  assert.ok(scenes[1]!.memories.some((memory) => memory.content.includes("报表重构")));
});

// ── Live profile config ──────────────────────────────────────────────────────

test("mock L1 derives scenes from production [message-id] conversation lines", async () => {
  const mock = await import("../../scripts/memory-e2e/mockUpstream.ts");

  // Production renders conversation lines as "[id] role: content" (see
  // formatConversation in src/memory/integration/l1Scheduling.ts); the mock
  // must keep deriving memories from the user turns in that format.
  const production = [
    "[l0-u-1] user: 团队约定所有新服务用 TypeScript strict。",
    "[l0-a-1] assistant: 已记录。",
    "[l0-u-2] user: 依赖统一用 pnpm。",
    "[l0-a-2] assistant: 记下。",
    "[l0-u-3] user: 整理一下。",
    "[l0-a-3] assistant: 好。",
  ].join("\n");
  const scenes = JSON.parse(mock.buildMockAssistantText("l1", production)) as Array<{
    scene_name: string;
    memories: Array<{ content: string }>;
  }>;
  assert.equal(scenes.length, 1);
  assert.ok(scenes[0]!.scene_name.includes("TypeScript"));
  assert.ok(scenes[0]!.memories.some((memory) => memory.content.includes("pnpm")));
  // The bracketed id must not leak into the derived memory content.
  assert.ok(!scenes[0]!.memories.some((memory) => memory.content.includes("l0-u-")));
});

test("live profile resolves from env and fails fast without a provider key", async () => {
  const { resolveMemoryE2eConfig } = await import("../../scripts/memory-e2e/config.ts");

  assert.throws(
    () => resolveMemoryE2eConfig(["--profile", "live"], {}),
    /MEMORY_E2E_DEEPSEEK_API_KEY/
  );

  const configured = resolveMemoryE2eConfig(["--profile", "live"], {
    MEMORY_E2E_DEEPSEEK_API_KEY: "sk-live-test",
  });
  assert.equal(configured.profile, "live");
  assert.ok(configured.live);
  assert.equal(configured.live?.providerApiKey, "sk-live-test");
  assert.equal(configured.live?.maxUsd, 5);
  assert.equal(configured.live?.modelOverride, undefined);

  const overridden = resolveMemoryE2eConfig(["--profile", "live"], {
    MEMORY_E2E_DEEPSEEK_API_KEY: "sk-live-test",
    MEMORY_E2E_LIVE_MODEL: "deepseek-v4-flash",
    MEMORY_E2E_LIVE_MAX_USD: "2.5",
  });
  assert.equal(overridden.live?.modelOverride, "deepseek-v4-flash");
  assert.equal(overridden.live?.maxUsd, 2.5);
});

// ── Judge prompt + strict verdict parsing ────────────────────────────────────

test("judge messages embed transcript, memories, points, rubrics, and strict JSON contract", async () => {
  const judge = await import("../../scripts/memory-e2e/judge.ts");
  const messages = judge.buildJudgeMessages({
    fixtureId: "01",
    title: "工程协作偏好",
    transcript: "user: 新服务用 TypeScript。\nassistant: 已记录。",
    l1Memories: ["团队约定：新服务统一使用 TypeScript。"],
    l2Scenes: ["工程协作：TypeScript strict、pnpm、Nx。"],
    l3Persona: "偏好 TypeScript 生态的工程师。",
    mandatoryPoints: ["新服务统一使用 TypeScript", "包管理器为 pnpm"],
    negativePoints: ["yarn 迁移方案只是备选"],
    rubrics: { l1: "L1 应包含偏好", l2: "L2 应聚合场景", l3: "L3 应内化人设" },
  });
  assert.ok(messages.length >= 2);
  assert.equal(messages[0]?.role, "system");
  const serialized = JSON.stringify(messages);
  assert.ok(serialized.includes("json"));
  assert.ok(serialized.includes("TypeScript"));
  assert.ok(serialized.includes("新服务统一使用 TypeScript"));
  assert.ok(serialized.includes("yarn 迁移方案只是备选"));
  assert.ok(serialized.includes("L1 应包含偏好"));
  assert.ok(serialized.includes("工程协作：TypeScript strict"));
  assert.ok(serialized.includes("偏好 TypeScript 生态的工程师"));
});

test("parseJudgeVerdict accepts strict JSON and rejects malformed verdicts", async () => {
  const judge = await import("../../scripts/memory-e2e/judge.ts");
  const valid = JSON.stringify({
    scores: { l1: 5, l2: 4, l3: 4 },
    mandatoryPointScores: [5, 4],
    negativeViolations: [],
    hallucination: false,
    rationale: "覆盖完整",
    evidence: ["L1 含 TypeScript 事实"],
  });
  const parsed = judge.parseJudgeVerdict(valid, 2);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.verdict.scores.l1, 5);
    assert.equal(parsed.verdict.mandatoryPointScores.length, 2);
  }

  // Tolerates a fenced json block (upstreams sometimes wrap), still strict on schema.
  const fenced = "```json\n" + valid + "\n```";
  assert.equal(judge.parseJudgeVerdict(fenced, 2).ok, true);

  assert.equal(judge.parseJudgeVerdict("这不是 JSON", 2).ok, false);
  assert.equal(judge.parseJudgeVerdict(JSON.stringify({ scores: { l1: 5 } }), 2).ok, false);
  const outOfRange = JSON.stringify({
    scores: { l1: 9, l2: 4, l3: 4 },
    mandatoryPointScores: [5, 4],
    negativeViolations: [],
    hallucination: false,
    rationale: "r",
    evidence: [],
  });
  assert.equal(judge.parseJudgeVerdict(outOfRange, 2).ok, false);
  assert.equal(judge.parseJudgeVerdict(valid, 3).ok, false, "point-count mismatch must fail");
});

test("threshold evaluation applies mean, per-point, and veto rules", async () => {
  const judge = await import("../../scripts/memory-e2e/judge.ts");
  const verdict = (l1: number, points: number[], hallucination = false) => ({
    scores: { l1, l2: 5, l3: 5 },
    mandatoryPointScores: points,
    negativeViolations: [],
    hallucination,
    rationale: "",
    evidence: [],
  });
  const passing = judge.evaluateEvaluationThresholds([
    { fixtureId: "01", verdict: verdict(5, [5, 5]) },
    { fixtureId: "02", verdict: verdict(4, [4, 5]) },
  ]);
  assert.equal(passing.passed, true, passing.violations.join(";"));

  const lowMean = judge.evaluateEvaluationThresholds([
    { fixtureId: "01", verdict: verdict(2, [5, 5]) },
  ]);
  assert.equal(lowMean.passed, false);
  assert.ok(lowMean.violations.some((v) => v.includes("mean")));

  const lowPoint = judge.evaluateEvaluationThresholds([
    { fixtureId: "01", verdict: verdict(5, [5, 3]) },
  ]);
  assert.equal(lowPoint.passed, false);
  assert.ok(lowPoint.violations.some((v) => v.includes("mandatory")));

  const hallucinated = judge.evaluateEvaluationThresholds([
    { fixtureId: "01", verdict: verdict(5, [5, 5], true) },
  ]);
  assert.equal(hallucinated.passed, false);
  assert.ok(hallucinated.violations.some((v) => v.includes("hallucination")));
});

// ── Subject key factory (per-fixture owner isolation) ────────────────────────

test("createSubjectKey mints an isolated owner with capture enabled per call", async () => {
  const seed = await import("../../scripts/memory-e2e/seed.ts");
  const calls: Array<{ method: string; path: string; bearer: string | null; body: unknown }> = [];
  let seq = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
    calls.push({
      method: String(init?.method ?? "GET"),
      path: url.pathname,
      bearer: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    seq += 1;
    if (url.pathname === "/api/keys") {
      return new Response(JSON.stringify({ key: `sk-test-${seq}`, id: `key-id-${seq}` }), {
        status: 201,
      });
    }
    if (url.pathname === "/api/memory/pipeline-settings") {
      return new Response(
        JSON.stringify({ data: { captureEnabled: true, injectionEnabled: true } }),
        { status: 200 }
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    const first = await seed.createSubjectKey("http://localhost", "subject-a", []);
    const second = await seed.createSubjectKey("http://localhost", "subject-b", []);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.key, second.key);
    const puts = calls.filter((call) => call.path === "/api/memory/pipeline-settings");
    assert.equal(puts.length, 2, "each subject must enable its own pipeline");
    assert.equal(puts[0]?.bearer, `Bearer ${first.key}`);
    assert.equal(puts[1]?.bearer, `Bearer ${second.key}`);
    assert.deepEqual(puts[0]?.body, { captureEnabled: true, injectionEnabled: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
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
