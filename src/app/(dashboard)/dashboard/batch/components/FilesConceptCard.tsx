"use client";

import { useTranslations } from "next-intl";
import ConceptCard from "@/shared/components/ConceptCard";

const LS_KEY = "omniroute:concept-files-collapsed";

interface Props {
  className?: string;
}

const TYPE_PILLS: Array<{
  key: "filesConceptInput" | "filesConceptOutput" | "filesConceptError";
  color: string;
}> = [
  { key: "filesConceptInput", color: "bg-blue-500/15 text-blue-400 border-blue-500/25" },
  { key: "filesConceptOutput", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25" },
  { key: "filesConceptError", color: "bg-red-500/15 text-red-400 border-red-500/25" },
];

export default function FilesConceptCard({ className = "" }: Props) {
  const t = useTranslations("common");

  return (
    <ConceptCard
      icon="info"
      iconClassName="bg-transparent p-0 text-accent"
      title={t("filesConceptTitle")}
      description={t("filesConceptSubtitle")}
      toggleLabel={t("batchConceptHowItWorks")}
      collapse="body"
      defaultOpen
      persistKey={LS_KEY}
      className={className}
      body={
        <div className="flex flex-wrap gap-2">
          {TYPE_PILLS.map(({ key, color }) => (
            <span
              key={key}
              className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium border ${color}`}
            >
              {t(key)}
            </span>
          ))}
        </div>
      }
      details={
        <ul className="flex flex-col gap-2 pl-1">
          <li className="flex items-start gap-2 text-sm text-text-muted">
            <span
              className="material-symbols-outlined text-[16px] text-blue-400 mt-0.5 shrink-0"
              aria-hidden="true"
            >
              upload_file
            </span>
            <span>{t("filesConceptInput")}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-text-muted">
            <span
              className="material-symbols-outlined text-[16px] text-emerald-400 mt-0.5 shrink-0"
              aria-hidden="true"
            >
              download
            </span>
            <span>{t("filesConceptOutput")}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-text-muted">
            <span
              className="material-symbols-outlined text-[16px] text-red-400 mt-0.5 shrink-0"
              aria-hidden="true"
            >
              error_outline
            </span>
            <span>{t("filesConceptError")}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-text-muted">
            <span
              className="material-symbols-outlined text-[16px] text-yellow-400 mt-0.5 shrink-0"
              aria-hidden="true"
            >
              event_available
            </span>
            <span>{t("filesConceptRetention")}</span>
          </li>
        </ul>
      }
    />
  );
}
