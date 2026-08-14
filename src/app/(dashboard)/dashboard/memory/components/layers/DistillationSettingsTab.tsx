"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  AppleButton,
  AppleCard,
  AppleField,
  AppleInput,
  AppleSelect,
  AppleSurface,
  Toggle,
} from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import {
  appendOwnerQuery,
  deleteJson,
  postJson,
  putJson,
  useDistillationDlq,
  useDistillationModel,
  useDistillationUsage,
  useDistillationWorker,
  useMemoryPipelineSettings,
  useProviderModels,
  type SourceLayer,
} from "../../hooks/useMemoryLayersApi";

const LAYER_LABEL_KEY: Record<SourceLayer, string> = {
  "per-key": "sourceLayerPerKey",
  global: "sourceLayerGlobal",
  env: "sourceLayerEnv",
  auto: "sourceLayerAuto",
};

const PIPELINE_SOURCE_LABEL_KEY: Record<"per-key" | "env" | "default", string> = {
  "per-key": "pipelineSourcePerKey",
  env: "pipelineSourceEnv",
  default: "pipelineSourceDefault",
};

const WORKER_SOURCE_LABEL_KEY: Record<"stored" | "env" | "default", string> = {
  stored: "workerSourceStored",
  env: "workerSourceEnv",
  default: "workerSourceDefault",
};

type Scope = "self" | "global";

interface Props {
  apiKeyId?: string | null;
}

