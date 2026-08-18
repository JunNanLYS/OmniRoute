"use client";

import { useTranslations } from "next-intl";
import ConceptCard from "@/shared/components/ConceptCard";

export default function MemoryConceptCard() {
  const t = useTranslations("memory");

  return (
    <ConceptCard
      icon="psychology"
      iconClassName="bg-violet-500/10 text-violet-500"
      title={t("concept.title")}
      description={t("concept.description")}
      toggleLabel={t("concept.howWorksToggle")}
      collapse="details"
      defaultOpen={false}
      details={
        <div className="space-y-1.5">
          {(t("concept.howWorksContent") as string).split("\n").map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      }
    />
  );
}
