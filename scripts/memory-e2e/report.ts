/**
 * Report builders for the memory E2E harness. Pure functions produce the
 * markdown/json/csv documents; `writeReportFiles` persists them. Secrets are
 * never written: API keys are masked by the caller before reaching here.
 */
import fs from "node:fs";
import path from "node:path";

export type FixtureStatus = "pass" | "fail";
export type FailureStage =
  "seed" | "l0-import" | "gateway" | "distillation" | "gate" | "structure" | "judge";

/** Live-profile judge summary attached to a fixture result. */
export interface FixtureJudgeSummary {
  scores: { l1: number; l2: number; l3: number };
  mandatoryPointScores: number[];
  negativeViolations: string[];
  hallucination: boolean;
  rationale: string;
}

export interface FixtureResult {
  fixtureId: string;
  title: string;
  status: FixtureStatus;
  /** Stage where the fixture failed; null on pass. */
  stage: FailureStage | null;
  failures: string[];
  l0RowCount: number;
  l1Count: number;
  l2Count: number;
  l3Count: number;
  durationMs: number;
  /** Present on live runs whose structural gate passed. */
  judge: FixtureJudgeSummary | null;
}

export interface LiveSummary {
  judgeModel: string;
  /** Judge and distillation share the model — self-preference bias possible. */
  selfPreferenceBias: boolean;
  thresholds: {
    passed: boolean;
    violations: string[];
    overallMean: number;
    layerMeans: { l1: number; l2: number; l3: number };
  };
  /** Per-run token/cost totals from the usage analytics API (null if unavailable). */
  usage: { totalTokens: number | null; totalCostUsd: number | null } | null;
}

export interface ReportMeta {
  runId: string;
  profile: string;
  startedAt: string;
  finishedAt: string;
  gatewayModel: string;
  fixturesDir: string;
  /** Present on live runs. */
  liveSummary?: LiveSummary | null;
}

export function buildReportJson(
  meta: ReportMeta,
  results: FixtureResult[]
): Record<string, unknown> {
  const passed = results.filter((result) => result.status === "pass").length;
  return {
    runId: meta.runId,
    profile: meta.profile,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    gatewayModel: meta.gatewayModel,
    overall: passed === results.length && results.length > 0 ? "PASS" : "FAIL",
    totals: { total: results.length, passed, failed: results.length - passed },
    ...(meta.liveSummary ? { live: meta.liveSummary } : {}),
    results,
  };
}

export function buildReportMarkdown(meta: ReportMeta, results: FixtureResult[]): string {
  const passed = results.filter((result) => result.status === "pass").length;
  const overall = passed === results.length && results.length > 0 ? "PASS" : "FAIL";
  const lines: string[] = [];
  lines.push(`# Memory E2E Report`);
  lines.push("");
  lines.push(`- Overall: **${overall}**`);
  lines.push(`- Profile: ${meta.profile}`);
  lines.push(`- Run id: ${meta.runId}`);
  lines.push(`- Started: ${meta.startedAt}`);
  lines.push(`- Finished: ${meta.finishedAt}`);
  lines.push(`- Gateway model: ${meta.gatewayModel}`);
  lines.push(`- Suites: ${passed}/${results.length} passed`);
  lines.push("");
  lines.push(`| Suite | Title | Status | Stage | L0 | L1 | L2 | L3 | Duration |`);
  lines.push(`| ----- | ----- | ------ | ----- | -- | -- | -- | -- | -------- |`);
  for (const result of results) {
    lines.push(
      `| ${result.fixtureId} | ${result.title} | ${result.status.toUpperCase()} | ${result.stage ?? "-"} | ${result.l0RowCount} | ${result.l1Count} | ${result.l2Count} | ${result.l3Count} | ${Math.round(result.durationMs / 100) / 10}s |`
    );
  }
  const failed = results.filter((result) => result.status === "fail");
  const judged = results.filter((result) => result.judge);
  if (judged.length > 0) {
    lines.push("");
    lines.push(`## 语义评分（judge）`);
    lines.push("");
    lines.push(`| Suite | L1 | L2 | L3 | 必要点最低分 | 幻觉 |`);
    lines.push(`| ----- | -- | -- | -- | ----------- | ---- |`);
    for (const result of judged) {
      const judge = result.judge!;
      const minPoint = judge.mandatoryPointScores.length
        ? Math.min(...judge.mandatoryPointScores)
        : "-";
      lines.push(
        `| ${result.fixtureId} | ${judge.scores.l1} | ${judge.scores.l2} | ${judge.scores.l3} | ${minPoint} | ${judge.hallucination ? "⚠️" : "无"} |`
      );
    }
    const live = meta.liveSummary;
    if (live) {
      lines.push("");
      lines.push(
        `- 阈值: **${live.thresholds.passed ? "PASS" : "FAIL"}**（总分均值 ${live.thresholds.overallMean.toFixed(2)}，分层 ${live.thresholds.layerMeans.l1.toFixed(2)}/${live.thresholds.layerMeans.l2.toFixed(2)}/${live.thresholds.layerMeans.l3.toFixed(2)}，要求 ≥4.5，每必要点 ≥4，幻觉一票否决）`
      );
      for (const violation of live.thresholds.violations) {
        lines.push(`  - ${violation}`);
      }
      lines.push(`- Judge 模型: ${live.judgeModel}`);
      if (live.selfPreferenceBias) {
        lines.push(`- ⚠️ Judge 与蒸馏模型相同（self-preference bias 可能，分数宜作相对回归比较）`);
      }
      if (live.usage) {
        lines.push(
          `- 用量: tokens=${live.usage.totalTokens ?? "n/a"}, cost=$${live.usage.totalCostUsd ?? "n/a"}`
        );
      }
      lines.push(`- 注：蒸馏调用使用上游默认温度；仅 judge 与网关终轮温度为 0。`);
    }
  }
  if (failed.length > 0) {
    lines.push("");
    lines.push(`## Failures`);
    for (const result of failed) {
      lines.push("");
      lines.push(`### Suite ${result.fixtureId} — ${result.title} (${result.stage})`);
      for (const failure of result.failures) {
        lines.push(`- ${failure}`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function buildSummaryCsv(results: FixtureResult[]): string {
  const lines = ["fixture_id,title,status,stage,l0_rows,l1,l2,l3,duration_ms"];
  for (const result of results) {
    const title = result.title.includes(",") ? `"${result.title}"` : result.title;
    lines.push(
      [
        result.fixtureId,
        title,
        result.status,
        result.stage ?? "",
        result.l0RowCount,
        result.l1Count,
        result.l2Count,
        result.l3Count,
        result.durationMs,
      ].join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

export interface WriteReportInput {
  reportDir: string;
  meta: ReportMeta;
  results: FixtureResult[];
  serverLog: string;
  seedSummary: Record<string, unknown>;
}

export function writeReportFiles(input: WriteReportInput): void {
  fs.mkdirSync(input.reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(input.reportDir, "report.json"),
    `${JSON.stringify(buildReportJson(input.meta, input.results), null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(input.reportDir, "report.md"),
    buildReportMarkdown(input.meta, input.results)
  );
  fs.writeFileSync(path.join(input.reportDir, "summary.csv"), buildSummaryCsv(input.results));
  fs.writeFileSync(path.join(input.reportDir, "server.log"), input.serverLog);
  fs.writeFileSync(
    path.join(input.reportDir, "seed.json"),
    `${JSON.stringify(input.seedSummary, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(input.reportDir, "metadata.json"),
    `${JSON.stringify({ ...input.meta, generatedAt: new Date().toISOString() }, null, 2)}\n`
  );
}
