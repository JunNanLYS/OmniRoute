"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type SourceLayer = "per-key" | "global" | "env" | "auto";

export interface MemoryPipelineSettingsConfig {
  captureEnabled: boolean;
  injectionEnabled: boolean;
  l3CharBudget: number;
  l2CharBudget: number;
  l1CharBudget: number;
  totalCharBudget: number;
  recallTimeoutMs: number;
  sourceLayer: "per-key" | "env" | "default";
  apiKeyId: string | null;
}

export interface DistillationWorkerConfig {
  enabled: boolean;
  intervalSeconds: number;
  concurrency: number;
  sourceLayer: "stored" | "env" | "default";
  runtime: {
    state: "stopped" | "starting" | "running" | "stopping";
    activeTasks: number;
    configuredIntervalSeconds: number | null;
    configuredConcurrency: number | null;
  };
}

export interface DistillationModelConfig {
  provider: string;
  modelId: string;
  sourceLayer: SourceLayer;
  apiKeyId: string | null;
  scope: "self" | "global" | null;
  canSetGlobal: boolean;
}

export interface DistillationDlqEntry {
  id: string;
  ownerApiKeyId: string;
  sourceLayer: "l0" | "l1" | "l2" | "l3";
  sourceId: string | null;
  errorMessage: string;
  errorAt: string;
  retryCount: number;
  status: "pending" | "running" | "failed" | "succeeded";
  lastErrorCode: string | null;
}

export interface DistillationUsageRecord {
  id: number;
  ownerApiKeyId: string;
  kind: "L0_chunk_embed" | "L1_extract" | "L2_scene" | "L3_persona";
  provider: string;
  model: string;
  tokens: number;
  usd: number;
  recordedAt: string;
}

export interface L0Message {
  id: string;
  ownerApiKeyId: string;
  sessionKey: string;
  sessionId: string | null;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  recordedAt: string;
  source: "user" | "assistant" | "imported";
  correlationId: string | null;
  comboExecutionKey: string | null;
  isInternal: boolean;
  provider: string | null;
  model: string | null;
  truncated: boolean;
  idempotencyKey: string;
  deletedAt: string | null;
}

export type L0RecycleBinEntry = L0Message & { deletedAt: string };

export type L1Type =
  | "persona"
  | "episodic"
  | "instruction"
  | "work_fact"
  | "work_task"
  | "work_method"
  | "work_artifact";

export interface L1Memory {
  id: string;
  ownerApiKeyId: string;
  type: L1Type;
  priority: number;
  content: string;
  sceneName: string;
  metadata: Record<string, unknown>;
  sourceMessageIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
  deletedAt: string | null;
}

export interface L2Scene {
  id: string;
  ownerApiKeyId: string;
  sceneName: string;
  groupKey: string | null;
  summary: string;
  heat: number;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
  deletedAt: string | null;
}

export interface L3Prompt {
  id: string;
  ownerApiKeyId: string;
  content: string;
  promptMode: "chat" | "code";
  version: number;
  createdAt: string;
  updatedAt: string;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
  deletedAt: string | null;
}

export interface SyncedModel {
  id: string;
  name?: string;
  supportsVision?: boolean;
  supportsTools?: boolean;
}

export interface ApiResult<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  reload: () => Promise<void>;
}

interface UseQueryOptions {
  skip?: boolean;
  apiKeyId?: string | null;
}

interface ApiEnvelope<T> {
  data?: T;
  canSetGlobal?: boolean;
}

function requestError(error: unknown): string {
  if (error instanceof Error && /abort/i.test(error.message)) return "";
  return "request_failed";
}

function withQuery(path: string, values: Record<string, string | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

async function jsonRequest<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const response = await fetch(url, { ...init, signal });
  const data = (await response.json().catch(() => null)) as T | null;
  return { ok: response.ok, status: response.status, data };
}