export default function DistillationSettingsTab({ apiKeyId }: Props) {
  const tDist = useTranslations("memory.distillation");
  const tCommon = useTranslations("memory.common");
  const notify = useNotificationStore();
  const pipeline = useMemoryPipelineSettings({ apiKeyId });
  const dist = useDistillationModel({ apiKeyId });
  const dlq = useDistillationDlq({ apiKeyId });
  const usage = useDistillationUsage({ apiKeyId });
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [scope, setScope] = useState<Scope>("self");
  const [busy, setBusy] = useState(false);
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [captureEnabled, setCaptureEnabled] = useState(false);
  const [injectionEnabled, setInjectionEnabled] = useState(false);
  const worker = useDistillationWorker();
  const [workerBusy, setWorkerBusy] = useState(false);
  const [workerEnabled, setWorkerEnabled] = useState(false);
  const [workerInterval, setWorkerInterval] = useState("60");
  const [workerConcurrency, setWorkerConcurrency] = useState("3");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const providerModels = useProviderModels(provider || null);

  // Fill the form fields once when the selector data first arrives, without
  // resetting user edits afterwards. Render-time adjustment (the "storing
  // information from previous renders" pattern) instead of setState-in-effect.
  const [lastPipelineData, setLastPipelineData] = useState(pipeline.data);
  if (pipeline.data && pipeline.data !== lastPipelineData) {
    setLastPipelineData(pipeline.data);
    setCaptureEnabled(pipeline.data.captureEnabled);
    setInjectionEnabled(pipeline.data.injectionEnabled);
  }

  const [lastWorkerData, setLastWorkerData] = useState(worker.data);
  if (worker.data && worker.data !== lastWorkerData) {
    setLastWorkerData(worker.data);
    setWorkerEnabled(worker.data.enabled);
    setWorkerInterval(String(worker.data.intervalSeconds));
    setWorkerConcurrency(String(worker.data.concurrency));
  }

  const [lastDistData, setLastDistData] = useState(dist.data);
  if (dist.data && dist.data !== lastDistData) {
    setLastDistData(dist.data);
    setProvider(
      (current) => current || (dist.data!.provider === "auto" ? "" : dist.data!.provider)
    );
    setModelId((current) => current || (dist.data!.modelId === "auto" ? "" : dist.data!.modelId));
  }

  const effectiveBadge = useMemo(
    () => (dist.data ? tDist(LAYER_LABEL_KEY[dist.data.sourceLayer]) : "—"),
    [dist.data, tDist]
  );

  const handlePipelineSave = async () => {
    setPipelineBusy(true);
    const result = await putJson(appendOwnerQuery("/api/memory/pipeline-settings", apiKeyId), {
      captureEnabled,
      injectionEnabled,
    });
    setPipelineBusy(false);
    if (result === null) {
      notify.error(tDist("pipelineSaveFailed"));
      return;
    }
    notify.success(tDist("pipelineSaved"));
    await pipeline.reload();
  };

  const handlePipelineReset = async () => {
    setPipelineBusy(true);
    const result = await deleteJson(appendOwnerQuery("/api/memory/pipeline-settings", apiKeyId));
    setPipelineBusy(false);
    if (result === null) {
      notify.error(tDist("pipelineResetFailed"));
      return;
    }
    notify.success(tDist("pipelineReset"));
    await pipeline.reload();
  };

  const handleWorkerSave = async () => {
    const interval = Number(workerInterval);
    const concurrency = Number(workerConcurrency);
    if (!Number.isInteger(interval) || interval < 1 || interval > 86_400) {
      notify.error(tDist("workerInvalidInterval"));
      return;
    }
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      notify.error(tDist("workerInvalidConcurrency"));
      return;
    }
    setWorkerBusy(true);
    const result = await putJson("/api/memory/distillation-worker", {
      enabled: workerEnabled,
      intervalSeconds: interval,
      concurrency,
    });
    setWorkerBusy(false);
    if (result === null) {
      notify.error(tDist("workerSaveFailed"));
      return;
    }
    notify.success(tDist("workerSaved"));
    await worker.reload();
  };

  const handleWorkerReset = async () => {
    setWorkerBusy(true);
    const result = await deleteJson("/api/memory/distillation-worker");
    setWorkerBusy(false);
    if (result === null) {
      notify.error(tDist("workerResetFailed"));
      return;
    }
    notify.success(tDist("workerReset"));
    await worker.reload();
  };

  const handleApply = async () => {
    setBusy(true);
    const result = await putJson(appendOwnerQuery("/api/memory/distillation-model", apiKeyId), {
      scope,
      provider,
      modelId,
    });
    setBusy(false);
    if (result === null) {
      notify.error(tDist("saveFailed"));
      return;
    }
    notify.success(tDist("saved"));
    await dist.reload();
  };

  const handleRemove = async () => {
    setBusy(true);
    const result = await deleteJson(
      appendOwnerQuery(
        `/api/memory/distillation-model?scope=${encodeURIComponent(scope)}`,
        apiKeyId
      )
    );
    setBusy(false);
    if (result === null) {
      notify.error(tDist("removeFailed"));
      return;
    }
    notify.success(tDist("removed"));
    await dist.reload();
  };

  const retryDlq = async (id: string) => {
    setRetryingId(id);
    const result = await postJson(
      appendOwnerQuery("/api/memory/distillation-model/dlq?op=retry", apiKeyId),
      { ids: [id] }
    );
    setRetryingId(null);
    if (result === null) {
      notify.error(tCommon("regenerateFailed"));
      return;
    }
    notify.success(tDist("dlqRetry"));
    await dlq.reload();
  };

  return (
    <div className="space-y-6">
      <AppleSurface className="p-4 sm:p-5">
        <h2 className="text-base font-semibold text-text-main">{tDist("title")}</h2>
        <p className="text-xs text-text-muted mt-1 max-w-xl">{tDist("description")}</p>
      </AppleSurface>

      <AppleCard data-testid="memory-pipeline-settings" className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-main">{tDist("pipelineTitle")}</h3>
            <p className="mt-1 max-w-2xl text-xs text-text-muted">{tDist("pipelineDescription")}</p>
          </div>
          {pipeline.data ? (
            <span
              className="inline-flex items-center rounded-full bg-primary/15 px-2 py-1 text-[11px] text-primary"
              data-testid="memory-pipeline-source"
              data-source-layer={pipeline.data.sourceLayer}
            >
              {tDist(PIPELINE_SOURCE_LABEL_KEY[pipeline.data.sourceLayer])}
            </span>
          ) : null}
        </div>

        {pipeline.isLoading ? (
          <p className="text-sm text-text-muted" role="status">
            {tCommon("loading")}
          </p>
        ) : pipeline.error || !pipeline.data ? (
          <p className="text-sm text-red-500" role="alert">
            {tDist("pipelineLoadFailed")}
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div
                className="rounded-xl border border-border bg-surface/60 p-4"
                data-testid="memory-capture-toggle"
              >
                <Toggle
                  checked={captureEnabled}
                  onChange={setCaptureEnabled}
                  disabled={pipelineBusy}
                  label={tDist("captureLabel")}
                  description={tDist("captureDescription")}
                  ariaLabel={tDist("captureLabel")}
                />
              </div>
              <div
                className="rounded-xl border border-border bg-surface/60 p-4"
                data-testid="memory-injection-toggle"
              >
                <Toggle
                  checked={injectionEnabled}
                  onChange={setInjectionEnabled}
                  disabled={pipelineBusy}
                  label={tDist("injectionLabel")}
                  description={tDist("injectionDescription")}
                  ariaLabel={tDist("injectionLabel")}
                />
              </div>
            </div>
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {tDist("pipelineCostWarning")}
            </p>
            <div className="flex flex-wrap gap-2">
              <AppleButton
                size="sm"
                onClick={handlePipelineSave}
                disabled={pipelineBusy}
                data-testid="memory-pipeline-save"
              >
                {tCommon("save")}
              </AppleButton>
              <AppleButton
                size="sm"
                variant="tertiary"
                onClick={handlePipelineReset}
                disabled={pipelineBusy || pipeline.data.sourceLayer !== "per-key"}
                data-testid="memory-pipeline-reset"
              >
                {tDist("pipelineUseFallback")}
              </AppleButton>
            </div>
          </>
        )}
      </AppleCard>

      <AppleCard data-testid="distillation-worker-settings" className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-main">{tDist("workerTitle")}</h3>
            <p className="mt-1 max-w-2xl text-xs text-text-muted">{tDist("workerDescription")}</p>
          </div>
          {worker.data ? (
            <span
              className="inline-flex items-center rounded-full bg-primary/15 px-2 py-1 text-[11px] text-primary"
              data-testid="distillation-worker-source"
              data-source-layer={worker.data.sourceLayer}
            >
              {tDist(WORKER_SOURCE_LABEL_KEY[worker.data.sourceLayer])}
            </span>
          ) : null}
        </div>

        {worker.isLoading ? (
          <p className="text-sm text-text-muted" role="status">
            {tCommon("loading")}
          </p>
        ) : worker.error || !worker.data ? (
          <p className="text-sm text-red-500" role="alert">
            {tDist("workerLoadFailed")}
          </p>
        ) : (
          <>
            <div
              className="rounded-xl border border-border bg-surface/60 p-4"
              data-testid="distillation-worker-toggle"
            >
              <Toggle
                checked={workerEnabled}
                onChange={setWorkerEnabled}
                disabled={workerBusy}
                label={tDist("workerEnableLabel")}
                description={tDist("workerEnableDescription")}
                ariaLabel={tDist("workerEnableLabel")}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <AppleField label={tDist("workerIntervalLabel")} hint={tDist("workerIntervalHint")}>
                <AppleInput
                  type="number"
                  min={1}
                  max={86_400}
                  step={1}
                  value={workerInterval}
                  onChange={(event) => setWorkerInterval(event.target.value)}
                  disabled={workerBusy}
                  data-testid="distillation-worker-interval"
                />
              </AppleField>
              <AppleField
                label={tDist("workerConcurrencyLabel")}
                hint={tDist("workerConcurrencyHint")}
              >
                <AppleInput
                  type="number"
                  min={1}
                  max={32}
                  step={1}
                  value={workerConcurrency}
                  onChange={(event) => setWorkerConcurrency(event.target.value)}
                  disabled={workerBusy}
                  data-testid="distillation-worker-concurrency"
                />
              </AppleField>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
              <span data-testid="distillation-worker-state">
                {tDist("workerState", { state: tDist(`workerState.${worker.data.runtime.state}`) })}
              </span>
              <span data-testid="distillation-worker-active">
                {tDist("workerActiveTasks", { count: worker.data.runtime.activeTasks })}
              </span>
            </div>
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {tDist("workerCostWarning")}
            </p>
            <div className="flex flex-wrap gap-2">
              <AppleButton
                size="sm"
                onClick={handleWorkerSave}
                disabled={workerBusy}
                data-testid="distillation-worker-save"
              >
                {tCommon("save")}
              </AppleButton>
              <AppleButton
                size="sm"
                variant="tertiary"
                onClick={handleWorkerReset}
                disabled={workerBusy || worker.data.sourceLayer === "default"}
                data-testid="distillation-worker-reset"
              >
                {tDist("workerUseFallback")}
              </AppleButton>
            </div>
          </>
        )}
      </AppleCard>

      <AppleCard data-testid="distillation-effective" className="space-y-3">
        {dist.isLoading ? (
          <p className="text-sm text-text-muted" role="status">
            {tCommon("loading")}
          </p>
        ) : dist.error || !dist.data ? (
          <p className="text-sm text-red-500" role="alert">
            {tDist("saveFailed")}
          </p>
        ) : (
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-1.5 min-w-0">
              <p className="text-xs text-text-muted">{tDist("effective")}</p>
              <p
                className="text-base font-medium text-text-main break-words"
                data-testid="distillation-effective-value"
              >
                {dist.data.provider} / {dist.data.modelId}
              </p>
            </div>
            <span
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-full bg-primary/15 text-primary"
              data-testid="distillation-source-layer"
              data-source-layer={dist.data.sourceLayer}
            >
              {tDist("sourceLayer")}: {effectiveBadge}
            </span>
          </div>
        )}
      </AppleCard>

      <AppleCard data-testid="distillation-override" className="space-y-3">
        <div>
          <p className="text-sm font-medium text-text-main">{tDist("override")}</p>
          <p className="text-xs text-text-muted">{tDist("overrideDesc")}</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <AppleField id="dist-scope" label={tDist("scope")}>
            <AppleSelect
              id="dist-scope"
              data-testid="distillation-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value as Scope)}
            >
              <option value="self">{tDist("scopeSelf")}</option>
              <option value="global" disabled={!dist.canSetGlobal}>
                {tDist("scopeGlobal")}
              </option>
            </AppleSelect>
          </AppleField>
          <AppleField id="dist-provider" label={tDist("provider")}>
            <AppleSelect
              id="dist-provider"
              data-testid="distillation-provider"
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value);
                setModelId("");
              }}
            >
              <option value="">{tDist("selectProvider")}</option>
              {["openai", "anthropic", "google"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </AppleSelect>
          </AppleField>
          <AppleField id="dist-model" label={tDist("model")}>
            <AppleSelect
              id="dist-model"
              data-testid="distillation-model"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              disabled={!provider || providerModels.isLoading}
            >
              <option value="">{tDist("selectModel")}</option>
              {(providerModels.data ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name ?? model.id}
                </option>
              ))}
            </AppleSelect>
            {providerModels.error && (
              <p className="text-[11px] text-red-500 mt-1">{tDist("loadModelsFailed")}</p>
            )}
          </AppleField>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AppleButton
            variant="primary"
            loading={busy}
            disabled={!provider || !modelId}
            onClick={handleApply}
            data-testid="distillation-apply"
          >
            {tDist("apply")}
          </AppleButton>
          <AppleButton
            variant="tertiary"
            loading={busy}
            onClick={handleRemove}
            data-testid="distillation-remove"
          >
            {tDist("remove")}
          </AppleButton>
        </div>
      </AppleCard>

      <AppleCard data-testid="distillation-usage" className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs font-medium text-text-muted">{tDist("usageTitle")}</p>
          {usage.data ? (
            <p className="text-[11px] text-text-muted" data-testid="distillation-usage-tasks">
              {tDist("usageTasks", { count: usage.data.totals.tasks })}
            </p>
          ) : null}
        </div>
        {usage.isLoading ? (
          <p className="text-xs text-text-muted" role="status">
            {tCommon("loading")}
          </p>
        ) : usage.error ? (
          <p className="text-xs text-red-500" role="alert">
            {tDist("loadUsageFailed")}
          </p>
        ) : !usage.data || usage.data.records.length === 0 ? (
          <p className="text-xs text-text-muted" data-testid="distillation-usage-empty">
            {tDist("usageEmpty")}
          </p>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div
                className="rounded-lg bg-surface/40 px-3 py-2"
                data-testid="distillation-usage-tokens"
              >
                <p className="text-[11px] text-text-muted">{tDist("usageTokens")}</p>
                <p className="text-base font-medium text-text-main">
                  {usage.data.totals.tokens.toLocaleString()}
                </p>
              </div>
              <div
                className="rounded-lg bg-surface/40 px-3 py-2"
                data-testid="distillation-usage-usd"
              >
                <p className="text-[11px] text-text-muted">{tDist("usageUsd")}</p>
                <p className="text-base font-medium text-text-main">
                  ${usage.data.totals.usd.toFixed(4)}
                </p>
              </div>
            </div>
            <ul className="space-y-1.5">
              {usage.data.records.slice(0, 5).map((row) => (
                <li
                  key={`${row.taskId ?? `${row.kind}:${row.recordedAt}`}`}
                  className="flex items-start justify-between gap-3 rounded-lg bg-surface/30 px-3 py-2"
                  data-testid={`distillation-usage-row-${row.id}`}
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-xs text-text-main break-words">
                      {row.provider} / {row.model}
                    </p>
                    <p className="text-[11px] text-text-muted">{row.kind}</p>
                  </div>
                  <p className="text-[11px] text-text-muted whitespace-nowrap">
                    {row.tokens.toLocaleString()} tok · ${row.usd.toFixed(4)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </AppleCard>

      <AppleCard data-testid="distillation-dlq" className="space-y-3">
        <p className="text-xs font-medium text-text-muted">{tDist("dlqTitle")}</p>
        {dlq.isLoading ? (
          <p className="text-xs text-text-muted" role="status">
            {tCommon("loading")}
          </p>
        ) : dlq.error ? (
          <p className="text-xs text-red-500" role="alert">
            {tCommon("regenerateFailed")}
          </p>
        ) : (dlq.data?.length ?? 0) === 0 ? (
          <p className="text-xs text-text-muted" data-testid="distillation-dlq-empty">
            {tDist("dlqEmpty")}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {dlq.data!.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start justify-between gap-3 rounded-lg bg-surface/40 px-3 py-2"
                data-testid={`distillation-dlq-${entry.id}`}
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs font-mono text-text-muted break-all">{entry.id}</p>
                  <p className="text-[11px] text-red-500 break-words">{entry.errorMessage}</p>
                </div>
                <AppleButton
                  size="sm"
                  variant="tertiary"
                  loading={retryingId === entry.id}
                  disabled={retryingId !== null}
                  onClick={() => retryDlq(entry.id)}
                  data-testid={`distillation-dlq-retry-${entry.id}`}
                >
                  {tDist("dlqRetry")}
                </AppleButton>
              </li>
            ))}
          </ul>
        )}
      </AppleCard>
    </div>
  );
}
