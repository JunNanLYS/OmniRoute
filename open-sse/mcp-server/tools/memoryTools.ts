import { z } from "zod";

import { resolveOmniRouteBaseUrl } from "@/shared/utils/resolveOmniRouteBaseUrl.ts";

import { getMcpHttpAuthHeadersForInternalFetch } from "../httpAuthContext.ts";
import { resolveMcpCallerApiKeyId } from "../mcpCallerIdentity.ts";
import { resolveCallerScopeContext, type McpToolExtraLike } from "../scopeEnforcement.ts";
import { sanitizeErrorMessage } from "../../utils/error.ts";

const MAX_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_QUERY_LEN = 1024;
const MAX_ID_LEN = 256;
const MAX_SESSION_LEN = 256;

const safeLimit = z
  .number()
  .int()
  .min(MIN_LIMIT)
  .max(MAX_LIMIT)
  .optional()
  .describe("Max items to return (1-100)");

const safeQuery = z.string().min(1).max(MAX_QUERY_LEN).describe("Search query (1-1024 chars)");

const safeSession = z
  .string()
  .max(MAX_SESSION_LEN)
  .optional()
  .describe("Optional session id filter (max 256 chars)");

const safeScene = z
  .string()
  .max(MAX_ID_LEN)
  .optional()
  .describe("Optional scene name filter (max 256 chars)");

const safeId = z.string().min(1).max(MAX_ID_LEN).describe("Memory id (1-256 chars)");

type JsonRecord = Record<string, unknown>;

class MemoryApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MemoryApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataItems(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  return payload.data;
}

function detailData(payload: unknown): unknown | undefined {
  if (!isRecord(payload) || !("data" in payload)) return undefined;
  return payload.data;
}

function paginationTotal(payload: unknown, fallback: number): number {
  if (!isRecord(payload) || !isRecord(payload.pagination)) return fallback;
  const total = payload.pagination.total;
  return typeof total === "number" && Number.isFinite(total) ? total : fallback;
}

async function memoryFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const baseUrl = resolveOmniRouteBaseUrl();
  const apiKey = process.env.OMNIROUTE_API_KEY || "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...getMcpHttpAuthHeadersForInternalFetch(),
    ...((options.headers as Record<string, string>) || {}),
  };
  const signal = options.signal || AbortSignal.timeout(10000);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, { ...options, headers, signal });
  } catch (error: unknown) {
    throw new Error(
      `OmniRoute memory API request failed: ${sanitizeErrorMessage(error) || "network error"}`
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new MemoryApiError(
      response.status,
      `OmniRoute memory API error [${response.status}]: ${sanitizeErrorMessage(errorText)}`
    );
  }

  try {
    return await response.json();
  } catch {
    throw new MemoryApiError(
      response.status,
      `OmniRoute memory API error [${response.status}]: invalid JSON response`
    );
  }
}

async function resolveCallerOwner(
  extra: McpToolExtraLike | undefined
): Promise<string | undefined> {
  const principal = await resolveMcpCallerApiKeyId();
  if (principal) return principal;

  const { callerId } = resolveCallerScopeContext(extra, []);
  if (callerId && callerId !== "anonymous") return callerId;

  return undefined;
}

async function assertCallerOwner(
  extra: McpToolExtraLike | undefined,
  args: { apiKeyId?: unknown; ownerId?: unknown }
): Promise<string> {
  const principal = await resolveCallerOwner(extra);
  if (!principal) {
    throw new Error("Caller has no resolvable owner; refusing cross-tenant read.");
  }
  for (const claimed of [args.apiKeyId, args.ownerId]) {
    if (typeof claimed === "string" && claimed.trim().length > 0 && claimed !== principal) {
      throw new Error("Caller is not authorized to access memory for the given owner.");
    }
  }
  return principal;
}

type MemoryToolDefinition<Input extends z.ZodTypeAny, Output> = {
  name: string;
  description: string;
  scopes: readonly string[];
  inputSchema: Input;
  handler: (args: z.infer<Input>, extra?: McpToolExtraLike) => Promise<Output>;
};

type MemoryToolRecord = {
  [K in string]: MemoryToolDefinition<z.ZodTypeAny, unknown>;
};

const l0SearchInput = z.object({
  query: safeQuery,
  sessionId: safeSession,
  scene: safeScene,
  limit: safeLimit,
  apiKeyId: z.string().optional(),
  ownerId: z.string().optional(),
});

const l1SearchInput = z.object({
  query: safeQuery,
  sessionId: safeSession,
  scene: safeScene,
  limit: safeLimit,
  apiKeyId: z.string().optional(),
  ownerId: z.string().optional(),
});

const l2ReadInput = z.object({
  id: safeId,
  apiKeyId: z.string().optional(),
  ownerId: z.string().optional(),
});

const l3ReadInput = z.object({
  sessionId: safeSession,
  apiKeyId: z.string().optional(),
  ownerId: z.string().optional(),
});

const listInput = z.object({
  sessionId: safeSession,
  scene: safeScene,
  limit: safeLimit,
  apiKeyId: z.string().optional(),
  ownerId: z.string().optional(),
});

