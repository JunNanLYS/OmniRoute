"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AppleButton, AppleCard, AppleField, AppleSelect, AppleSurface } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import {
  appendOwnerQuery,
  deleteJson,
  postJson,
  putJson,
  useDistillationDlq,
  useDistillationModel,
  useDistillationUsage,
  useProviderModels,
  type SourceLayer,
} from "../../hooks/useMemoryLayersApi";

const LAYER_LABEL_KEY: Record<SourceLayer, string> = {
  "per-key": "sourceLayerPerKey",
  global: "sourceLayerGlobal",
  env: "sourceLayerEnv",
  auto: "sourceLayerAuto",
};

type Scope = "self" | "global";

interface Props {
  apiKeyId?: string | null;
}

export default function DistillationSettingsTab({ apiKeyId }: Props) {
  const tDist = useTranslations("memory.distillation");
  const tCommon = useTranslations("memory.common");
  const notify = useNotificationStore();
  const dist = useDistillationModel({ apiKeyId });
  const dlq = useDistillationDlq({ apiKeyId });
  const usage = useDistillationUsage({ apiKeyId });
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [scope, setScope] = useState<Scope>("self");
  const [busy, setBusy] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const providerModels = useProviderModels(provider || null);

  // Fill the form fields once when the selector data first arrives, without
  // resetting user edits afterwards. Render-time adjustment (the "storing
  // information from previous renders" pattern) instead of setState-in-effect.
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
