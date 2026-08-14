"use client";

/**
 * L1Tab — memory entries (L1 layer).
 *
 * Shows distilled memories with id, priority, content, version, last-modifier,
 * and edit marker. 7 localized type chips. Soft delete / permanent delete /
 * restore actions, view in scene links, and a read-only score preview if the
 * retrieval pipeline returned one.
 *
 * Optional `lineageFilter` (URL query `lineage`) scopes the table to a
 * specific id list when arriving from L0's "Associated L1" link.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  AppleButton,
  AppleCard,
  AppleField,
  AppleInput,
  AppleSelect,
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
  useL1Memories,
  type L1Memory,
  type L1Type,
} from "../../hooks/useMemoryLayersApi";

interface Props {
  lineageFilter?: string[] | null;
  onClearLineage?: () => void;
  apiKeyId?: string | null;
}

const TYPE_CHIPS: L1Type[] = [
  "persona",
  "episodic",
  "instruction",
  "work_fact",
  "work_task",
  "work_method",
  "work_artifact",
];

const TYPE_TONE: Record<L1Type, string> = {
  persona: "bg-rose-500/15 text-rose-500",
  episodic: "bg-emerald-500/15 text-emerald-500",
  instruction: "bg-orange-500/15 text-orange-500",
  work_fact: "bg-blue-500/15 text-blue-500",
  work_task: "bg-cyan-500/15 text-cyan-500",
  work_method: "bg-amber-500/15 text-amber-500",
  work_artifact: "bg-violet-500/15 text-violet-500",
};

interface EditState {
  id: string;
  priority: number;
  content: string;
  expectedVersion: number;
}

export default function L1Tab({ lineageFilter, onClearLineage, apiKeyId }: Props) {
  const t = useTranslations("memory");
  const tCommon = useTranslations("memory.common");
  const notify = useNotificationStore();
  const [typeFilter, setTypeFilter] = useState<L1Type | "all">("all");
  const [minPriority, setMinPriority] = useState<number>(0);
  const [search, setSearch] = useState<string>("");
  const [editState, setEditState] = useState<EditState | null>(null);
  const [permDeleteId, setPermDeleteId] = useState<string | null>(null);
  const [softDeleteId, setSoftDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const memories = useL1Memories(
    {
      type: typeFilter,
      minPriority,
      query: search,
    },
    { apiKeyId }
  );

  const items = useMemo(() => {
    const base = memories.data ?? [];
    if (lineageFilter && lineageFilter.length > 0) {
      const set = new Set(lineageFilter);
      return base.filter((m) => set.has(m.id));
    }
    return base;
  }, [memories.data, lineageFilter]);

  useEffect(() => {
    if (lineageFilter && lineageFilter.length > 0) {
      notify.info(t("l1.title"), `lineage: ${lineageFilter.length}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineageFilter?.join(",")]);

  const openEdit = (memory: L1Memory) =>
    setEditState({
      id: memory.id,
      priority: memory.priority,
      content: memory.content,
      expectedVersion: memory.version,
    });

  const handleSave = async () => {
    if (!editState || !editState.id) return;
    setBusy(true);
    const ok = await putJson(
      appendOwnerQuery(`/api/memory/l1/${encodeURIComponent(editState.id)}`, apiKeyId),
      {
        priority: editState.priority,
        content: editState.content,
        expectedVersion: editState.expectedVersion,
      }
    );
    setBusy(false);
    if (ok == null) {
      notify.error(t("l1.loadFailed"));
      return;
    }
    notify.success(t("l1.editSucceeded"));
    setEditState(null);
    memories.reload();
  };

  const handleSoftDelete = async (id: string) => {
    setBusy(true);
    const ok = await deleteJson(
      appendOwnerQuery(`/api/memory/l1/${encodeURIComponent(id)}`, apiKeyId),
      { mode: "soft" }
    );
    setBusy(false);
    if (ok == null) {
      notify.error(tCommon("deleteFailed"));
      return;
    }
    notify.success(t("l1.deleteSucceeded"));
    setSoftDeleteId(null);
    memories.reload();
  };

  const handlePermDelete = async (id: string) => {
    setBusy(true);
    const ok = await deleteJson(
      appendOwnerQuery(`/api/memory/l1/${encodeURIComponent(id)}`, apiKeyId),
      { mode: "permanent" }
    );
    setBusy(false);
    if (ok == null) {
      notify.error(tCommon("deleteFailed"));
      return;
    }
    notify.success(t("l1.deleteSucceeded"));
    setPermDeleteId(null);
    memories.reload();
  };

  const handleRestore = async (id: string) => {
    const ok = await postJson(
      appendOwnerQuery(`/api/memory/l1/${encodeURIComponent(id)}?op=restore`, apiKeyId),
      {}
    );
    if (ok == null) {
      notify.error(tCommon("restoreFailed"));
      return;
    }
    notify.success(t("l1.restoreSucceeded"));
    memories.reload();
  };

  return (
    <div className="space-y-6">
      <AppleSurface className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-text-main">{t("l1.title")}</h2>
            <p className="text-xs text-text-muted mt-1 max-w-xl">{t("l1.description")}</p>
          </div>
        </div>
        {lineageFilter && lineageFilter.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <span className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-full bg-primary/15 text-primary">
              {tCommon("lineage")}: {lineageFilter.length}
            </span>
            {onClearLineage && (
              <AppleButton
                size="sm"
                variant="tertiary"
                onClick={onClearLineage}
                data-testid="l1-clear-lineage"
              >
                {t("clearFilters")}
              </AppleButton>
            )}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <AppleField id="l1-type-filter" label={t("l1.filterType")} className="w-44">
            <AppleSelect
              id="l1-type-filter"
              data-testid="l1-type-filter"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
            >
              <option value="all">{t("l1.allTypes")}</option>
              {TYPE_CHIPS.map((tp) => (
                <option key={tp} value={tp}>
                  {tp}
                </option>
              ))}
            </AppleSelect>
          </AppleField>
          <AppleField id="l1-priority-filter" label={t("l1.filterPriority")} className="w-32">
            <AppleInput
              id="l1-priority-filter"
              type="number"
              min={0}
              max={100}
              value={String(minPriority)}
              onChange={(e) => setMinPriority(Math.max(0, Number(e.target.value) || 0))}
            />
          </AppleField>
          <AppleField id="l1-search" label=" " className="flex-1 min-w-[180px]">
            <AppleInput
              id="l1-search"
              role="searchbox"
              data-testid="l1-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("l1.searchPlaceholder")}
            />
          </AppleField>
        </div>
      </AppleSurface>

      <AppleCard data-testid="l1-memories" className="space-y-3">
        {memories.isLoading ? (
          <p className="text-sm text-text-muted" role="status" aria-live="polite">
            {tCommon("loading")}
          </p>
        ) : memories.error ? (
          <p className="text-sm text-red-500" role="alert">
            {t("l1.loadFailed")}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-text-muted" data-testid="l1-empty">
            {t("l1.noMemories")}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {items.map((m) => (
              <li
                key={m.id}
                className="py-3"
                data-testid={`l1-memory-${m.id}`}
                data-edited={m.editedByUser ? "true" : "false"}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="font-mono text-text-muted">{truncId(m.id)}</span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full font-medium ${TYPE_TONE[m.type]}`}
                      >
                        {m.type}
                      </span>
                      <span className="text-text-muted">
                        {t("l1.priority")}: {m.priority}
                      </span>
                      <span className="text-text-muted">
                        {tCommon("version")}: {m.version}
                      </span>
                      <span className="text-text-muted">
                        {tCommon("lastModifiedBy")}: {m.lastModifiedBy}
                      </span>
                      {m.editedByUser && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-500 font-medium">
                          {t("l1.editedMarker")}
                        </span>
                      )}
                      <span className="text-text-muted">{m.sceneName}</span>
                    </div>
                    <p className="text-sm text-text-main whitespace-pre-wrap break-words">
                      {m.content}
                    </p>
                    {m.sourceMessageIds.length > 0 && (
                      <a
                        className="text-[11px] text-primary hover:underline"
                        href={`?tab=l0&lineage=${encodeURIComponent(m.sourceMessageIds[0]!)}`}
                        data-testid={`l1-view-scene-${m.id}`}
                      >
                        {t("l1.viewSource")}: {truncId(m.sourceMessageIds[0]!)}
                      </a>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1 shrink-0">
                    {m.deletedAt ? (
                      <AppleButton
                        size="sm"
                        variant="tertiary"
                        onClick={() => handleRestore(m.id)}
                        data-testid={`l1-restore-${m.id}`}
                      >
                        {tCommon("restore")}
                      </AppleButton>
                    ) : (
                      <>
                        <AppleButton
                          size="sm"
                          variant="secondary"
                          onClick={() => openEdit(m)}
                          data-testid={`l1-edit-${m.id}`}
                        >
                          {tCommon("edit")}
                        </AppleButton>
                        <AppleButton
                          size="sm"
                          variant="tertiary"
                          onClick={() => setSoftDeleteId(m.id)}
                          data-testid={`l1-soft-delete-${m.id}`}
                        >
                          {tCommon("softDelete")}
                        </AppleButton>
                      </>
                    )}
                    <AppleButton
                      size="sm"
                      variant="tertiary"
                      onClick={() => setPermDeleteId(m.id)}
                      data-testid={`l1-perm-delete-${m.id}`}
                    >
                      {tCommon("permanentDelete")}
                    </AppleButton>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AppleCard>

      {/* Edit / Add modal */}
      <Modal
        isOpen={Boolean(editState)}
        onClose={() => setEditState(null)}
        title={editState?.id ? t("l1.editMemory") : t("l1.addMemory")}
        footer={
          <>
            <AppleButton variant="tertiary" onClick={() => setEditState(null)} disabled={busy}>
              {tCommon("cancel")}
            </AppleButton>
            <AppleButton
              variant="primary"
              loading={busy}
              disabled={!editState?.content.trim()}
              onClick={handleSave}
              data-testid="l1-save"
            >
              {tCommon("save")}
            </AppleButton>
          </>
        }
      >
        {editState && (
          <div className="space-y-3">
            <AppleField id="l1-edit-priority" label={t("l1.priority")}>
              <AppleInput
                id="l1-edit-priority"
                type="number"
                min={0}
                max={100}
                value={String(editState.priority)}
                onChange={(e) =>
                  setEditState({ ...editState, priority: Number(e.target.value) || 0 })
                }
              />
            </AppleField>
            <AppleField id="l1-edit-content" label={tCommon("source")}>
              <textarea
                id="l1-edit-content"
                rows={4}
                value={editState.content}
                onChange={(e) => setEditState({ ...editState, content: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                data-testid="l1-edit-content"
              />
            </AppleField>
          </div>
        )}
      </Modal>

      {/* Soft delete confirm */}
      <Modal
        isOpen={Boolean(softDeleteId)}
        onClose={() => setSoftDeleteId(null)}
        title={tCommon("softDelete")}
        footer={
          <>
            <AppleButton variant="tertiary" onClick={() => setSoftDeleteId(null)} disabled={busy}>
              {tCommon("cancel")}
            </AppleButton>
            <AppleButton
              variant="primary"
              loading={busy}
              onClick={() => softDeleteId && handleSoftDelete(softDeleteId)}
              data-testid="l1-confirm-soft-delete"
            >
              {tCommon("softDelete")}
            </AppleButton>
          </>
        }
      >
        <p className="text-sm text-text-muted">{tCommon("confirmDeleteDesc")}</p>
      </Modal>

      {/* Permanent delete confirm */}
      <Modal
        isOpen={Boolean(permDeleteId)}
        onClose={() => setPermDeleteId(null)}
        title={tCommon("confirmPermanentDeleteTitle")}
        footer={
          <>
            <AppleButton variant="tertiary" onClick={() => setPermDeleteId(null)} disabled={busy}>
              {tCommon("cancel")}
            </AppleButton>
            <AppleButton
              variant="primary"
              loading={busy}
              onClick={() => permDeleteId && handlePermDelete(permDeleteId)}
              data-testid="l1-confirm-perm-delete"
            >
              {tCommon("permanentDelete")}
            </AppleButton>
          </>
        }
      >
        <p className="text-sm text-text-muted">{tCommon("confirmPermanentDeleteDesc")}</p>
      </Modal>
    </div>
  );
}
