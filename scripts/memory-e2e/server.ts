/**
 * Isolated OmniRoute server lifecycle for the memory E2E harness.
 *
 * Reuses the repository's canonical e2e bootstrapper
 * (`scripts/dev/run-next-playwright.mjs dev`) with a temp DATA_DIR, a free
 * port, and the "open" bootstrap mode (no password; loopback management
 * requests are allowed during the bootstrap window — see
 * `src/shared/utils/apiAuth.ts`). The background distillation worker stays
 * off: the evaluation drives the explicit run control plane.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { httpJson, sleep } from "./http.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BOOTSTRAP = path.join(REPO_ROOT, "scripts", "dev", "run-next-playwright.mjs");
const MAX_LOG_LINES = 4_000;

export interface ServerHandle {
  baseUrl: string;
  dataDir: string;
  logs(): string;
  stop(): Promise<void>;
}

export async function startOmniRouteServer(options: {
  dataDir: string;
  port: number;
  waitMs: number;
  logFile?: string;
}): Promise<ServerHandle> {
  const logLines: string[] = [];
  const appendLog = (line: string): void => {
    logLines.push(line);
    if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
    if (options.logFile) fs.appendFileSync(options.logFile, `${line}\n`);
  };

  fs.mkdirSync(options.dataDir, { recursive: true });
  const child: ChildProcess = spawn(process.execPath, [BOOTSTRAP, "dev"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATA_DIR: options.dataDir,
      PORT: String(options.port),
      DASHBOARD_PORT: String(options.port),
      API_PORT: String(options.port),
      REQUIRE_API_KEY: "false",
      INITIAL_PASSWORD: "",
      OMNIROUTE_E2E_BOOTSTRAP_MODE: "open",
      DISABLE_SQLITE_AUTO_BACKUP: "true",
      MEMORY_DISTILLATION_ENABLED: "",
      MEMORY_DISTILLATION_INTERVAL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const pump = (stream: NodeJS.ReadableStream | null, tag: string): void => {
    if (!stream) return;
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        appendLog(`[${tag}] ${buffer.slice(0, newline).trimEnd()}`);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
  };
  pump(child.stdout, "out");
  pump(child.stderr, "err");

  let exited = false;
  child.on("exit", (code, signal) => {
    exited = true;
    appendLog(`[server] exited code=${code} signal=${signal}`);
  });

  const baseUrl = `http://127.0.0.1:${options.port}`;
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    if (exited) {
      throw new Error(`server exited before becoming healthy:\n${logLines.slice(-80).join("\n")}`);
    }
    try {
      const health = await httpJson(`${baseUrl}/api/monitoring/health`);
      if (health.ok) break;
    } catch {
      // Not listening yet — keep polling.
    }
    if (Date.now() >= deadline) {
      await stopChild(child);
      throw new Error(
        `server did not become healthy within ${options.waitMs}ms:\n${logLines.slice(-80).join("\n")}`
      );
    }
    await sleep(500);
  }

  return {
    baseUrl,
    dataDir: options.dataDir,
    logs: () => logLines.join("\n"),
    stop: () => stopChild(child),
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let index = 0; index < 50; index++) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(100);
  }
  child.kill("SIGKILL");
}
