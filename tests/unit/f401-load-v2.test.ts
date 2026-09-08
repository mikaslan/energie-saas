import { describe, expect, it } from "vitest";

import {
  F401LoadError,
  hashLoadSourceSlots,
  LOAD_PROFILE_V2_SCHEMA_VERSION,
  resolveTotalLoadProfile,
} from "@/lib/integrations/calculation/load-v2";
import { QUARTER_HOUR_SLOTS } from "@/lib/integrations/calculation/engine-v2";
import { runPlanningCalculationV2 } from "@/lib/integrations/calculation/run-v2";
import { validatePlanningCalculationResultV2Exactly } from "@/lib/integrations/calculation/validate-result-v2";

// F4.1 v2-Lastprofil: getrennt proveniente Reihen -> gebundene Gesamtlast.
// Keine Shape-Erfindung: Formen kommen aus den Profilquellen.

function source(kind: string, value: number, id = kind): Record<string, unknown> {
  return {
    sourceKind: kind,
    sourceId: id,
    sourceRevision: "rev-1",
    sourceSha256: "a".repeat(64),
    slotEnergyKwh: new Array<number>(QUARTER_HOUR_SLOTS).fill(value),
  };
}

describe("F4.1 v2 load profile", () => {
  it("summiert Basis+EV zur Gesamtlast mit Neumaier-Jahressumme", () => {
    const profile = resolveTotalLoadProfile([source("basis", 0.1), source("ev", 0.05)]);
    expect(profile.schemaVersion).toBe(LOAD_PROFILE_V2_SCHEMA_VERSION);
    expect(profile.axisVersion).toBe(
      "utc_to_berlin_standard_time_circular_then_drop_feb29.v2",
    );
    expect(profile.slotEnergyKwh).toHaveLength(35_040);
    expect(profile.slotEnergyKwh[0]).toBeCloseTo(0.15, 12);
    expect(profile.annualConsumptionKwh).toBeCloseTo(0.15 * 35_040, 6);
    expect(profile.sources.map((entry) => entry.sourceKind)).toEqual(["basis", "ev"]);
  });

  it("verlangt genau eine Basis-Reihe und weist Duplikate ab", () => {
    expect(() => resolveTotalLoadProfile([source("ev", 0.05)])).toThrow(F401LoadError);
    expect(() => resolveTotalLoadProfile([source("basis", 0.1), source("basis", 0.2, "b2")])).toThrow(
      F401LoadError,
    );
    expect(() => resolveTotalLoadProfile([
      source("basis", 0.1),
      source("basis", 0.1),
    ])).toThrow(F401LoadError);
    expect(() => resolveTotalLoadProfile([source("basis", 0.1, "x", )].map((entry) => ({
      ...entry,
      slotEnergyKwh: (entry.slotEnergyKwh as number[]).slice(0, 35_039),
    })))).toThrow(F401LoadError);
    const negative = source("basis", 0.1);
    (negative.slotEnergyKwh as number[])[9] = -1;
    expect(() => resolveTotalLoadProfile([negative])).toThrow(F401LoadError);
  });

  it("schliesst die Kette Profil -> Run -> Finalize exakt", () => {
    const profile = resolveTotalLoadProfile([source("basis", 0.1), source("ev", 0.05)]);
    const input = {
      request: {
        contractVersion: "planning-calculation.v2",
        canonicalizationVersion: "planning-jcs.v1",
        branch: "new_installation",
        asOfDate: "2026-08-29",
        commissioningDate: "2026-08-29",
        bindings: {
          workspaceId: "11111111-1111-4111-8111-111111111111",
          projectId: "22222222-2222-4222-8222-222222222222",
          siteId: "33333333-3333-4333-8333-333333333333",
          addressRevision: 1,
          pinConfirmedAddressRevision: 1,
          energyProfileId: "44444444-4444-4444-8444-444444444444",
          energyProfileRevision: 1,
          confirmedEnergyProfileRevision: 1,
          confirmedEnergyProfileAddressRevision: 1,
          projectRequirementId: "55555555-5555-4555-8555-555555555555",
          projectRequirementRevision: 1,
          sourceCalculatorSnapshotId: null,
        },
        site: { countryCode: "DE", latitude: 52.52, longitude: 13.41 },
        axis: { slots: 35_040, resolution: "quarter_hour" },
        storage: {
          capacityKwh: 0,
          socMinKwh: 0,
          socMaxKwh: 0,
          chargeKw: 0,
          dischargeKw: 0,
          etaCharge: 1,
          etaDischarge: 1,
        },
      },
      pvKwh: new Array<number>(QUARTER_HOUR_SLOTS).fill(0.2),
      loadKwh: profile.slotEnergyKwh,
      providerEstimate: true,
    };
    const result = runPlanningCalculationV2(input);
    expect(result.annual.consumptionKwh).toBeCloseTo(profile.annualConsumptionKwh, 6);
    expect(validatePlanningCalculationResultV2Exactly({ ...input, result }).ok).toBe(true);
  });

  it("hasht Quellreihen stabil ueber 35040 Slots", () => {
    const hash = hashLoadSourceSlots(new Array<number>(QUARTER_HOUR_SLOTS).fill(0.25));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLoadSourceSlots(new Array<number>(QUARTER_HOUR_SLOTS).fill(0.25))).toBe(hash);
    expect(() => hashLoadSourceSlots([0.25])).toThrow(F401LoadError);
  });
});
