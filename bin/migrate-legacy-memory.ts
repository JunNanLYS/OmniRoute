#!/usr/bin/env node
/**
 * bin/migrate-legacy-memory.ts — legacy memory importer (placeholder).
 *
 * This is a placeholder/export script kept behind the four-layer surface
 * until a real legacy-data migration is implemented. It MUST stay
 * runtime-safe (no throwing on import) so the bin/ build does not break.
 *
 * Usage (future):
 *   node bin/migrate-legacy-memory.ts \
 *     --from <legacyDbPath> --to <storageBackend> [--dryRun]
 *
 * What it will do once implemented:
 *  - read legacy `memories` rows directly from an operator-supplied legacy
 *    SQLite DB (the v3 `src/lib/memory/` store was removed by the four-layer
 *    hard cutover, so rows must be read raw, not via the old module);
 *  - classify each row into the four layers:
 *      L0   — raw lineage rows (legacy `memories` with type in
 *             {factual, episodic, procedural, semantic} created by the engine);
 *      L1   — owner-curated rows tagged `curated:true`;
 *      L2   — derived/working rows (legacy summarization output rows);
 *      L3   — operator-visible distilled rows (legacy `distillation_log`).
 *  - emit a JSON report on stdout and exit 0 (dry-run) or 1 (failure).
 *
 * The script prints "not implemented" and exits 2 — letting operators
 * discover it without surprising them with a hard crash.
 */

import process from "node:process";

interface MigrateArgs {
  from: string | null;
  to: string | null;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): MigrateArgs {
  const out: MigrateArgs = { from: null, to: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") {
      out.from = argv[++i] ?? null;
    } else if (a === "--to") {
      out.to = argv[++i] ?? null;
    } else if (a === "--dryRun") {
      out.dryRun = true;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.from || !args.to) {
    process.stderr.write(
      "[migrate-legacy-memory] placeholder script — storage repo not yet merged. " +
        "Usage: --from <legacyDbPath> --to <storageBackend> [--dryRun]\n"
    );
    return 2;
  }

  const report = {
    status: "placeholder",
    dryRun: args.dryRun,
    from: args.from,
    to: args.to,
    note:
      "This placeholder ships with the four-layer API surface so operators can " +
      "discover the migration entrypoint. The real migration will land with the " +
      "storage repository; until then this script reports status=placeholder and " +
      "exits 2 to avoid mutating data.",
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 2;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(
      `[migrate-legacy-memory] unexpected error: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    process.exit(1);
  }
);

export { parseArgs };
export type { MigrateArgs };
