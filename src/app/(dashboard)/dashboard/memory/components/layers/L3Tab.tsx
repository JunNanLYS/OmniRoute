"use client";

/**
 * L3Tab — prompts (L3 layer).
 *
 * Each prompt has a mode (chat | code), full content (≤ 2000 chars), version,
 * modifier, and lineage links back to L1 memories and L2 scenes. Edit / clear
 * / regenerate flows are wired to /api/memory/l3/prompts/*.
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AppleButton, AppleCard, AppleField, AppleSurface, Modal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import {
  appendOwnerQuery,
  deleteJson,
  postJson,
  putJson,
  truncId,
  useL3Prompts,
  type L3Prompt,
} from "../../hooks/useMemoryLayersApi";

const MAX_LEN = 2000;

interface Props {
  apiKeyId?: string | null;
}

export default function L3Tab({ apiKeyId }: Props) {
  const t = useTranslations("memory");
  const tCommon = useTranslations("memory.common");
  const notify = useNotificationStore();
  const [editState, setEditState] = useState<L3Prompt | null>(null);
  const [clearId, setClearId] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const prompts = useL3Prompts({ apiKeyId });
  const items = useMemo(() => prompts.data ?? [], [prompts.data]);

  const handleSave = async () => {
    if (!editState) return;
    if (editState.content.length > MAX_LEN) {
      notify.error(t("l3.contentTooLong"));
      return;
    }
    setBusy(true);
    const ok = await putJson(
      appendOwnerQuery(`/api/memory/l3/${encodeURIComponent(editState.id)}`, apiKeyId),
      {
        promptMode: editState.promptMode,
        content: editState.content,
        expectedVersion: editState.version,
      }
    );
    setBusy(false);
    if (ok == null) {
      notify.error(tCommon("saveFailed"));
      return;
    }
    notify.success(t("l3.editSucceeded"));
    setEditState(null);
    prompts.reload();
  };

  const handleClear = async (id: string) => {
    setBusy(true);
    const ok = await deleteJson(
      appendOwnerQuery(`/api/memory/l3/${encodeURIComponent(id)}`, apiKeyId),
      { mode: "soft" }
    );
    setBusy(false);
    if (ok == null) {
      notify.error(tCommon("deleteFailed"));
      return;
    }
    notify.success(t("l3.clearSucceeded"));
    setClearId(null);
    prompts.reload();
  };

  const handleRegenerate = async () => {
    const ok = await postJson(appendOwnerQuery("/api/memory/l3", apiKeyId), {});
    if (ok == null) {
      notify.error(t("l3.regenerateFailed"));
      return;
    }
    notify.success(t("l3.regenerateSucceeded"));
    prompts.reload();
  };

  return (
    <div className="space-y-6">
      <AppleSurface className="p-4 sm:p-5">
        <div>
          <h2 className="text-base font-semibold text-text-main">{t("l3.title")}</h2>
          <p className="text-xs text-text-muted mt-1 max-w-xl">{t("l3.description")}</p>
        </div>
      </AppleSurface>

      <AppleCard data-testid="l3-prompts" className="space-y-3">
        {prompts.isLoading ? (
          <p className="text-sm text-text-muted" role="status" aria-live="polite">
            {tCommon("loading")}
          </p>
        ) : prompts.error ? (
          <p className="text-sm text-red-500" role="alert">
            {t("l3.loadFailed")}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-text-muted" data-testid="l3-empty">
            {t("l3.noPrompts")}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {items.map((p) => (
              <li
                key={p.id}
                className="py-3"
                data-testid={`l3-prompt-${p.id}`}
                data-mode={p.promptMode}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="font-mono text-text-muted">{truncId(p.id)}</span>
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">
                        {t(p.promptMode === "chat" ? "l3.modeChat" : "l3.modeCode")}
                      </span>
                      <span className="text-text-muted">
                        {tCommon("version")}: {p.version}
                      </span>
                      <span className="text-text-muted">
                        {t("l3.modifier")}: {p.lastModifiedBy}
                      </span>
                      <span className="text-text-muted">
                        {t("l3.characterCount", { count: p.content.length })}
                      </span>
                    </div>
                    <p className="text-sm text-text-main whitespace-pre-wrap break-words font-mono bg-surface/40 p-3 rounded-lg">
                      {p.content}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 shrink-0">
                    <AppleButton
                      size="sm"
                      variant="secondary"
                      onClick={() => setEditState(p)}
                      data-testid={`l3-edit-${p.id}`}
                    >
                      {tCommon("edit")}
                    </AppleButton>
                    <AppleButton
                      size="sm"
                      variant="tertiary"
                      onClick={handleRegenerate}
                      data-testid={`l3-regenerate-${p.id}`}
                    >
                      {tCommon("regenerate")}
                    </AppleButton>
                    <AppleButton
                      size="sm"
                      variant="tertiary"
                      onClick={() => setClearId(p.id)}
                      data-testid={`l3-clear-${p.id}`}
                    >
                      {tCommon("clear")}
                    </AppleButton>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AppleCard>

      <Modal
        isOpen={Boolean(editState)}
        onClose={() => setEditState(null)}
        title={t("l3.edit")}
        footer={
          <>
            <AppleButton variant="tertiary" onClick={() => setEditState(null)} disabled={busy}>
              {tCommon("cancel")}
            </AppleButton>
            <AppleButton
              variant="primary"
              loading={busy}
              disabled={!editState || editState.content.length > MAX_LEN}
              onClick={handleSave}
              data-testid="l3-save"
            >
              {tCommon("save")}
            </AppleButton>
          </>
        }
      >
        {editState && (
          <div className="space-y-3">
            <AppleField id="l3-edit-mode" label={t("l3.mode")}>
              <span className="text-xs px-2 py-1 rounded-full bg-surface border border-border text-text-muted">
                {editState.promptMode === "chat" ? t("l3.modeChat") : t("l3.modeCode")}
              </span>
            </AppleField>
            <AppleField
              id="l3-edit-content"
              label={t("l3.content")}
              hint={t("l3.characterCount", { count: editState.content.length })}
              error={editState.content.length > MAX_LEN ? t("l3.contentTooLong") : undefined}
            >
              <textarea
                id="l3-edit-content"
                rows={8}
                value={editState.content}
                maxLength={MAX_LEN + 200}
                onChange={(e) => setEditState({ ...editState, content: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                data-testid="l3-edit-content"
              />
            </AppleField>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={Boolean(clearId)}
        onClose={() => setClearId(null)}
        title={t("l3.clear")}
        footer={
          <>
            <AppleButton variant="tertiary" onClick={() => setClearId(null)} disabled={busy}>
              {tCommon("cancel")}
            </AppleButton>
            <AppleButton
              variant="primary"
              loading={busy}
              onClick={() => clearId && handleClear(clearId)}
              data-testid="l3-confirm-clear"
            >
              {tCommon("clear")}
            </AppleButton>
          </>
        }
      >
        <p className="text-sm text-text-muted">{t("l3.clearConfirm")}</p>
      </Modal>
    </div>
  );
}
