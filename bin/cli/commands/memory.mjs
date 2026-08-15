import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { apiFetch } from "../api.mjs";
import { emit } from "../output.mjs";
import { t } from "../i18n.mjs";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_DLQ_LIMIT = 50;
const MAX_DLQ_LIMIT = 200;
const MIN_LIMIT = 1;
const MAX_QUERY_LEN = 1024;
const MAX_ID_LEN = 256;
const MAX_SESSION_LEN = 256;
const MAX_ERROR_LEN = 4096;
const MAX_L0_IMPORT_ITEMS = 500;
const MAX_L0_CONTENT_LEN = 65_536;
const DISTILLATION_RUN_LAYERS = ["l1", "l2", "l3"];
const DISTILLATION_RUN_POLL_MS = 2000;
const DISTILLATION_RUN_TIMEOUT_MS = 180_000;
const SOURCE_EXT = ["ts", "tsx", "js", "jsx", "mjs", "cjs"];

function sanitizeErrorMessage(message) {
  let value = typeof message === "string" ? message : String(message ?? "");
  if (value.length > MAX_ERROR_LEN) value = value.slice(0, MAX_ERROR_LEN);
  const newline = value.indexOf("\n");
  const firstLine = newline >= 0 ? value.slice(0, newline) : value;
  const parts = firstLine.split(/(\s+)/);
  for (let index = 0; index < parts.length; index++) {
    const token = parts[index];
    if (token.length < 4 || token.length > 2048) continue;
    const isPosix = token.charCodeAt(0) === 0x2f;
    const isWindows = token.length > 2 && token.charCodeAt(1) === 0x3a && /[A-Za-z]/.test(token[0]);
    if (!isPosix && !isWindows) continue;
    const dot = token.lastIndexOf(".");
    if (dot <= 0 || dot === token.length - 1) continue;
    const extension = token
      .slice(dot + 1)
      .split(":", 1)[0]
      .toLowerCase();
    if (SOURCE_EXT.includes(extension)) parts[index] = "<path>";
  }
  return parts.join("");
}

function clampLimit(raw, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_LIMIT) return fallback;
  return Math.min(max, parsed);
}

function trimLen(value, max) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function truncate(value, length = 60) {
  if (value == null) return "-";
  const text = String(value);
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function fmtTs(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

const layerSchema = [
  { key: "id", header: "ID", width: 14 },
  { key: "sessionId", header: "Session", width: 14 },
  { key: "scene", header: "Scene", width: 18 },
  { key: "content", header: "Content", width: 60, formatter: truncate },
  { key: "score", header: "Score", formatter: (value) => (value != null ? value.toFixed(3) : "-") },
  { key: "createdAt", header: "Created", formatter: fmtTs },
];

const listSchema = [{ key: "layer", header: "Layer", width: 5 }, ...layerSchema];

const selectorSchema = [
  { key: "provider", header: "Provider", width: 20 },
  { key: "modelId", header: "Model", width: 32 },
  { key: "sourceLayer", header: "Source", width: 12 },
  { key: "scope", header: "Scope", width: 10 },
  { key: "apiKeyId", header: "API key", width: 20 },
];

const dlqSchema = [
  { key: "id", header: "ID", width: 14 },
  { key: "sourceLayer", header: "Layer", width: 8 },
  { key: "sourceId", header: "Source ID", width: 16 },
  { key: "status", header: "Status", width: 12 },
  { key: "retryCount", header: "Retries", width: 9 },
  { key: "errorMessage", header: "Last error", width: 60, formatter: truncate },
  { key: "errorAt", header: "Failed", formatter: fmtTs },
];

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function dataItems(payload) {
  const record = asRecord(payload);
  return Array.isArray(record.data) ? record.data : [];
}

function pickLayerRows(items, layer) {
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const item = asRecord(raw);
    return {
      ...(layer ? { layer } : {}),
      id: item.id ?? "-",
      sessionId: item.sessionId ?? item.sessionKey ?? "-",
      scene: item.sceneName ?? item.scene ?? "-",
      content: item.content ?? item.summary ?? "",
      score: item.score,
      createdAt: item.createdAt ?? item.recordedAt ?? item.updatedAt ?? item.timestamp ?? null,
    };
  });
}

async function responseJson(response) {
  if (!response.ok) {
    const message = await response.text().catch(() => "error");
    process.stderr.write(`Error: ${sanitizeErrorMessage(message)}\n`);
    process.exit(1);
  }
  return response.json().catch(() => ({}));
}