function useLayerQuery<T>(
  url: string,
  options: UseQueryOptions,
  select: (payload: unknown) => T
): ApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!options.skip);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    if (options.skip) {
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setError(null);
    try {
      const result = await jsonRequest<unknown>(url, { method: "GET" }, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setData(null);
        setError("load_failed");
        return;
      }
      setData(select(result.data));
    } catch (caught) {
      if (!controller.signal.aborted) setError(requestError(caught) || "load_failed");
    } finally {
      if (!controller.signal.aborted) setIsLoading(false);
    }
  }, [options.skip, select, url]);

  useEffect(() => {
    void fetchOnce();
    return () => abortRef.current?.abort();
  }, [fetchOnce]);

  return { data, error, isLoading, reload: fetchOnce };
}

function envelopeArray<T>(payload: unknown): T[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as ApiEnvelope<unknown>).data;
  return Array.isArray(data) ? (data as T[]) : [];
}

export function useL0Messages(
  filter: { sessionId?: string; role?: L0Message["role"] } = {},
  options: UseQueryOptions = {}
): ApiResult<L0Message[]> {
  const url = withQuery("/api/memory/l0", {
    apiKeyId: options.apiKeyId,
    sessionId: filter.sessionId,
  });
  const select = useCallback(
    (payload: unknown) => {
      const rows = envelopeArray<L0Message>(payload);
      return filter.role ? rows.filter((row) => row.role === filter.role) : rows;
    },
    [filter.role]
  );
  return useLayerQuery(url, options, select);
}

export function useL0RecycleBin(options: UseQueryOptions = {}): ApiResult<L0RecycleBinEntry[]> {
  const url = withQuery("/api/memory/l0", {
    apiKeyId: options.apiKeyId,
    includeDeleted: "deleted",
  });
  const select = useCallback(
    (payload: unknown) =>
      envelopeArray<L0Message>(payload).filter(
        (row): row is L0RecycleBinEntry => typeof row.deletedAt === "string"
      ),
    []
  );
  return useLayerQuery(url, options, select);
}

export function useL1Memories(
  filter: { type?: L1Type | "all"; minPriority?: number; query?: string } = {},
  options: UseQueryOptions = {}
): ApiResult<L1Memory[]> {
  const url = withQuery("/api/memory/l1", {
    apiKeyId: options.apiKeyId,
    type: filter.type && filter.type !== "all" ? filter.type : undefined,
    q: filter.query,
    includeDeleted: "any",
  });
  const select = useCallback(
    (payload: unknown) => {
      const rows = envelopeArray<L1Memory>(payload);
      return typeof filter.minPriority === "number"
        ? rows.filter((row) => row.priority >= filter.minPriority!)
        : rows;
    },
    [filter.minPriority]
  );
  return useLayerQuery(url, options, select);
}

export function useL2Scenes(
  filter: { query?: string } = {},
  options: UseQueryOptions = {}
): ApiResult<L2Scene[]> {
  const url = withQuery("/api/memory/l2", {
    apiKeyId: options.apiKeyId,
    q: filter.query,
  });
  const select = useCallback((payload: unknown) => envelopeArray<L2Scene>(payload), []);
  return useLayerQuery(url, options, select);
}

export function useL3Prompts(options: UseQueryOptions = {}): ApiResult<L3Prompt[]> {
  const url = withQuery("/api/memory/l3", { apiKeyId: options.apiKeyId });
  const select = useCallback((payload: unknown) => envelopeArray<L3Prompt>(payload), []);
  return useLayerQuery(url, options, select);
}

