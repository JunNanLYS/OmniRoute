/**
 * Report builders for the memory E2E harness. Pure functions produce the
 * markdown/json/csv documents; `writeReportFiles` persists them. Secrets are
 * never written: API keys are masked by the caller before reaching here.
 */
import fs from "node:fs";
import path from "node:path";

export type FixtureStatus = "pass" | "fail";
export type FailureStage = "seed" | "l0-import" | "gateway" | "distillation" | "gate" | "structure";

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
}

export interface ReportMeta {
  runId: string;
  profile: string;
  startedAt: string;
  finishedAt: string;
  gatewayModel: string;
  fixturesDir: string;
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