function listingParams(opts, limit = DEFAULT_LIMIT) {
  const params = new URLSearchParams({ limit: String(clampLimit(opts.limit, limit)) });
  if (opts.session) params.set("sessionId", trimLen(opts.session, MAX_SESSION_LEN));
  if (opts.scene) params.set("sceneName", trimLen(opts.scene, MAX_ID_LEN));
  return params;
}

async function runLayerSearch(layer, query, opts, cmd) {
  const safeQuery = trimLen(query, MAX_QUERY_LEN);
  if (!safeQuery) {
    process.stderr.write("Query is required (1-1024 chars)\n");
    process.exit(2);
  }
  const params = listingParams(opts);
  params.set("q", safeQuery);
  const payload = await responseJson(await apiFetch(`/api/memory/${layer}?${params.toString()}`));
  emit(pickLayerRows(dataItems(payload)), cmd.optsWithGlobals(), layerSchema);
}

export async function runL0Search(query, opts, cmd) {
  return runLayerSearch("l0", query, opts, cmd);
}

export async function runL1Search(query, opts, cmd) {
  return runLayerSearch("l1", query, opts, cmd);
}

export async function runL2Read(id, _opts, cmd) {
  const safeId = trimLen(id, MAX_ID_LEN);
  if (!safeId) {
    process.stderr.write("Id is required (1-256 chars)\n");
    process.exit(2);
  }
  const payload = await responseJson(
    await apiFetch(`/api/memory/l2/${encodeURIComponent(safeId)}`)
  );
  const entry = asRecord(asRecord(payload).data);
  emit(pickLayerRows([entry]), cmd.optsWithGlobals(), layerSchema);
}

export async function runL3Read(opts, cmd) {
  const params = listingParams({ ...opts, limit: "1" }, 1);
  const payload = await responseJson(await apiFetch(`/api/memory/l3?${params.toString()}`));
  emit(pickLayerRows(dataItems(payload)), cmd.optsWithGlobals(), layerSchema);
}

export async function runMemoryList(opts, cmd) {
  const params = listingParams(opts);
  const layers = ["l0", "l1", "l2", "l3"];
  const payloads = await Promise.all(
    layers.map((layer) => apiFetch(`/api/memory/${layer}?${params.toString()}`).then(responseJson))
  );
  const rows = payloads.flatMap((payload, index) =>
    pickLayerRows(dataItems(payload), layers[index].toUpperCase())
  );
  emit(rows, cmd.optsWithGlobals(), listSchema);
}

export async function runDistillationModelGet(opts, cmd) {
  const params = new URLSearchParams();
  if (opts.apiKeyId) params.set("apiKeyId", trimLen(opts.apiKeyId, MAX_ID_LEN));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const payload = await responseJson(await apiFetch(`/api/memory/distillation-model${suffix}`));
  emit(asRecord(payload).data ?? {}, cmd.optsWithGlobals(), selectorSchema);
}

export async function runDistillationModelSet(provider, modelId, opts, cmd) {
  const body = {
    provider: trimLen(provider, MAX_ID_LEN),
    modelId: trimLen(modelId, MAX_ID_LEN),
    scope: opts.scope ?? "self",
    ...(opts.apiKeyId ? { apiKeyId: trimLen(opts.apiKeyId, MAX_ID_LEN) } : {}),
  };
  const payload = await responseJson(
    await apiFetch("/api/memory/distillation-model", { method: "PUT", body })
  );
  emit(asRecord(payload).data ?? {}, cmd.optsWithGlobals(), selectorSchema);
}

export async function runDistillationModelDelete(opts, cmd) {
  const params = new URLSearchParams({ scope: opts.scope ?? "self" });
  if (opts.apiKeyId) params.set("apiKeyId", trimLen(opts.apiKeyId, MAX_ID_LEN));
  const payload = await responseJson(
    await apiFetch(`/api/memory/distillation-model?${params.toString()}`, { method: "DELETE" })
  );
  emit(payload, cmd.optsWithGlobals());
}

export async function runDlqList(opts, cmd) {
  const params = new URLSearchParams({
    limit: String(clampLimit(opts.limit, DEFAULT_DLQ_LIMIT, MAX_DLQ_LIMIT)),
  });
  if (opts.statuses) params.set("statuses", trimLen(opts.statuses, MAX_QUERY_LEN));
  const payload = await responseJson(
    await apiFetch(`/api/memory/distillation-model/dlq?${params.toString()}`)
  );
  emit(dataItems(payload), cmd.optsWithGlobals(), dlqSchema);
}

