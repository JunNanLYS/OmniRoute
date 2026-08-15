/**
 * Memory E2E harness entry point.
 *
 *   node --import tsx/esm scripts/memory-e2e/run.ts --profile smoke
 *
 * Owns the full isolated lifecycle per the design doc: loopback mock upstream,
 * dedicated OmniRoute server (temp DATA_DIR + free port), product-API seeding,
 * per-fixture L0 import → real gateway turn → L0 gate → explicit distillation
 * run → structural layer assertions, then a masked report under
 * test-results/memory-e2e/<run-id>/. Exit code 0 only when every fixture
 * passes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { resolveMemoryE2eConfig, type MemoryE2eConfig } from "./config.ts";
import { startOmniRouteServer, type ServerHandle } from "./server.ts";
import { MemoryMockUpstream } from "./mockUpstream.ts";
import { maskedSeedSummary, seedSmokeTarget, type SeedResult } from "./seed.ts";
import { importFixtureHistory } from "./l0Import.ts";
import { sendFinalUserTurn } from "./gateway.ts";
import { runExplicitDistillation } from "./distillation.ts";
import { evaluateL0Gate, type GateL0Row } from "./gate.ts";
import { loadFixtures, type MemoryE2eFixture } from "./types.ts";
import {
  writeReportFiles,
  type FixtureResult,
  type FailureStage,
  type ReportMeta,
} from "./report.ts";
import { httpJson, pollUntil } from "./http.ts";

interface HarnessContext {
  config: MemoryE2eConfig;
  server: ServerHandle;
  mock: MemoryMockUpstream;
  seed: SeedResult;
  reportDir: string;
}

async function listMemory<T>(
  baseUrl: string,
  apiKey: string,
  layer: string,
  query = ""
): Promise<T[]> {
  const response = await httpJson<{ data?: T[] }>(
    `${baseUrl}/api/memory/${layer}?limit=100${query}`,
    { bearer: apiKey }
  );
  if (!response.ok) {
    throw new Error(`GET /api/memory/${layer} failed: HTTP ${response.status}`);
  }
  return Array.isArray(response.body.data) ? response.body.data : [];
}

async function waitL0Capture(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  expectedRows: number,
  config: MemoryE2eConfig
): Promise<GateL0Row[]> {
  return pollUntil(
    async () => {
      const rows = await listMemory<GateL0Row>(
        baseUrl,
        apiKey,
        "l0",
        `&sessionId=${encodeURIComponent(sessionId)}`
      );
      return rows.length >= expectedRows ? rows : null;
    },
    {
      timeoutMs: config.captureTimeoutMs,
      intervalMs: config.capturePollMs,
      label: `L0 capture of ${expectedRows} rows for session ${sessionId}`,
    }
  );
}

async function executeFixture(
  fixture: MemoryE2eFixture,
  ctx: HarnessContext
): Promise<FixtureResult> {
  const startedAt = Date.now();
  const { server, seed, config } = ctx;
  const sessionId = `e2e-${fixture.id}-${sessionIdSuffix}`;
  const base: Omit<FixtureResult, "status" | "stage" | "failures"> = {
    fixtureId: fixture.id,
    title: fixture.title,
    l0RowCount: 0,
    l1Count: 0,
    l2Count: 0,
    l3Count: 0,
    durationMs: 0,
  };
  const finish = (
    status: "pass" | "fail",
    stage: FailureStage | null,
    failures: string[],
    counts?: Partial<Pick<FixtureResult, "l0RowCount" | "l1Count" | "l2Count" | "l3Count">>
  ): FixtureResult => ({
    ...base,
    ...counts,
    status,
    stage,
    failures,
    durationMs: Date.now() - startedAt,
  });

  try {
    // Stage 0 — mint this fixture's own subject owner: L1/L2/L3, the L2
    // scene budget, and the L3 persona singleton stay isolated per suite.
    const subject = await seed.createSubject();

    // Stage 1 — canonical L0 history import (monotonic importer timestamps,
    // one hour in the past so the captured gateway turn always sorts last).
    await importFixtureHistory({
      baseUrl: server.baseUrl,
      apiKey: subject.key,
      sessionId,
      history: fixture.history,
      timestampBase: Date.now() - 3_600_000,
    });

    // Stage 2 — real gateway turn for finalUser (capture is async).
    const turn = await sendFinalUserTurn({
      baseUrl: server.baseUrl,
      apiKey: subject.key,
      model: seed.gatewayModel,
      sessionId,
      content: fixture.finalUser,
    });
    if (!turn.correlationId) {
      return finish("fail", "gateway", ["gateway response missing X-Correlation-Id"]);
    }

    const rows = await waitL0Capture(
      server.baseUrl,
      subject.key,
      sessionId,
      fixture.history.length + 2,
      config
    );

    // Stage 3 — L0 gate (judge isolation included).
    const judgeRows = await listMemory<GateL0Row>(server.baseUrl, seed.judgeKey, "l0");
    const l1Rows = await listMemory<{ sourceMessageIds: string[] }>(
      server.baseUrl,
      subject.key,
      "l1"
    );
    const gate = evaluateL0Gate({
      ownerApiKeyId: subject.id,
      sessionId,
      rows,
      history: fixture.history,
      finalUser: fixture.finalUser,
      finalAssistantContent: turn.content,
      correlationId: turn.correlationId,
      requestedModel: seed.gatewayModel,
      gatewayModel: turn.model,
      l1Rows,
      judgeRowCount: judgeRows.length,
    });
    const l1Count = l1Rows.length;
    if (!gate.passed) {
      return finish("fail", "gate", gate.failures, {
        l0RowCount: rows.length,
        l1Count,
      });
    }

    // Stage 4 — explicit sequential distillation run.
    const run = await runExplicitDistillation({
      baseUrl: server.baseUrl,
      apiKey: subject.key,
      sessionId,
      layerTimeoutMs: config.runLayerTimeoutMs,
      pollMs: config.runPollMs,
      deadlineMs: config.runDeadlineMs,
    });
    if (run.status !== "succeeded") {
      const evidence = run.evidence;
      return finish(
        "fail",
        "distillation",
        [
          `distillation run ${run.runId} status=${run.status}`,
          ...run.layerStates
            .filter((state) => state.status === "failed")
            .map(
              (state) =>
                `layer ${state.layer} failed: ${state.error?.kind}: ${state.error?.message}`
            ),
          ...(evidence?.dlq.length
            ? evidence.dlq.map(
                (entry) => `DLQ ${entry.taskId}: ${entry.failureKind} ${entry.error}`
              )
            : []),
        ],
        { l0RowCount: rows.length, l1Count }
      );
    }

    // Stage 5 — structural layer assertions (semantic judging is live-only).
    const l2Rows = await listMemory<{ id: string }>(server.baseUrl, subject.key, "l2");
    const l3Rows = await listMemory<{ id: string; content: string }>(
      server.baseUrl,
      subject.key,
      "l3"
    );
    const finalL1 = await listMemory<{ sourceMessageIds: string[] }>(
      server.baseUrl,
      subject.key,
      "l1"
    );
    const structureFailures: string[] = [];
    if (finalL1.length < 1) {
      structureFailures.push(
        "L1 produced no memories" +
          ` (layerStates=${JSON.stringify(run.layerStates)} evidence=${JSON.stringify(run.evidence)})`
      );
    }
    if (l2Rows.length < 1) structureFailures.push("L2 produced no scenes");
    if (l3Rows.length < 1 || !l3Rows[0]?.content) structureFailures.push("L3 persona missing");
    const finalGate = evaluateL0Gate({
      ownerApiKeyId: subject.id,
      sessionId,
      rows,
      history: fixture.history,
      finalUser: fixture.finalUser,
      finalAssistantContent: turn.content,
      correlationId: turn.correlationId,
      requestedModel: seed.gatewayModel,
      gatewayModel: turn.model,
      l1Rows: finalL1,
      judgeRowCount: judgeRows.length,
    });
    if (!finalGate.passed) structureFailures.push(...finalGate.failures);

    const counts = {
      l0RowCount: rows.length,
      l1Count: finalL1.length,
      l2Count: l2Rows.length,
      l3Count: l3Rows.length,
    };
    if (structureFailures.length > 0) return finish("fail", "structure", structureFailures, counts);
    return finish("pass", null, [], counts);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return finish("fail", "seed", [message]);
  }
}

/** Per-run session suffix so every fixture gets a distinct session id. */
let sessionIdSuffix = "";

