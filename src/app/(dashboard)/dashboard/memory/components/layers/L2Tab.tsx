"use client";

/**
 * L2Tab — scenes (L2 layer).
 *
 * Each scene has heat, activation count, version, modifier, content, optional
 * pending status, and links to its atoms and persona. Edit / delete /
 * regenerate flows are wired to /api/memory/l2/scenes/*.
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  AppleButton,
  AppleCard,
  AppleField,
  AppleInput,
  AppleSurface,
  Modal,
} from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import {
  appendOwnerQuery,
  deleteJson,
  postJson,
  putJson,
  truncId,
  useL2Scenes,
  type L2Scene,
} from "../../hooks/useMemoryLayersApi";

interface EditState {
  id: string;
  summary: string;
  content: string;
  expectedVersion: number;
}

interface Props {
  apiKeyId?: string | null;
}

export default function L2Tab({ apiKeyId }: Props) {
  const t = useTranslations("memory");
  const tCommon = useTranslations("memory.common");
  const notify = useNotificationStore();
  const [search, setSearch] = useState<string>("");
  const [editState, setEditState] = useState<EditState | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const scenes = useL2Scenes({ query: search }, { apiKeyId });
  const items = useMemo(() => scenes.data ?? [], [scenes.data]);

  const openEdit = (scene: L2Scene) =>
    setEditState({
      id: scene.id,
      summary: scene.summary,
      content: scene.content,
      expectedVersion: scene.version,
    });

  const handleSave = async () => {
    if (!editState?.id) return;
    setBusy(true);
    const ok = await putJson(
      appendOwnerQuery(`/api/memory/l2/${encodeURIComponent(editState.id)}`, apiKeyId),
      {
        summary: editState.summary,
        content: editState.content,
        expectedVersion: editState.expectedVersion,
      }
    );
    setBusy(false);
    if (ok == null) {
      notify.error(tCommon("saveFailed"));
      return;
    }
    notify.success(t("l2.editSucceeded"));
    setEditState(null);
    scenes.reload();
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    const ok = await deleteJson(
      appendOwnerQuery(`/api/memory/l2/${encodeURIComponent(id)}`, apiKeyId),
      { mode: "soft" }
    );
    setBusy(false);
    if (ok == null) {
      notify.error(tCommon("deleteFailed"));
      return;
    }
    notify.success(t("l2.deleteSucceeded"));
    setDeleteId(null);
    scenes.reload();
  };

  const handleRegenerate = async (id: string) => {
    const ok = await postJson(
      appendOwnerQuery(`/api/memory/l2/${encodeURIComponent(id)}/regenerate`, apiKeyId),
      {}
    );
    if (ok == null) {
      notify.error(tCommon("regenerateFailed"));
      return;
    }
    notify.success(t("l2.regeneratePending"));
    scenes.reload();
  };

  return (
    <div className="space-y-6">
      <AppleSurface className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-text-main">{t("l2.title")}</h2>
            <p className="text-xs text-text-muted mt-1 max-w-xl">{t("l2.description")}</p>
          </div>
          <AppleField id="l2-search" label=" " className="flex-1 min-w-[200px]">
            <AppleInput
              id="l2-search"
              role="searchbox"
              data-testid="l2-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("l2.searchPlaceholder")}
            />
          </AppleField>
        </div>
      </AppleSurface>

      <AppleCard data-testid="l2-scenes" className="space-y-3">
        {scenes.isLoading ? (
          <p className="text-sm text-text-muted" role="status" aria-live="polite">
            {tCommon("loading")}
          </p>
        ) : scenes.error ? (
          <p className="text-sm text-red-500" role="alert">
            {t("l2.loadFailed")}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-text-muted" data-testid="l2-empty">
            {t("l2.noScenes")}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {items.map((s) => (
              <li
                key={s.id}
                className="py-3"
                data-testid={`l2-scene-${s.id}`}
                data-status={s.deletedAt ? "deleted" : "active"}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="font-mono text-text-muted">{truncId(s.id)}</span>
                      <span className="text-text-muted">
                        {t("l2.heat")}: {s.heat.toFixed(2)}
                      </span>
                      <span className="text-text-muted">
                        {s.sceneName}
                        {s.groupKey ? ` / ${s.groupKey}` : ""}
                      </span>
                      <span className="text-text-muted">
                        {tCommon("version")}: {s.version}
                      </span>
                      <span className="text-text-muted">
                        {t("l2.modifier")}: {s.lastModifiedBy}
                      </span>
                    </div>
                    {s.summary && <p className="text-sm font-medium text-text-main">{s.summary}</p>}
                    <p className="text-xs text-text-muted whitespace-pre-wrap break-words">
                      {s.content}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 shrink-0">
                    <AppleButton
                      size="sm"
                      variant="secondary"
                      onClick={() => openEdit(s)}
                      data-testid={`l2-edit-${s.id}`}
                    >
                      {tCommon("edit")}
                    </AppleButton>
                    <AppleButton
                      size="sm"
                      variant="tertiary"
                      onClick={() => handleRegenerate(s.id)}
                      data-testid={`l2-regenerate-${s.id}`}
                    >
                      {tCommon("regenerate")}
                    </AppleButton>
                    <AppleButton
                      size="sm"
                      variant="tertiary"
                      onClick={() => setDeleteId(s.id)}
                      data-testid={`l2-delete-${s.id}`}
                    >
                      {tCommon("delete")}
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
        title={t("l2.edit")}
        footer={
          <>
            <AppleButton variant="tertiary" onClick={() => setEditState(null)} disabled={busy}>
              {tCommon("cancel")}
            </AppleButton>
            <AppleButton
              variant="primary"
              loading={busy}
              disabled={!editState?.summary.trim()}
              onClick={handleSave}
              data-testid="l2-save"
            >
              {tCommon("save")}
            </AppleButton>
          </>
        }
      >
        {editState && (
          <div className="space-y-3">
            <AppleField id="l2-edit-summary" label={t("l2.summary")}>
              <AppleInput
                id="l2-edit-summary"
                value={editState.summary}
                onChange={(e) => setEditState({ ...editState, summary: e.target.value })}
              />
            </AppleField>
            <AppleField id="l2-edit-content" label={t("l2.content")}>
              <textarea
                id="l2-edit-content"
                rows={4}
                value={editState.content}
                onChange={(e) => setEditState({ ...editState, content: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                data-testid="l2-edit-content"
              />
            </AppleField>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={Boolean(deleteId)}
        onClose={() => setDeleteId(null)}
        title={tCommon("confirmDeleteTitle")}
        footer={
          <>
            <AppleButton variant="tertiary" onClick={() => setDeleteId(null)} disabled={busy}>
              {tCommon("cancel")}
            </AppleButton>
            <AppleButton
              variant="primary"
              loading={busy}
              onClick={() => deleteId && handleDelete(deleteId)}
              data-testid="l2-confirm-delete"
            >
              {tCommon("delete")}
            </AppleButton>
          </>
        }
      >
        <p className="text-sm text-text-muted">{tCommon("confirmDeleteDesc")}</p>
      </Modal>
    </div>
  );
}
