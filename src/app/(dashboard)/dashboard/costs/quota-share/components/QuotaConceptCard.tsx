"use client";

import { useTranslations } from "next-intl";
import ConceptCard from "@/shared/components/ConceptCard";

export default function QuotaConceptCard() {
  const t = useTranslations("quotaShare");

  return (
    <ConceptCard
      icon="info"
      iconClassName="bg-transparent p-0 text-primary"
      title={t("conceptTitle")}
      toggleLabel={t("conceptIntro")}
      collapse="body"
      defaultOpen={false}
      details={
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            <ConceptItem icon="balance" text={t("conceptFairShare")} />
            <ConceptItem icon="trending_up" text={t("conceptBorrowing")} />
            <ConceptItem icon="lock" text={t("conceptGlobalCap")} />
            <ConceptItem icon="schedule" text={t("conceptWindows")} />
            <ConceptItemWithDesc
              icon="vpn_key"
              title={t("conceptKeyHowTitle")}
              desc={t("conceptKeyHowDesc")}
            />
            <ConceptItemWithDesc
              icon="block"
              title={t("conceptExclusiveTitle")}
              desc={t("conceptExclusiveDesc")}
            />
          </div>
        </div>
      }
    />
  );
}

function ConceptItem({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md bg-bg-subtle/40 p-2">
      <span className="material-symbols-outlined text-[16px] text-primary shrink-0 mt-0.5">
        {icon}
      </span>
      <span>{text}</span>
    </div>
  );
}

function ConceptItemWithDesc({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md bg-bg-subtle/40 p-2">
      <span className="material-symbols-outlined text-[16px] text-primary shrink-0 mt-0.5">
        {icon}
      </span>
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold text-text-main">{title}</span>
        <span className="text-text-muted">{desc}</span>
      </div>
    </div>
  );
}