export async function runDlqRetry(ids, opts, cmd) {
  if (!opts.yes) {
    process.stderr.write("Use --yes to confirm DLQ retry.\n");
    process.exit(2);
  }
  const safeIds = Array.isArray(ids)
    ? ids.map((id) => trimLen(id, MAX_ID_LEN)).filter(Boolean)
    : [];
  if (!opts.all && safeIds.length === 0) {
    process.stderr.write("Provide one or more DLQ ids or use --all.\n");
    process.exit(2);
  }
  const body = opts.all ? { all: true } : { ids: safeIds };
  const payload = await responseJson(
    await apiFetch("/api/memory/distillation-model/dlq?op=retry", {
      method: "POST",
      body,
    })
  );
  emit(payload, cmd.optsWithGlobals());
}

// ── memory l0 import ─────────────────────────────────────────────────────────

/**
 * Read a conversation fixture and map it to the canonical L0 import schema.
 * Accepts a bare message array, `{ history: [...] }`, or `{ items: [...] }`.
 * Only `role` and `content` are taken from each entry; idempotency keys are
 * generated deterministically from the session + array index so re-imports
 * are idempotent. Timestamps are left to the importer (array order).
 */
function readL0FixtureItems(file, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(file), "utf8");
  } catch {
    process.stderr.write(`Cannot read fixture file: ${file}\n`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write("Fixture file is not valid JSON.\n");
    process.exit(2);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.history)
      ? parsed.history
      : Array.isArray(parsed?.items)
        ? parsed.items
        : null;
  if (!list) {
    process.stderr.write("Fixture must be a message array or contain history/items.\n");
    process.exit(2);
  }
  const items = [];
  for (let index = 0; index < list.length && items.length < MAX_L0_IMPORT_ITEMS; index++) {
    const entry = list[index] && typeof list[index] === "object" ? list[index] : {};
    if (entry.role !== "user" && entry.role !== "assistant") {
      process.stderr.write(`Fixture message ${index}: role must be "user" or "assistant".\n`);
      process.exit(2);
    }
    const content = typeof entry.content === "string" ? entry.content.trim() : "";
    if (!content) {
      process.stderr.write(`Fixture message ${index}: content is required.\n`);
      process.exit(2);
    }
    items.push({
      idempotencyKey: `${sessionId}:${index}`,
      role: entry.role,
      content: content.slice(0, MAX_L0_CONTENT_LEN),
    });
  }
  if (items.length === 0) {
    process.stderr.write("Fixture contains no importable messages.\n");
    process.exit(2);
  }
  return items;
}

export async function runL0Import(file, opts, cmd) {
  const session = trimLen(opts.session, MAX_SESSION_LEN);
  if (!session) {
    process.stderr.write("Session is required (--session <id>).\n");
    process.exit(2);
  }
  if (!file) {
    process.stderr.write("Fixture file is required.\n");
    process.exit(2);
  }
  const items = readL0FixtureItems(file, session);
  const query = opts.apiKeyId
    ? `?apiKeyId=${encodeURIComponent(trimLen(opts.apiKeyId, MAX_ID_LEN))}`
    : "";
  const payload = await responseJson(
    await apiFetch(`/api/memory/l0${query}`, {
      method: "POST",
      body: { sessionId: session, items },
    })
  );
  const importedIds = Array.isArray(payload.importedIds) ? payload.importedIds : [];
  emit({ success: true, imported: importedIds.length, importedIds }, cmd.optsWithGlobals());
}

// ── memory distillation run ──────────────────────────────────────────────────

function parseRunLayers(raw) {
  const requested = String(raw ?? "l1,l2,l3")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length === 0) return [...DISTILLATION_RUN_LAYERS];
  const invalid = requested.filter((layer) => !DISTILLATION_RUN_LAYERS.includes(layer));
  if (invalid.length > 0) {
    process.stderr.write(`Invalid layers: ${invalid.join(", ")}. Use a subset of l1,l2,l3.\n`);
    process.exit(2);
  }
  return DISTILLATION_RUN_LAYERS.filter((layer) => requested.includes(layer));
}