export function useMemoryPipelineSettings(
  options: UseQueryOptions = {}
): ApiResult<MemoryPipelineSettingsConfig> {
  const url = withQuery("/api/memory/pipeline-settings", { apiKeyId: options.apiKeyId });
  const select = useCallback((payload: unknown): MemoryPipelineSettingsConfig => {
    const envelope =
      payload && typeof payload === "object"
        ? (payload as ApiEnvelope<MemoryPipelineSettingsConfig>)
        : {};
    const data = envelope.data;
    return {
      captureEnabled: data?.captureEnabled === true,
      injectionEnabled: data?.injectionEnabled === true,
      l3CharBudget: Number(data?.l3CharBudget ?? 600),
      l2CharBudget: Number(data?.l2CharBudget ?? 600),
      l1CharBudget: Number(data?.l1CharBudget ?? 600),
      totalCharBudget: Number(data?.totalCharBudget ?? 8000),
      recallTimeoutMs: Number(data?.recallTimeoutMs ?? 5000),
      sourceLayer:
        data?.sourceLayer === "per-key" || data?.sourceLayer === "env"
          ? data.sourceLayer
          : "default",
      apiKeyId: typeof data?.apiKeyId === "string" ? data.apiKeyId : null,
    };
  }, []);
  return useLayerQuery(url, options, select);
}

export function useDistillationWorker(): ApiResult<DistillationWorkerConfig> {
  const url = "/api/memory/distillation-worker";
  const select = useCallback((payload: unknown): DistillationWorkerConfig => {
    const envelope =
      payload && typeof payload === "object"
        ? (payload as ApiEnvelope<DistillationWorkerConfig>)
        : {};
    const data = envelope.data;
    const runtime = data?.runtime;
    return {
      enabled: data?.enabled === true,
      intervalSeconds: Number(data?.intervalSeconds ?? 60),
      concurrency: Number(data?.concurrency ?? 3),
      sourceLayer:
        data?.sourceLayer === "stored" || data?.sourceLayer === "env"
          ? data.sourceLayer
          : "default",
      runtime: {
        state: runtime?.state ?? "stopped",
        activeTasks: Number(runtime?.activeTasks ?? 0),
        configuredIntervalSeconds:
          runtime?.configuredIntervalSeconds === null ||
          runtime?.configuredIntervalSeconds === undefined
            ? null
            : Number(runtime.configuredIntervalSeconds),
        configuredConcurrency:
          runtime?.configuredConcurrency === null || runtime?.configuredConcurrency === undefined
            ? null
            : Number(runtime.configuredConcurrency),
      },
    };
  }, []);
  return useLayerQuery(url, { skip: false }, select);
}

export function useDistillationModel(
  options: UseQueryOptions = {}
): ApiResult<DistillationModelConfig> & { canSetGlobal: boolean } {
  const url = withQuery("/api/memory/distillation-model", { apiKeyId: options.apiKeyId });
  const select = useCallback((payload: unknown): DistillationModelConfig => {
    const envelope =
      payload && typeof payload === "object"
        ? (payload as ApiEnvelope<Omit<DistillationModelConfig, "canSetGlobal">>)
        : {};
    const selector = envelope.data;
    return {
      provider: selector?.provider ?? "auto",
      modelId: selector?.modelId ?? "auto",
      sourceLayer: selector?.sourceLayer ?? "auto",
      apiKeyId: selector?.apiKeyId ?? null,
      scope: selector?.scope ?? null,
      canSetGlobal: envelope.canSetGlobal === true,
    };
  }, []);
  const result = useLayerQuery(url, options, select);
  return { ...result, canSetGlobal: result.data?.canSetGlobal ?? false };
}

export function useDistillationDlq(
  options: UseQueryOptions = {}
): ApiResult<DistillationDlqEntry[]> {
  const url = withQuery("/api/memory/distillation-model/dlq", {
    apiKeyId: options.apiKeyId,
  });
  const select = useCallback(
    (payload: unknown) => envelopeArray<DistillationDlqEntry>(payload),
    []
  );
  return useLayerQuery(url, options, select);
}

