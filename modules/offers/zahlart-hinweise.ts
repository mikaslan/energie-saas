// F2-05b §4: reiner ID→Label-Projektor für den internen Zahlart-Hinweis (D5-05).
// Server-frei (kein DB-, kein Permission-Zugriff): null/unbekannt → Null-Text,
// niemals Exception an die UI.
export type VariantPaymentHintOption = {
  id: string;
  label: string;
  archivedAt: string | null;
};

export type VariantPaymentHintLocale = "de" | "en";

export function formatVariantPaymentHint(
  paymentOptionId: string | null,
  options: readonly VariantPaymentHintOption[],
  locale: VariantPaymentHintLocale,
): string {
  try {
    const isEnglish = locale === "en";
    const noneText = isEnglish
      ? "Variant payment option: none selected (display only)."
      : "Zahlart der Variante: keine Angabe (reine Anzeige).";
    if (typeof paymentOptionId !== "string" || paymentOptionId === "") return noneText;
    if (!Array.isArray(options)) return noneText;
    const bound = options.find((option) => option?.id === paymentOptionId);
    if (!bound || typeof bound.label !== "string" || bound.label === "") return noneText;
    // Archiviert gebunden (§4): Label + Suffix, Historie bleibt lesbar.
    const archivedSuffix = bound.archivedAt === null || bound.archivedAt === undefined
      ? ""
      : isEnglish ? " (archived)" : " (archiviert)";
    return isEnglish
      ? `Variant payment option: ${bound.label}${archivedSuffix} (display only).`
      : `Zahlart der Variante: ${bound.label}${archivedSuffix} (reine Anzeige).`;
  } catch {
    return locale === "en"
      ? "Variant payment option: none selected (display only)."
      : "Zahlart der Variante: keine Angabe (reine Anzeige).";
  }
}
