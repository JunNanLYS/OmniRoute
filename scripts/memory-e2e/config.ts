/**
 * Profile configuration for the memory E2E harness.
 *
 * smoke: loopback mock upstream, zero external cost, structural assertions.
 * live:  real upstream (DeepSeek via MEMORY_E2E_DEEPSEEK_API_KEY) with judged
 *        semantic scoring; the smoke gate always runs first so infrastructure
 *        failures are not misreported as memory-quality failures. Live spend
 *        is capped through per-key USD limits (MEMORY_E2E_LIVE_MAX_USD,
 *        default 5).
 */
export type MemoryE2eProfile = "smoke" | "live";

export interface MemoryE2eLiveConfig {
  /** Real upstream API key (env MEMORY_E2E_DEEPSEEK_API_KEY) — never reported. */
  providerApiKey: string;
  /** Optional model override; default is discovered from the live sync response. */
  modelOverride?: string;
  /** Per-run USD ceiling enforced through per-key usage limits. Default 5. */
  maxUsd: number;
}

export interface MemoryE2eConfig {
  profile: MemoryE2eProfile;
  live?: MemoryE2eLiveConfig;
  fixturesDir: string;
  reportRoot: string;
  /** Boot budget for the isolated dev server. */
  serverWaitMs: number;
  /** Polling budget while waiting for the async L0 capture to land. */
  captureTimeoutMs: number;
  capturePollMs: number;
  /** Explicit distillation run polling (spec: 2s interval, 180s per layer). */
  runPollMs: number;
  runLayerTimeoutMs: number;
  runDeadlineMs: number;
  /** Optional fixture id / filename filter. */
  fixtureFilter?: string;
}

export const DEFAULTS = {
  fixturesDir: "tests/fixtures/memory-e2e",
  reportRoot: "test-results/memory-e2e",
  serverWaitMs: 240_000,
  captureTimeoutMs: 30_000,
  capturePollMs: 500,
  runPollMs: 2_000,
  runLayerTimeoutMs: 180_000,
  runDeadlineMs: 600_000,
} as const;

export function resolveMemoryE2eConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): MemoryE2eConfig {
  const args = new Set(argv.filter((arg) => arg.startsWith("--")).map((arg) => arg.split("=")[0]!));
  const valueOf = (name: string): string | undefined => {
    const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
    if (inline) return inline.split("=").slice(1).join("=");
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const profile = valueOf("profile") ?? "smoke";
  if (profile !== "smoke" && profile !== "live") {
    throw new Error(`--profile must be "smoke" or "live" (got "${profile}")`);
  }

  let live: MemoryE2eLiveConfig | undefined;
  if (profile === "live") {
    const providerApiKey = env.MEMORY_E2E_DEEPSEEK_API_KEY?.trim();
    if (!providerApiKey) {
      throw new Error(
        "live profile requires MEMORY_E2E_DEEPSEEK_API_KEY (set it in the environment; the key is never written to reports)"
      );
    }
    const maxUsdRaw = Number(env.MEMORY_E2E_LIVE_MAX_USD ?? "");
    live = {
      providerApiKey,
      modelOverride: env.MEMORY_E2E_LIVE_MODEL?.trim() || undefined,
      maxUsd: Number.isFinite(maxUsdRaw) && maxUsdRaw > 0 ? maxUsdRaw : 5,
    };
  }

  return {
    profile,
    live,
    fixturesDir: valueOf("fixtures-dir") ?? DEFAULTS.fixturesDir,
    reportRoot: valueOf("report-root") ?? DEFAULTS.reportRoot,
    serverWaitMs: Number(valueOf("server-wait-ms") ?? DEFAULTS.serverWaitMs),
    captureTimeoutMs: Number(valueOf("capture-timeout-ms") ?? DEFAULTS.captureTimeoutMs),
    capturePollMs: DEFAULTS.capturePollMs,
    runPollMs: DEFAULTS.runPollMs,
    runLayerTimeoutMs: Number(valueOf("layer-timeout-ms") ?? DEFAULTS.runLayerTimeoutMs),
    runDeadlineMs: Number(valueOf("run-deadline-ms") ?? DEFAULTS.runDeadlineMs),
    fixtureFilter: valueOf("fixture"),
  };
}
