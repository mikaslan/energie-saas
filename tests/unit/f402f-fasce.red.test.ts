import { describe, expect, it } from "vitest";

import { resolveTouImportPrices } from "@/lib/integrations/calculation/economics-v2";

// F4-02f Italien Fasce F1/F2/F3 (Spec docs/spec/F4-02f-italien-fasce.md,
// TOU-Subslice aus F4-02d §2, Zielvektor F4-04b `touImportPricesCtPerKwh`).
// RED-Test: NUR existierende Imports — `resolveTouImportPrices`
// (economics-v2.ts:339) kennt heute keinen `italyTouBands`-Pfad und
// liefert null, sobald kein direkter 24h-Vektor belegt ist. Der Bau-Slice
// bildet die ARERA-Bänder je Tagart auf den 24h-Vektor ab.
// ROT-Beleg per `npx tsx scripts/run-tests.mts
// tests/unit/f402f-fasce.red.test.ts` (Auszug in der Spec); danach
// describe.skip bis zur Umsetzung.

const touUnknown = {
  status: "unknown",
  value: null,
  source: "not_collected",
};

const bandsKnown = (value: unknown) => ({
  status: "known",
  value,
  source: "operator_reviewed",
});

function italyConsumption(dayKind: unknown, bands: unknown) {
  return {
    touImportPricesCtPerKwh: touUnknown,
    italyTouBands: bandsKnown({
      bandPricesCtPerKwh: bands,
      dayKind,
    }),
  };
}

const BANDS = { F1: 40, F2: 30, F3: 20 };

// SKIP-Grund: RED-Test zur Spec F4-02f (docs/spec/F4-02f-italien-fasce.md,
// Abschnitt 7). Die ARERA-Bandabbildung ist SPECIFIED, nicht gebaut:
// resolveTouImportPrices kennt keinen italyTouBands-Pfad (ROT-Beleg:
// 4 failed | 1 passed am 2026-09-20). Entskippen, sobald der Bau-Slice
// die Abbildung implementiert.
describe.skip("F4-02f Italien Fasce (Band-Zeiten)", () => {
  it("bildet F1 auf Werktag 8-19 Uhr ab", () => {
    const vector = resolveTouImportPrices(italyConsumption("weekday", BANDS));
    expect(vector).toHaveLength(24);
    for (let hour = 0; hour < 24; hour += 1) {
      const expected =
        hour === 7 || (hour >= 19 && hour <= 22)
          ? 30
          : hour >= 8 && hour <= 18
            ? 40
            : 20;
      expect(vector?.[hour]).toBe(expected);
    }
  });

  it("bildet Samstag 7-23 Uhr auf F2 ab", () => {
    const vector = resolveTouImportPrices(italyConsumption("saturday", BANDS));
    expect(vector).toHaveLength(24);
    for (let hour = 0; hour < 24; hour += 1) {
      expect(vector?.[hour]).toBe(hour >= 7 && hour <= 22 ? 30 : 20);
    }
  });

  it("bildet Sonntag und Feiertag vollstaendig auf F3 ab", () => {
    const vector = resolveTouImportPrices(
      italyConsumption("sunday_holiday", BANDS),
    );
    expect(vector).toEqual(new Array(24).fill(20));
  });

  it("liefert exakt 24 endliche Preise 0..200 (Vektor-Abbildung)", () => {
    const vector = resolveTouImportPrices(italyConsumption("weekday", BANDS));
    expect(vector).toHaveLength(24);
    for (const price of vector ?? []) {
      expect(Number.isFinite(price)).toBe(true);
      expect(price).toBeGreaterThanOrEqual(0);
      expect(price).toBeLessThanOrEqual(200);
    }
  });
});

describe.skip("F4-02f Italien Fasce (Fail-closed)", () => {
  it("weist unbekanntes Band fail-closed ab (Guard)", () => {
    expect(
      resolveTouImportPrices(
        italyConsumption("weekday", { F1: 40, F2: 30, F4: 20 }),
      ),
    ).toBeNull();
    expect(
      resolveTouImportPrices(italyConsumption("brueckentag", BANDS)),
    ).toBeNull();
  });
});
