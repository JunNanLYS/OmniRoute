"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import ConceptCard from "@/shared/components/ConceptCard";
import TranslateFlowDiagram from "./TranslateFlowDiagram";

export default function TranslatorConceptCard() {
  const t = useTranslations("translator");

  const tr = useCallback(
    (key: string, fallback: string) => {
      try {
        const translated = t(key);
        return translated === key || translated === `translator.${key}` ? fallback : translated;
      } catch {
        return fallback;
      }
    },
    [t]
  );

  return (
    <ConceptCard
      icon="info"
      iconClassName="bg-transparent p-0 text-primary text-[22px]"
      title={tr(
        "conceptHeadline",
        'Your app speaks one API "language". Translator converts it to use another provider.'
      )}
      description={tr(
        "friendlySubtitle",
        "Use your existing app with any provider without rewriting code."
      )}
      body={<TranslateFlowDiagram />}
      toggleLabel={tr("conceptHowItWorksToggle", "How it works")}
      collapse="details"
      defaultOpen={false}
      className="border-primary/10 bg-primary/5"
      details={
        <div
          id="translator-concept-how-it-works"
          className="rounded-none border-0 bg-transparent p-0 border-t border-border pt-3"
        >
          {tr(
            "conceptHowItWorksBody",
            "Your app sends a request in its own format. Translator detects that format, converts through OpenAI as an intermediate hub (or directly when a direct translator is available), sends it to the selected provider, and converts the response back to your app's format."
          )}
        </div>
      }
    />
  );
}