export async function runDistillationRun(opts, cmd) {
  const session = trimLen(opts.session, MAX_SESSION_LEN);
  if (!session) {
    process.stderr.write("Session is required (--session <id>).\n");
    process.exit(2);
  }
  const layers = parseRunLayers(opts.layers);
  const timeoutRaw = Number.parseInt(String(opts.timeout ?? ""), 10);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DISTILLATION_RUN_TIMEOUT_MS;

  const query = opts.apiKeyId
    ? `?apiKeyId=${encodeURIComponent(trimLen(opts.apiKeyId, MAX_ID_LEN))}`
    : "";
  const accepted = asRecord(
    await responseJson(
      await apiFetch(`/api/memory/distillation/run${query}`, {
        method: "POST",
        body: { session, layers },
      })
    )
  );
  const statusUrl =
    typeof accepted.statusUrl === "string" && accepted.statusUrl
      ? accepted.statusUrl
      : accepted.runId
        ? `/api/memory/distillation/run/${encodeURIComponent(String(accepted.runId))}`
        : null;

  if (!opts.wait || !statusUrl) {
    emit(accepted, cmd.optsWithGlobals());
    return;
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const payload = asRecord(await responseJson(await apiFetch(statusUrl)));
    const record = asRecord(payload.data ?? payload);
    const status = typeof record.status === "string" ? record.status : "running";
    if (status !== "running") {
      emit(record, cmd.optsWithGlobals());
      if (status === "failed") {
        process.stderr.write(`Distillation run ${String(record.runId ?? "")} failed.\n`);
        process.exit(1);
      }
      return;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(DISTILLATION_RUN_POLL_MS, deadline - Date.now()));
  }
  process.stderr.write(
    `Timed out waiting for distillation run ${String(accepted.runId ?? "")} after ${timeoutMs}ms.\n`
  );
  process.exit(124);
}

export function registerMemory(program) {
  const memory = program.command("memory").description(t("memory.description"));

  const l0 = memory.command("l0").description("Layer-0 raw trace operations");
  l0.command("search <query>")
    .description("Search layer-0 raw traces")
    .option("--session <id>", "Filter by session id")
    .option("--scene <name>", "Filter by scene name")
    .option("--limit <n>", "Max items to return (1-100, default 20)", String, "20")
    .action(runL0Search);
  l0.command("import <file>")
    .description("Import a conversation fixture as L0 history")
    .option("--session <id>", "Target session id (required)")
    .option("--api-key-id <id>", "Target API key (management only)")
    .action(runL0Import);

  const l1 = memory.command("l1").description("Layer-1 curated memory operations");
  l1.command("search <query>")
    .description("Search layer-1 curated memories")
    .option("--session <id>", "Filter by session id")
    .option("--scene <name>", "Filter by scene name")
    .option("--limit <n>", "Max items to return (1-100, default 20)", String, "20")
    .action(runL1Search);

  const l2 = memory.command("l2").description("Layer-2 navigation scene operations");
  l2.command("read <id>").description("Read a layer-2 scene by id").action(runL2Read);

  const l3 = memory.command("l3").description("Layer-3 working context operations");
  l3.command("read")
    .description("Read the current layer-3 working context")
    .option("--session <id>", "Filter by session id")
    .action(runL3Read);

  memory
    .command("list")
    .description("List entries from all four memory layers")
    .option("--session <id>", "Filter by session id")
    .option("--scene <name>", "Filter by scene name")
    .option("--limit <n>", "Max items per layer (1-100, default 20)", String, "20")
    .action(runMemoryList);

  const selector = memory
    .command("distillation-model")
    .description("Manage the effective distillation model selector");
  selector
    .command("get")
    .option("--api-key-id <id>", "Inspect a selector for an API key (management only)")
    .action(runDistillationModelGet);
  selector
    .command("set <provider> <model-id>")
    .option("--scope <scope>", "Selector scope: self or global", "self")
    .option("--api-key-id <id>", "Target API key for self scope (management only)")
    .action(runDistillationModelSet);
  selector
    .command("delete")
    .option("--scope <scope>", "Selector scope: self or global", "self")
    .option("--api-key-id <id>", "Target API key for self scope (management only)")
    .action(runDistillationModelDelete);

  const distillation = memory
    .command("distillation")
    .description("Explicit sequential distillation runs");
  distillation
    .command("run")
    .description("Run L1->L2->L3 distillation for a session")
    .option("--api-key-id <id>", "Target API key (management only)")
    .option("--session <id>", "Session id to distill (required)")
    .option("--layers <list>", "Comma-separated layers (l1,l2,l3)", "l1,l2,l3")
    .option("--wait", "Poll until the run reaches a terminal status")
    .option("--timeout <ms>", "Total wait budget in ms (default 180000)", String, "180000")
    .action(runDistillationRun);

  const dlq = memory.command("dlq").description("Inspect and retry distillation failures");
  dlq
    .command("list")
    .option("--limit <n>", "Max entries (1-200, default 50)", String, "50")
    .option("--statuses <list>", "Comma-separated statuses")
    .action(runDlqList);
  dlq
    .command("retry [ids...]")
    .option("--all", "Retry all eligible entries")
    .option("--yes", "Confirm the retry")
    .action(runDlqRetry);
}
