"use client";

/**
 * L0Tab — raw, immutable conversation messages (L0 layer).
 *
 * Surfaces only public metadata: session id, timestamp, role, provider, model.
 * Internal markers like is_internal / combo_execution_key are deliberately
 * hidden. Soft-deleted messages appear in the recycle bin section, where
 * restore / permanent-delete flows are double-confirmed.
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AppleButton, AppleCard, AppleSurface, Modal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import {
  appendOwnerQuery,
  deleteJson,
  postJson,
  truncId,
  useL0CaptureStatus,
  useL0Messages,
  useL0RecycleBin,
  type L0Message,
  type L0RecycleBinEntry,
} from "../../hooks/useMemoryLayersApi";

interface Props {
  initialSessionId?: string | null;
  apiKeyId?: string | null;
}

const ROLE_TONE: Record<L0Message["role"], string> = {
  user: "bg-blue-500/15 text-blue-500",
  assistant: "bg-emerald-500/15 text-emerald-500",
};

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function L0Tab({ initialSessionId, apiKeyId }: Props) {
  const t = useTranslations("memory");
  const tCommon = useTranslations("memory.common");
  const notify = useNotificationStore();
  const [sessionFilter, setSessionFilter] = useState<string>(initialSessionId ?? "");
  const [roleFilter, setRoleFilter] = useState<L0Message["role"] | "all">("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<L0Message | null>(null);
  const [permDeleteTarget, setPermDeleteTarget] = useState<L0RecycleBinEntry | null>(null);
  const [permDeleteTargetMessage, setPermDeleteTargetMessage] = useState<L0Message | null>(null);
  const [permConfirmText, setPermConfirmText] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const filter = useMemo(
    () => ({
      sessionId: sessionFilter || undefined,
      role: roleFilter === "all" ? undefined : roleFilter,
    }),
    [sessionFilter, roleFilter]
  );

  const messages = useL0Messages(filter, { apiKeyId });
  const recycleBin = useL0RecycleBin({ apiKeyId });
  const captureStatus = useL0CaptureStatus({ apiKeyId });

  // Sync the URL-derived initial session id into the filter only when the
  // prop itself changes (render-time adjustment, not setState-in-effect).
  const [prevInitialSessionId, setPrevInitialSessionId] = useState(initialSessionId);
  if (initialSessionId && initialSessionId !== prevInitialSessionId) {
    setPrevInitialSessionId(initialSessionId);
    setSessionFilter(initialSessionId);
  }

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearFilters = () => {
    setSessionFilter("");
    setRoleFilter("all");
  };

  const handleSoftDelete = async (m: L0Message) => {
    setBusy(true);
    const ok = await deleteJson(
      appendOwnerQuery(`/api/memory/l0/${encodeURIComponent(m.id)}`, apiKeyId),
      { mode: "soft" }
    );
    setBusy(false);
    if (ok == null) {
      notify.error(t("l0.deleteMessage") + " — failed");
      return;
    }
    notify.success(t("l0.deleteMessage") + " — ok");
    setDeleteTarget(null);
    messages.reload();
    recycleBin.reload();
  };

  const handleRestore = async (id: string) => {
    const ok = await postJson(
      appendOwnerQuery(`/api/memory/l0/${encodeURIComponent(id)}?op=restore`, apiKeyId),
      {}
    );
    if (ok == null) {
      notify.error(t("l0.restoreFailed"));
      return;
    }
    notify.success(t("l0.restore"));
    recycleBin.reload();
    messages.reload();
  };

  const handlePermDelete = async (id: string) => {
    const ok = await deleteJson(
      appendOwnerQuery(`/api/memory/l0/${encodeURIComponent(id)}`, apiKeyId),
      { mode: "permanent" }
    );
    if (ok == null) {
      notify.error(t("l0.permanentDeleteFailed"));
      return;
    }
    notify.success(t("l0.permanentDelete"));
    setPermDeleteTarget(null);
    setPermDeleteTargetMessage(null);
    setPermConfirmText("");
    recycleBin.reload();
    messages.reload();
  };

  const items = messages.data ?? [];
  const binItems = recycleBin.data ?? [];

  return (
    <div className="space-y-6">
      <AppleSurface className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-text-main">{t("l0.title")}</h2>
            <p className="text-xs text-text-muted mt-1 max-w-xl">{t("l0.description")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              role="searchbox"
              aria-label={t("l0.filterSession")}
              data-testid="l0-session-filter"
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value)}
              placeholder={t("l0.filterSession")}
              className="px-3 py-1.5 text-xs rounded-full bg-surface border border-border text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <select
              data-testid="l0-role-filter"
              aria-label={t("l0.filterRole")}
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as typeof roleFilter)}
              className="px-3 py-1.5 text-xs rounded-full bg-surface border border-border text-text-main"
            >
              <option value="all">{t("l0.allRoles")}</option>
              <option value="user">{t("l0.roleUser")}</option>
              <option value="assistant">{t("l0.roleAssistant")}</option>
            </select>
            {(sessionFilter || roleFilter !== "all") && (
              <AppleButton
                size="sm"
                variant="tertiary"
                data-testid="l0-clear-filters"
                onClick={clearFilters}
              >
                {t("clearFilters")}
              </AppleButton>
            )}
          </div>
        </div>
      </AppleSurface>

      <AppleCard data-testid="l0-capture-status" className="space-y-3">
        <p className="text-xs font-medium text-text-muted">{t("l0.captureStatusTitle")}</p>
        {captureStatus.isLoading ? (
          <p className="text-xs text-text-muted" role="status">
            {tCommon("loading")}
          </p>
        ) : captureStatus.error || !captureStatus.data ? (
          <p className="text-xs text-red-500" role="alert">
            {t("l0.loadStatusFailed")}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="rounded-lg bg-surface/40 px-3 py-2" data-testid="l0-capture-success">
              <p className="text-[11px] text-text-muted">{t("l0.captureSuccess")}</p>
              <p className="text-base font-medium text-text-main">
                {captureStatus.data.successCount.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg bg-surface/40 px-3 py-2" data-testid="l0-capture-failure">
              <p className="text-[11px] text-text-muted">{t("l0.captureFailure")}</p>
              <p className="text-base font-medium text-text-main">
                {captureStatus.data.failureCount.toLocaleString()}
              </p>
            </div>
            <div className="sm:col-span-2 text-[11px] text-text-muted space-y-0.5">
              <p data-testid="l0-capture-last-success">
                {t("l0.captureLastSuccess", {
                  when: captureStatus.data.lastSuccessAt ?? "—",
                })}
              </p>
              <p data-testid="l0-capture-last-failure">
                {t("l0.captureLastFailure", {
                  when: captureStatus.data.lastFailureAt ?? "—",
                  category: captureStatus.data.lastFailureCategory ?? "—",
                })}
              </p>
            </div>
          </div>
        )}
      </AppleCard>

      {/* Messages list */}
      <AppleCard className="space-y-3" data-testid="l0-messages">
        {messages.isLoading ? (
          <p className="text-sm text-text-muted" role="status" aria-live="polite">
            {tCommon("loading")}
          </p>
        ) : messages.error ? (
          <p className="text-sm text-red-500" role="alert">
            {t("l0.loadFailed")}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-text-muted" data-testid="l0-empty">
            {t("l0.noMessages")}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {items.map((m) => {
              const isOpen = expanded.has(m.id);
              return (
                <li
                  key={m.id}
                  className="py-3"
                  data-testid={`l0-message-${m.id}`}
                  data-internal-flag={m.role}
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full font-medium ${ROLE_TONE[m.role]}`}
                        >
                          {t(`l0.role${m.role.charAt(0).toUpperCase()}${m.role.slice(1)}`)}
                        </span>
                        <span className="font-mono text-text-muted">
                          {t("l0.sessionLabel", { id: truncId(m.sessionId) })}
                        </span>
                        <span className="text-text-muted">{formatTimestamp(m.timestamp)}</span>
                        {m.provider ? (
                          <span className="text-text-muted">
                            {t("l0.provider")}: {m.provider}
                          </span>
                        ) : null}
                        {m.model ? (
                          <span className="text-text-muted">
                            {t("l0.model")}: {m.model}
                          </span>
                        ) : null}
                      </div>
                      {isOpen && (
                        <pre
                          className="text-xs whitespace-pre-wrap break-words text-text-main bg-surface/40 rounded-lg p-3 mt-2"
                          data-testid={`l0-content-${m.id}`}
                        >
                          {m.content}
                        </pre>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <AppleButton
                        size="sm"
                        variant="tertiary"
                        onClick={() => toggleExpand(m.id)}
                        aria-expanded={isOpen}
                        data-testid={`l0-toggle-${m.id}`}
                      >
                        {isOpen ? t("l0.collapse") : t("l0.expand")}
                      </AppleButton>
                      <AppleButton
                        size="sm"
                        variant="secondary"
                        onClick={() => setDeleteTarget(m)}
                        data-testid={`l0-delete-${m.id}`}
                      >
                        {tCommon("delete")}
                      </AppleButton>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </AppleCard>

      {/* Recycle bin */}
      <AppleCard data-testid="l0-recycle-bin" className="space-y-3">
        <h3 className="text-sm font-semibold text-text-main">{t("l0.recycleBin")}</h3>
        {recycleBin.isLoading ? (
          <p className="text-xs text-text-muted" role="status" aria-live="polite">
            {tCommon("loading")}
          </p>
        ) : binItems.length === 0 ? (
          <p className="text-xs text-text-muted" data-testid="l0-recycle-empty">
            {tCommon("empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {binItems.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 rounded-lg bg-surface/40 px-3 py-2"
                data-testid={`l0-recycle-${row.id}`}
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs font-mono text-text-muted truncate">
                    {t("l0.sessionLabel", { id: truncId(row.sessionId) })} —{" "}
                    {t(`l0.role${row.role.charAt(0).toUpperCase()}${row.role.slice(1)}`)}
                  </p>
                  <p className="text-xs text-text-main truncate">{row.content.slice(0, 120)}</p>
                  <p className="text-[11px] text-text-muted">
                    {t("l0.deleted", { when: formatTimestamp(row.deletedAt) })}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <AppleButton
                    size="sm"
                    variant="secondary"
                    onClick={() => handleRestore(row.id)}
                    data-testid={`l0-restore-${row.id}`}
                  >
                    {t("l0.restore")}
                  </AppleButton>
                  <AppleButton
                    size="sm"
                    variant="tertiary"
                    onClick={() => setPermDeleteTarget(row)}
                    data-testid={`l0-perm-delete-${row.id}`}
                  >
                    {t("l0.permanentDelete")}
                  </AppleButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AppleCard>

      {/* Soft-delete confirmation */}
      <Modal
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title={tCommon("confirmDeleteTitle")}
        footer={
          <>
            <AppleButton variant="tertiary" onClick={() => setDeleteTarget(null)} disabled={busy}>
              {tCommon("cancel")}
            </AppleButton>
            <AppleButton
              variant="primary"
              loading={busy}
              onClick={() => deleteTarget && handleSoftDelete(deleteTarget)}
              data-testid="l0-confirm-delete"
            >
              {tCommon("delete")}
            </AppleButton>
          </>
        }
      >
        <p className="text-sm text-text-muted">{tCommon("confirmDeleteDesc")}</p>
      </Modal>

      {/* Permanent-delete confirmation (recycle bin row) — double confirm with text */}
      <Modal
        isOpen={Boolean(permDeleteTarget || permDeleteTargetMessage)}
        onClose={() => {
          setPermDeleteTarget(null);
          setPermDeleteTargetMessage(null);
          setPermConfirmText("");
        }}
        title={tCommon("confirmPermanentDeleteTitle")}
        footer={
          <>
            <AppleButton
              variant="tertiary"
              onClick={() => {
                setPermDeleteTarget(null);
                setPermDeleteTargetMessage(null);
                setPermConfirmText("");
              }}
              disabled={busy}
            >
              {tCommon("cancel")}
            </AppleButton>
            <AppleButton
              variant="primary"
              disabled={busy || permConfirmText !== "DELETE"}
              loading={busy}
              data-testid="l0-confirm-perm-delete"
              onClick={() => {
                const id = permDeleteTarget?.id ?? permDeleteTargetMessage?.id;
                if (id) void handlePermDelete(id);
              }}
            >
              {tCommon("permanentDelete")}
            </AppleButton>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-text-muted">
            {permDeleteTarget
              ? t("l0.permanentDeleteConfirmSession")
              : t("l0.permanentDeleteConfirm")}
          </p>
          <input
            type="text"
            value={permConfirmText}
            onChange={(e) => setPermConfirmText(e.target.value)}
            placeholder="DELETE"
            data-testid="l0-perm-confirm-input"
            className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </Modal>
    </div>
  );
}