function listingParams(args: {
  query?: string;
  sessionId?: string;
  scene?: string;
  limit?: number;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (args.query) params.set("q", args.query);
  if (args.sessionId) params.set("sessionId", args.sessionId);
  if (args.scene) params.set("sceneName", args.scene);
  if (args.limit) params.set("limit", String(args.limit));
  return params;
}

function collectionPath(layer: "l0" | "l1" | "l2" | "l3", params: URLSearchParams): string {
  const query = params.toString();
  return `/api/memory/${layer}${query ? `?${query}` : ""}`;
}

async function handleL0Search(
  args: z.infer<typeof l0SearchInput>,
  extra?: McpToolExtraLike
): Promise<{ layer: "L0"; items: unknown[]; count: number; total: number }> {
  await assertCallerOwner(extra, args);
  const payload = await memoryFetch(collectionPath("l0", listingParams(args)));
  const items = dataItems(payload);
  return {
    layer: "L0",
    items,
    count: items.length,
    total: paginationTotal(payload, items.length),
  };
}

async function handleL1Search(
  args: z.infer<typeof l1SearchInput>,
  extra?: McpToolExtraLike
): Promise<{ layer: "L1"; items: unknown[]; count: number; total: number }> {
  await assertCallerOwner(extra, args);
  const payload = await memoryFetch(collectionPath("l1", listingParams(args)));
  const items = dataItems(payload);
  return {
    layer: "L1",
    items,
    count: items.length,
    total: paginationTotal(payload, items.length),
  };
}

async function handleL2Read(
  args: z.infer<typeof l2ReadInput>,
  extra?: McpToolExtraLike
): Promise<{ layer: "L2"; id: string; found: boolean; scene?: unknown }> {
  await assertCallerOwner(extra, args);
  try {
    const payload = await memoryFetch(`/api/memory/l2/${encodeURIComponent(args.id)}`);
    const scene = detailData(payload);
    return scene === undefined
      ? { layer: "L2", id: args.id, found: false }
      : { layer: "L2", id: args.id, found: true, scene };
  } catch (error: unknown) {
    if (error instanceof MemoryApiError && error.status === 404) {
      return { layer: "L2", id: args.id, found: false };
    }
    throw error;
  }
}

async function handleL3Read(
  args: z.infer<typeof l3ReadInput>,
  extra?: McpToolExtraLike
): Promise<{ layer: "L3"; sessionId?: string; found: boolean; persona?: unknown }> {
  await assertCallerOwner(extra, args);
  const params = listingParams({ sessionId: args.sessionId, limit: 1 });
  const payload = await memoryFetch(collectionPath("l3", params));
  const persona = dataItems(payload)[0];
  return persona === undefined
    ? { layer: "L3", sessionId: args.sessionId, found: false }
    : { layer: "L3", sessionId: args.sessionId, found: true, persona };
}

const LAYERS = ["L0", "L1", "L2", "L3"] as const;
type LayerName = (typeof LAYERS)[number];

function tagLayerItem(item: unknown, layer: LayerName): JsonRecord {
  return isRecord(item) ? { ...item, layer } : { value: item, layer };
}

async function handleList(
  args: z.infer<typeof listInput>,
  extra?: McpToolExtraLike
): Promise<{
  owner: string;
  layers: Record<LayerName, number>;
  items: JsonRecord[];
  count: number;
}> {
  const principal = await assertCallerOwner(extra, args);
  const params = listingParams(args);
  const payloads = await Promise.all(
    LAYERS.map((layer) =>
      memoryFetch(collectionPath(layer.toLowerCase() as Lowercase<LayerName>, params))
    )
  );

  const layers = { L0: 0, L1: 0, L2: 0, L3: 0 };
  const items: JsonRecord[] = [];
  payloads.forEach((payload, index) => {
    const layer = LAYERS[index];
    const layerItems = dataItems(payload);
    layers[layer] = paginationTotal(payload, layerItems.length);
    items.push(...layerItems.map((item) => tagLayerItem(item, layer)));
  });

  return { owner: principal, layers, items, count: items.length };
}

export const memoryTools: MemoryToolRecord = {
  omniroute_memory_l0_search: {
    name: "omniroute_memory_l0_search",
    description:
      "Search owner-scoped Layer-0 raw conversation traces through the live four-layer memory API.",
    scopes: ["read:memory"],
    inputSchema: l0SearchInput,
    handler: (args, extra) =>
      handleL0Search(l0SearchInput.parse(args ?? {}), extra) as unknown as Promise<unknown>,
  },
  omniroute_memory_l1_search: {
    name: "omniroute_memory_l1_search",
    description:
      "Search owner-scoped Layer-1 typed curated memories through the live four-layer memory API.",
    scopes: ["read:memory"],
    inputSchema: l1SearchInput,
    handler: (args, extra) =>
      handleL1Search(l1SearchInput.parse(args ?? {}), extra) as unknown as Promise<unknown>,
  },
  omniroute_memory_l2_read: {
    name: "omniroute_memory_l2_read",
    description:
      "Read one owner-scoped Layer-2 navigation scene by id through the live four-layer memory API.",
    scopes: ["read:memory"],
    inputSchema: l2ReadInput,
    handler: (args, extra) =>
      handleL2Read(l2ReadInput.parse(args ?? {}), extra) as unknown as Promise<unknown>,
  },
  omniroute_memory_l3_read: {
    name: "omniroute_memory_l3_read",
    description:
      "Read the current owner-scoped Layer-3 working context through the live four-layer memory API.",
    scopes: ["read:memory"],
    inputSchema: l3ReadInput,
    handler: (args, extra) =>
      handleL3Read(l3ReadInput.parse(args ?? {}), extra) as unknown as Promise<unknown>,
  },
  omniroute_memory_list: {
    name: "omniroute_memory_list",
    description:
      "Aggregate owner-scoped entries from the live L0, L1, L2, and L3 collection routes.",
    scopes: ["read:memory"],
    inputSchema: listInput,
    handler: (args, extra) =>
      handleList(listInput.parse(args ?? {}), extra) as unknown as Promise<unknown>,
  },
};

export { resolveCallerOwner, assertCallerOwner, memoryFetch };
