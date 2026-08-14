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

export function registerMemory(program) {
  const memory = program.command("memory").description(t("memory.description"));

  const l0 = memory.command("l0").description("Layer-0 raw trace operations");
  l0.command("search <query>")
    .description("Search layer-0 raw traces")
    .option("--session <id>", "Filter by session id")
    .option("--scene <name>", "Filter by scene name")
    .option("--limit <n>", "Max items to return (1-100, default 20)", String, "20")
    .action(runL0Search);

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
