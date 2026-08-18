"use client";

import { useTranslations } from "next-intl";
import ConceptCard from "@/shared/components/ConceptCard";

const LS_KEY = "omniroute:concept-batch-collapsed";

interface Props {
  className?: string;
}

export default function BatchConceptCard({ className = "" }: Props) {
  const t = useTranslations("common");

  return (
    <ConceptCard
      icon="info"
      iconClassName="bg-transparent p-0 text-accent"
      title={t("batchConceptTitle")}
      description={t("batchConceptSubtitle")}
      toggleLabel={t("batchConceptHowItWorks")}
      collapse="body"
      defaultOpen
      persistKey={LS_KEY}
      className={className}
      details={
        <ul className="flex flex-col gap-2 pl-1">
          <li className="flex items-start gap-2 text-sm text-text-muted">
            <span className="material-symbols-outlined text-[16px] text-emerald-400 mt-0.5 shrink-0">
              savings
            </span>
            <span>{t("batchConceptBenefit50pct")}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-text-muted">
            <span className="material-symbols-outlined text-[16px] text-blue-400 mt-0.5 shrink-0">
              schedule
            </span>
            <span>{t("batchConceptAsync24h")}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-text-muted">
            <span className="material-symbols-outlined text-[16px] text-violet-400 mt-0.5 shrink-0">
              task_alt
            </span>
            <span>{t("batchConceptUseCases")}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-text-muted">
            <span className="material-symbols-outlined text-[16px] text-yellow-400 mt-0.5 shrink-0">
              timer
            </span>
            <span>{t("batchConceptRetentionNote")}</span>
          </li>
        </ul>
      }
    />
  );
}