async function main(): Promise<number> {
  return runHarness();
}

// Side-effect-free module: the harness runs only when this file is executed
// directly (importing it for the types/helpers must never spawn a server).
const isMainEntry =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainEntry) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(
        `[memory-e2e] fatal: ${error instanceof Error ? error.message : error}\n`
      );
      process.exit(1);
    });
}

export async function runHarness(): Promise<number> {
  const config = resolveMemoryE2eConfig(process.argv.slice(2));
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const runId = `memory-e2e-${config.profile}-${new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  sessionIdSuffix = randomUUID().slice(0, 8);
  const reportDir = path.join(repoRoot, config.reportRoot, runId);
  const serverLogFile = path.join(reportDir, "server.log");
  fs.mkdirSync(reportDir, { recursive: true });

  const startedAt = new Date().toISOString();
  process.stdout.write(`[memory-e2e] profile=${config.profile} runId=${runId}\n`);

  const mock = new MemoryMockUpstream();
  let server: ServerHandle | null = null;
  let seed: SeedResult | null = null;
  const results: FixtureResult[] = [];

  try {
    const mockBaseUrl = await mock.start();
    process.stdout.write(`[memory-e2e] mock upstream at ${mockBaseUrl}\n`);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-memory-e2e-"));
    const { getFreePort } = await import("./http.ts");
    const port = await getFreePort();
    server = await startOmniRouteServer({
      dataDir,
      port,
      waitMs: config.serverWaitMs,
      logFile: serverLogFile,
    });
    process.stdout.write(`[memory-e2e] server at ${server.baseUrl} (data ${dataDir})\n`);

    seed = await seedSmokeTarget({ baseUrl: server.baseUrl, mockBaseUrl });
    process.stdout.write(`[memory-e2e] seed complete: model ${seed.gatewayModel}\n`);

    const fixtures = await loadFixtures(
      path.join(repoRoot, config.fixturesDir),
      config.fixtureFilter
    );
    for (const fixture of fixtures) {
      process.stdout.write(`[memory-e2e] fixture ${fixture.id} (${fixture.title}) …\n`);
      const result = await executeFixture(fixture, { config, server, mock, seed, reportDir });
      results.push(result);
      process.stdout.write(
        `[memory-e2e] fixture ${fixture.id}: ${result.status.toUpperCase()}${result.failures.length ? ` — ${result.failures[0]}` : ""}\n`
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[memory-e2e] harness error: ${message}\n`);
    if (results.length === 0) {
      results.push({
        fixtureId: "-",
        title: "harness",
        status: "fail",
        stage: "seed",
        failures: [message],
        l0RowCount: 0,
        l1Count: 0,
        l2Count: 0,
        l3Count: 0,
        durationMs: 0,
      });
    }
  } finally {
    await server?.stop();
    await mock.stop();
  }

  const finishedAt = new Date().toISOString();
  const meta: ReportMeta = {
    runId,
    profile: config.profile,
    startedAt,
    finishedAt,
    gatewayModel: seed?.gatewayModel ?? "n/a",
    fixturesDir: config.fixturesDir,
  };
  writeReportFiles({
    reportDir,
    meta,
    results,
    serverLog: server?.logs() ?? "",
    seedSummary: seed
      ? maskedSeedSummary(seed)
      : { error: "seed did not complete", mockCalls: mock.callLog.length },
  });
  const passed = results.filter((result) => result.status === "pass").length;
  process.stdout.write(
    `[memory-e2e] ${passed}/${results.length} fixtures passed — report: ${reportDir}\n`
  );
  return passed === results.length && results.length > 0 ? 0 : 1;
}