export interface DistillationUsageResponse {
  records: Array<{
    id: number;
    ownerApiKeyId: string;
    kind: DistillationUsageRecord["kind"];
    provider: string;
    model: string;
    tokens: number;
    usd: number;
    recordedAt: string;
  }>;
  totals: { tokens: number; usd: number; tasks: number };
}

export function useDistillationUsage(
  options: UseQueryOptions = {}
): ApiResult<DistillationUsageResponse> {
  const url = withQuery("/api/memory/distillation-model/usage", {
    apiKeyId: options.apiKeyId,
  });
  const select = useCallback((payload: unknown): DistillationUsageResponse => {
    const envelope =
      payload && typeof payload === "object"
        ? (payload as {
            data?: DistillationUsageResponse["records"];
            totals?: DistillationUsageResponse["totals"];
          })
        : {};
    return {
      records: Array.isArray(envelope.data) ? envelope.data : [],
      totals: {
        tokens: Number(envelope.totals?.tokens ?? 0),
        usd: Number(envelope.totals?.usd ?? 0),
        tasks: Number(envelope.totals?.tasks ?? 0),
      },
    };
  }, []);
  return useLayerQuery(url, options, select);
}

export interface L0CaptureStatus {
  ownerApiKeyId: string;
  successCount: number;
  failureCount: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCategory: string | null;
}

export function useL0CaptureStatus(options: UseQueryOptions = {}): ApiResult<L0CaptureStatus> {
  const url = withQuery("/api/memory/l0/status", { apiKeyId: options.apiKeyId });
  const select = useCallback((payload: unknown): L0CaptureStatus => {
    const envelope =
      payload && typeof payload === "object" ? (payload as { data?: L0CaptureStatus }) : {};
    const data = envelope.data;
    return {
      ownerApiKeyId: typeof data?.ownerApiKeyId === "string" ? data.ownerApiKeyId : "",
      successCount: Number(data?.successCount ?? 0),
      failureCount: Number(data?.failureCount ?? 0),
      lastSuccessAt: typeof data?.lastSuccessAt === "string" ? data.lastSuccessAt : null,
      lastFailureAt: typeof data?.lastFailureAt === "string" ? data.lastFailureAt : null,
      lastFailureCategory:
        typeof data?.lastFailureCategory === "string" ? data.lastFailureCategory : null,
    };
  }, []);
  return useLayerQuery(url, options, select);
}

export function useProviderModels(provider: string | null): ApiResult<SyncedModel[]> {
  const url = provider
    ? `/api/synced-available-models?provider=${encodeURIComponent(provider)}`
    : "";
  const select = useCallback((payload: unknown): SyncedModel[] => {
    if (Array.isArray(payload)) return payload as SyncedModel[];
    if (!payload || typeof payload !== "object") return [];
    const models = (payload as { models?: unknown }).models;
    return Array.isArray(models) ? (models as SyncedModel[]) : [];
  }, []);
  return useLayerQuery(url, { skip: !provider }, select);
}

async function mutateJson<T>(
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown
): Promise<T | null> {
  try {
    const response = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok) return null;
    return (await response.json().catch(() => null)) as T | null;
  } catch {
    return null;
  }
}

export function postJson<T>(url: string, body: unknown): Promise<T | null> {
  return mutateJson<T>(url, "POST", body);
}

export function putJson<T>(url: string, body: unknown): Promise<T | null> {
  return mutateJson<T>(url, "PUT", body);
}

export function deleteJson<T>(url: string, body?: unknown): Promise<T | null> {
  return mutateJson<T>(url, "DELETE", body);
}

export function ownerQuery(apiKeyId?: string | null): string {
  return apiKeyId ? `apiKeyId=${encodeURIComponent(apiKeyId)}` : "";
}

export function appendOwnerQuery(url: string, apiKeyId?: string | null): string {
  if (!apiKeyId) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${ownerQuery(apiKeyId)}`;
}

export function truncId(id: string, head = 6, tail = 4): string {
  if (!id) return "";
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}
