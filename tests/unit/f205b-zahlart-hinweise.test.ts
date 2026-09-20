import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// F2-05b §4: ID→Label-Projektor für den internen Zahlart-Hinweis (D5-05).
// RED: Modul existiert noch nicht — Import scheitert bis zur Implementierung.
import { formatVariantPaymentHint } from "@/modules/offers/zahlart-hinweise";

type Option = { id: string; label: string; archivedAt: string | null };

const OPTIONS: Option[] = [
  { id: "opt-kauf", label: "Kauf", archivedAt: null },
  { id: "opt-fin", label: "Finanzierung Classic", archivedAt: "2026-01-02T10:00:00.000Z" },
];

describe("F205B-U-01: ID→Label-Projektor (reine Anzeige, nie Exception)", () => {
  it("gesetzt → Label", () => {
    expect(formatVariantPaymentHint("opt-kauf", OPTIONS, "de")).toBe(
      "Zahlart der Variante: Kauf (reine Anzeige).",
    );
  });

  it("null → Null-Text", () => {
    expect(formatVariantPaymentHint(null, OPTIONS, "de")).toBe(
      "Zahlart der Variante: keine Angabe (reine Anzeige).",
    );
  });

  it("archiviert gebunden → Label + Suffix", () => {
    expect(formatVariantPaymentHint("opt-fin", OPTIONS, "de")).toBe(
      "Zahlart der Variante: Finanzierung Classic (archiviert) (reine Anzeige).",
    );
  });

  it("unbekannte ID → Null-Text statt Exception", () => {
    expect(formatVariantPaymentHint("opt-gibt-es-nicht", OPTIONS, "de")).toBe(
      "Zahlart der Variante: keine Angabe (reine Anzeige).",
    );
  });
});

describe("F205B-U-02: DE/EN-Texte exakt (§4)", () => {
  it("EN gesetzt/null exakt", () => {
    expect(formatVariantPaymentHint("opt-kauf", OPTIONS, "en")).toBe(
      "Variant payment option: Kauf (display only).",
    );
    expect(formatVariantPaymentHint(null, OPTIONS, "en")).toBe(
      "Variant payment option: none selected (display only).",
    );
  });

  it("EN archiviert-Suffix exakt", () => {
    expect(formatVariantPaymentHint("opt-fin", OPTIONS, "en")).toBe(
      "Variant payment option: Finanzierung Classic (archived) (display only).",
    );
  });
});
