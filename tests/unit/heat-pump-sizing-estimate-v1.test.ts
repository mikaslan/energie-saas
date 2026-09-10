import { describe, expect, it } from "vitest";

import {
  estimateHeatingLoadV1,
  F501SizingError,
  FULL_LOAD_HOURS_V1,
  SIZING_ESTIMATE_V1_SOURCE_ID,
  SIZING_ESTIMATE_V1_VERSION,
  SIZING_RESERVE_FACTOR_V1,
  SIZING_ROUND_STEP_KW_V1,
} from "@/lib/integrations/heat-pump/sizing-estimate-v1";

// WP-Schätzung (Spec F5-01): Version/Quelle pinnen, Rechenweg,
// Empfehlungsrundung und Fail-closed-Pfade.

describe("heat pump sizing estimate", () => {
  it("pinnt Version, Quelle und ESTIMATE-Konstanten", () => {
    expect(SIZING_ESTIMATE_V1_VERSION).toBe("wmee-hp-sizing-estimate.v1");
    expect(SIZING_ESTIMATE_V1_SOURCE_ID).toBe("wmee-hp-sizing-estimate.v1");
    expect(FULL_LOAD_HOURS_V1).toEqual({ bestand: 2000, neubau: 1700 });
    expect(SIZING_RESERVE_FACTOR_V1).toBe(1.1);
    expect(SIZING_ROUND_STEP_KW_V1).toBe(0.5);
  });

  it("rechnet Bestand: 20.000 kWh / 2000 h = 10,0 kW, Empfehlung 11,0 kW", () => {
    const result = estimateHeatingLoadV1({ annualThermalKwh: 20000, buildingClass: "bestand" });
    expect(result.method).toBe("ESTIMATE");
    expect(result.fullLoadHoursPerYear).toBe(2000);
    expect(result.heatingLoadKw).toBe(10);
    expect(result.recommendedNominalKw).toBe(11);
    expect(result.disclaimer).toContain("DIN EN 12831");
  });

  it("rechnet Neubau: 20.000 kWh / 1700 h = 11,76 kW", () => {
    const result = estimateHeatingLoadV1({ annualThermalKwh: 20000, buildingClass: "neubau" });
    expect(result.heatingLoadKw).toBeCloseTo(11.76, 2);
    // 11,76 × 1,1 = 12,94 -> auf halbe kW aufgerundet 13,0.
    expect(result.recommendedNominalKw).toBe(13);
  });

  it("rundet die Empfehlung immer auf halbe kW auf", () => {
    // 10,02 kW × 1,1 = 11,022 -> 11,5 (nicht 11,0).
    const result = estimateHeatingLoadV1({ annualThermalKwh: 20040, buildingClass: "bestand" });
    expect(result.heatingLoadKw).toBe(10.02);
    expect(result.recommendedNominalKw).toBe(11.5);
  });

  it.each([0, -500, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001])(
    "fail-closed bei unbelegtem Bedarf (%s): Fehler statt 0-kW-Zahl",
    (annualThermalKwh) => {
      expect(() =>
        estimateHeatingLoadV1({ annualThermalKwh, buildingClass: "bestand" }),
      ).toThrow(F501SizingError);
    },
  );

  it("fail-closed bei unbekannter Gebäudeklasse: kein stiller Default", () => {
    expect(() =>
      estimateHeatingLoadV1({
        annualThermalKwh: 20000,
        // @ts-expect-error Absicht: Laufzeit muss die Klasse ablehnen.
        buildingClass: "altbau",
      }),
    ).toThrow(F501SizingError);
  });
});
