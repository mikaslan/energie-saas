import { describe, expect, it } from "vitest";

import { resolveEconomics } from "@/lib/integrations/calculation/economics-v2";
import * as economicsV2 from "@/lib/integrations/calculation/economics-v2";

// F4-02g Brasilien Net Metering (RED, Ref
// docs/spec/F4-02g-brasilien-net-metering.md): NUR existierende Imports —
// kein Import aus noch nicht geschriebenem Code. ROT-Beleg per
// `npx tsx scripts/run-tests.mts tests/unit/f402g-net-metering.red.test.ts`
// (5 rote Tests, Auszug in der Spec); danach describe.skip bis zur Umsetzung.

function consumption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    electricityPriceCentsPerKwh: { status: "known", value: 36, source: "customer" },
    annualPriceIncreasePercent: { status: "unknown", value: null, source: "not_collected" },
    investmentEuro: { status: "known", value: 20_000, source: "operator_reviewed" },
    feedInTariffCtPerKwh: { status: "unknown", value: null, source: "not_collected" },
    feedInCommissioningYear: { status: "unknown", value: null, source: "not_collected" },
    ...overrides,
  };
}

const known = (value: unknown) => ({ status: "known", value, source: "operator_reviewed" });

const BRASIL_RULE = {
  contractVersion: "brasil-net-metering.v1",
  compensationFactor: 1.0,
  creditExpiryMonths: 60,
};

// SKIP-Grund: RED-Test zur Spec F4-02g (docs/spec/F4-02g-brasilien-net-metering.md,
// Abschnitt 4). Die BR-Gutschriftregel ist SPECIFIED, nicht gebaut:
// resolveEconomics kennt heute kein BR-Kennzeichen (ROT-Beleg: 5 failed (5)
// am 2026-09-20). Entskippen, sobald der Bau-Slice die BR-Regel implementiert.
describe.skip("f402g brasil net metering", () => {
  it("BR-Regelsatz erzeugt Gutschrift-Block statt Einspeiseverguetung", () => {
    const resolved = resolveEconomics(consumption({
      brasilNetMetering: known(BRASIL_RULE),
    }))!;
    expect(resolved).toHaveProperty("brasilNetMetering");
    expect(resolved).not.toHaveProperty("feedInTariffSource");
  });

  it("Gutschrift-Verfall 60 Monate ist exportiert (Lei 14.300)", () => {
    expect(economicsV2).toHaveProperty("BRASIL_CREDIT_EXPIRY_MONTHS", 60);
  });

  it("Gutschrift-Uebertrag in den Folgemonat ist exportiert", () => {
    expect("applyBrasilCreditCarryover" in economicsV2).toBe(true);
  });

  it("DE-EEG-Kaskade und BR-Gutschrift schliessen sich aus (fail-closed)", () => {
    expect(() => resolveEconomics(consumption({
      feedInTariffCtPerKwh: known(8.2),
      brasilNetMetering: known(BRASIL_RULE),
    }))).toThrow();
  });

  it("BR-Kennzeichen ohne Regelsatz liefert kein Geld (fail-closed)", () => {
    const resolved = resolveEconomics(consumption({
      brasilNetMetering: known({}),
    }));
    expect(resolved).toBeNull();
  });
});
