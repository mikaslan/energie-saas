import { describe, expect, it } from "vitest";

import {
  planningCalculationResultV2Schema,
  type PlanningCalculationRequestV2,
} from "@/lib/integrations/calculation/contract-v2";
import { QUARTER_HOUR_SLOTS } from "@/lib/integrations/calculation/engine-v2";
import { hashPlanningCalculationInputV2 } from "@/lib/integrations/calculation/prepare-v2";
import { runPlanningCalculationV2 } from "@/lib/integrations/calculation/run-v2";
import { validatePlanningCalculationResultV2Exactly } from "@/lib/integrations/calculation/validate-result-v2";

// F4.1 v2-Run/Finalize: Request + 35040-Slot-Serien -> Dispatch mit
// zyklischem SoC, Monats-/Jahresaggregation, validiertes Result.

const NO_STORAGE = {
  capacityKwh: 0,
  socMinKwh: 0,
  socMaxKwh: 0,
  chargeKw: 0,
  dischargeKw: 0,
  etaCharge: 1,
  etaDischarge: 1,
};

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    storage: { ...NO_STORAGE },
    ...overrides,
  };
}

function constant(slots: number, value: number): number[] {
  return new Array<number>(slots).fill(value);
}

describe("F4.1 v2 run", () => {
  it("rechnet ohne Speicher exakt: direkt=min, Rest Export/Import", () => {
    const result = runPlanningCalculationV2({
      request: request(),
      pvKwh: constant(QUARTER_HOUR_SLOTS, 1),
      loadKwh: constant(QUARTER_HOUR_SLOTS, 0.5),
      providerEstimate: true,
    });
    expect(planningCalculationResultV2Schema.safeParse(result).success).toBe(true);
    expect(result.annual.generationKwh).toBe(35_040);
    expect(result.annual.directConsumptionKwh).toBe(17_520);
    expect(result.annual.selfConsumptionKwh).toBe(17_520);
    expect(result.annual.feedInKwh).toBe(17_520);
    expect(result.annual.gridImportKwh).toBe(0);
    expect(result.annual.consumptionKwh).toBe(17_520);
    expect(result.annual.storageLossKwh).toBe(0);
    expect(result.annual.fromStorageKwh).toBe(0);
    expect(result.annual.storageFullCycles).toBe(0);
    expect(result.annual.selfConsumptionRate).toBeCloseTo(0.5, 12);
    expect(result.annual.autonomyRate).toBeCloseTo(1, 12);
    // Januar: 31 Tage * 96 Slots; Monatssummen decken das Jahr exakt ab.
    expect(result.monthly).toHaveLength(12);
    expect(result.monthly[0]).toMatchObject({ month: 1, generationKwh: 2_976 });
    expect(result.monthly[1]).toMatchObject({ month: 2, generationKwh: 2_688 });
    const monthlyGen = result.monthly.reduce((sum, m) => sum + m.generationKwh, 0);
    expect(monthlyGen).toBeCloseTo(result.annual.generationKwh, 6);
    expect(result.warnings).toContainEqual({ code: "provider_estimate", severity: "info" });
  });

  it("rechnet Defizit (D<0) und Ausgleich (D=0) exakt ohne Speicher", () => {
    const deficit = runPlanningCalculationV2({
      request: request(),
      pvKwh: constant(QUARTER_HOUR_SLOTS, 0.2),
      loadKwh: constant(QUARTER_HOUR_SLOTS, 0.5),
      providerEstimate: false,
    });
    expect(deficit.annual.directConsumptionKwh).toBe(7_008);
    expect(deficit.annual.gridImportKwh).toBe(10_512);
    expect(deficit.annual.feedInKwh).toBe(0);
    expect(deficit.annual.autonomyRate).toBeCloseTo(0.4, 12);
    const balanced = runPlanningCalculationV2({
      request: request(),
      pvKwh: constant(QUARTER_HOUR_SLOTS, 0.5),
      loadKwh: constant(QUARTER_HOUR_SLOTS, 0.5),
      providerEstimate: false,
    });
    expect(balanced.annual.feedInKwh).toBe(0);
    expect(balanced.annual.gridImportKwh).toBe(0);
    expect(balanced.annual.selfConsumptionKwh).toBe(17_520);
    expect(balanced.annual.autonomyRate).toBe(1);
  });

  it("bindet inputSha256 stabil an den Request", () => {
    const req = request() as unknown as PlanningCalculationRequestV2;
    const series = {
      request: req,
      pvKwh: constant(QUARTER_HOUR_SLOTS, 0.25),
      loadKwh: constant(QUARTER_HOUR_SLOTS, 0.25),
      providerEstimate: false,
    };
    const first = runPlanningCalculationV2(series);
    const second = runPlanningCalculationV2(structuredClone(series));
    expect(first.inputSha256).toBe(hashPlanningCalculationInputV2(req));
    expect(second).toEqual(first);
    expect(first.warnings).toEqual([]);
  });

  it("rechnet den Bestands-Branch ohne Speicher: baseline == geplant, Delta 0", () => {
    const result = runPlanningCalculationV2({
      request: request({
        branch: "existing_installation",
        existingInstallation: { systemPeakPowerKwp: 8, storageCapacityKwh: 0 },
      }),
      pvKwh: constant(QUARTER_HOUR_SLOTS, 1),
      loadKwh: constant(QUARTER_HOUR_SLOTS, 0.5),
      providerEstimate: false,
      existingPvKwh: constant(QUARTER_HOUR_SLOTS, 0.8),
    });
    expect(planningCalculationResultV2Schema.safeParse(result).success).toBe(true);
    expect(result.existingInstallation).toBeDefined();
    expect(result.existingInstallation?.existingSystemPeakPowerKwp).toBe(8);
    expect(result.existingInstallation?.existingStorageCapacityKwh).toBe(0);
    expect(result.existingInstallation?.addedStorageCapacityKwh).toBe(0);
    // Bestandserzeugung (0.8*35040), nicht die Neuanlagen-Reihe (1.0*35040).
    expect(result.annual.generationKwh).toBe(28_032);
    expect(result.annual).toEqual(result.existingInstallation?.baseline.annual);
    expect(result.existingInstallation?.delta.additionalSelfConsumptionKwh).toBe(0);
    expect(result.existingInstallation?.delta.autonomyRatePercentagePoints).toBe(0);
    expect(result.existingInstallation?.baseline.monthly).toHaveLength(12);
  });

  it("rechnet den Bestands-Branch mit neuem Speicher: geplant >= baseline", () => {
    const storage = {
      capacityKwh: 10,
      socMinKwh: 1,
      socMaxKwh: 9,
      chargeKw: 5,
      dischargeKw: 5,
      etaCharge: 0.95,
      etaDischarge: 0.95,
    };
    // Tag/Nacht-Wechsel, damit der neue Speicher echten Mehr-Eigenverbrauch
    // gegenueber der speicherlosen Baseline erzeugt.
    const existingPv = new Array<number>(QUARTER_HOUR_SLOTS);
    const load = new Array<number>(QUARTER_HOUR_SLOTS);
    for (let i = 0; i < QUARTER_HOUR_SLOTS; i += 1) {
      const daySlot = i % SLOTS_PER_DAY;
      existingPv[i] = daySlot < 48 ? 0 : 2;
      load[i] = daySlot < 48 ? 1 : 0.2;
    }
    const result = runPlanningCalculationV2({
      request: request({
        branch: "existing_installation",
        storage,
        existingInstallation: { systemPeakPowerKwp: 8, storageCapacityKwh: 0 },
      }),
      pvKwh: constant(QUARTER_HOUR_SLOTS, 0),
      loadKwh: load,
      providerEstimate: false,
      existingPvKwh: existingPv,
    });
    const baseline = result.existingInstallation?.baseline.annual;
    expect(baseline).toBeDefined();
    expect(result.annual.selfConsumptionKwh)
      .toBeGreaterThanOrEqual(baseline?.selfConsumptionKwh ?? 0);
    expect(result.existingInstallation?.delta.additionalSelfConsumptionKwh).toBeCloseTo(
      result.annual.selfConsumptionKwh - (baseline?.selfConsumptionKwh ?? 0),
      6,
    );
    expect(result.existingInstallation?.delta.autonomyRatePercentagePoints).toBeCloseTo(
      (result.annual.autonomyRate - (baseline?.autonomyRate ?? 0)) * 100,
      6,
    );
    // Planungszustand traegt Speicher-Nutzung, Baseline bleibt speicherlos.
    expect(result.annual.fromStorageKwh).toBeGreaterThan(0);
    expect(baseline?.fromStorageKwh).toBe(0);
  });

  it("weist unbestimmbaren Bestands-Dispatch fail-closed ab", () => {
    const base = {
      request: request({
        branch: "existing_installation",
        existingInstallation: { systemPeakPowerKwp: 8, storageCapacityKwh: 0 },
      }),
      pvKwh: constant(QUARTER_HOUR_SLOTS, 1),
      loadKwh: constant(QUARTER_HOUR_SLOTS, 0.5),
      providerEstimate: false,
    };
    // Fehlende Bestands-Reihe.
    expect(() => runPlanningCalculationV2({ ...base })).toThrow(/Bestands-Reihe fehlt/);
    // Fehlender Bestands-Kontext.
    expect(() => runPlanningCalculationV2({
      ...base,
      request: request({ branch: "existing_installation" }),
      existingPvKwh: constant(QUARTER_HOUR_SLOTS, 0.8),
    })).toThrow(/Bestands-Kontext fehlt/);
    // Bestandsspeicher ohne belegte Batterie-Parameter (C-Rate unbestimmbar).
    expect(() => runPlanningCalculationV2({
      request: request({
        branch: "existing_installation",
        existingInstallation: { systemPeakPowerKwp: 8, storageCapacityKwh: 5 },
      }),
      pvKwh: constant(QUARTER_HOUR_SLOTS, 1),
      loadKwh: constant(QUARTER_HOUR_SLOTS, 0.5),
      providerEstimate: false,
      existingPvKwh: constant(QUARTER_HOUR_SLOTS, 0.8),
    })).toThrow(/ohne belegte Batterie-Parameter/);
  });

  it("haelt den zyklischen SoC mit Speicher ein", () => {
    const storage = {
      capacityKwh: 10,
      socMinKwh: 1,
      socMaxKwh: 9,
      chargeKw: 5,
      dischargeKw: 5,
      etaCharge: 0.95,
      etaDischarge: 0.95,
    };
    // Tag/Nacht-Wechsel: 48 Slots Last, 48 Slots PV, erzeugt echten
    // Lade-/Entladezyklus mit Verlust.
    const pv = new Array<number>(QUARTER_HOUR_SLOTS);
    const load = new Array<number>(QUARTER_HOUR_SLOTS);
    for (let i = 0; i < QUARTER_HOUR_SLOTS; i += 1) {
      const daySlot = i % SLOTS_PER_DAY;
      pv[i] = daySlot < 48 ? 0 : 2;
      load[i] = daySlot < 48 ? 1 : 0.2;
    }
    const result = runPlanningCalculationV2({
      request: request({ storage }),
      pvKwh: pv,
      loadKwh: load,
      providerEstimate: false,
    });
    expect(result.annual.fromStorageKwh).toBeGreaterThan(0);
    expect(result.annual.storageLossKwh).toBeGreaterThan(0);
    expect(result.annual.storageFullCycles).toBeGreaterThan(0);
    // Energieerhaltung: Erzeugung = Eigenverbrauch + Einspeisung + Verlust.
    expect(
      result.annual.generationKwh
        - result.annual.selfConsumptionKwh
        - result.annual.feedInKwh
        - result.annual.storageLossKwh,
    ).toBeCloseTo(0, 2);
    expect(result.warnings).toEqual([]);
  });

  it("weist falsche Laengen, negative und nicht-finite Serien fail-closed ab", () => {
    const base = {
      request: request(),
      loadKwh: constant(QUARTER_HOUR_SLOTS, 0.5),
      providerEstimate: false,
    };
    expect(() => runPlanningCalculationV2({
      ...base,
      pvKwh: constant(QUARTER_HOUR_SLOTS - 1, 1),
    })).toThrow();
    const negative = constant(QUARTER_HOUR_SLOTS, 1);
    negative[100] = -0.5;
    expect(() => runPlanningCalculationV2({ ...base, pvKwh: negative })).toThrow();
    const nan = constant(QUARTER_HOUR_SLOTS, 1);
    nan[200] = Number.NaN;
    expect(() => runPlanningCalculationV2({ ...base, pvKwh: nan })).toThrow();
    expect(() => runPlanningCalculationV2({
      request: request({ branch: "new_installation", axis: { slots: 35_040, resolution: "hourly" } }),
      pvKwh: constant(QUARTER_HOUR_SLOTS, 1),
      loadKwh: constant(QUARTER_HOUR_SLOTS, 1),
      providerEstimate: false,
    })).toThrow();
  });
});

const SLOTS_PER_DAY = 96;

describe("F4.1 v2 finalize", () => {
  it("akzeptiert das Engine-Result exakt und weist Manipulation ab", () => {
    const input = {
      request: request(),
      pvKwh: constant(QUARTER_HOUR_SLOTS, 1),
      loadKwh: constant(QUARTER_HOUR_SLOTS, 0.5),
      providerEstimate: true,
    };
    const result = runPlanningCalculationV2(input);
    expect(validatePlanningCalculationResultV2Exactly({ ...input, result }).ok).toBe(true);
    const tampered = structuredClone(result);
    tampered.annual.feedInKwh += 1;
    const rejected = validatePlanningCalculationResultV2Exactly({ ...input, result: tampered });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.paths.join(" ")).toContain("/annual/feedInKwh");
    }
    const wrongSha = validatePlanningCalculationResultV2Exactly({
      ...input,
      request: request({ commissioningDate: "2026-08-30" }),
      result,
    });
    expect(wrongSha).toEqual({ ok: false, paths: ["/inputSha256"] });
  });

  it("rechnet F4.5-Geld nur bei belegtem economics-Input", () => {
    const base = {
      pvKwh: constant(QUARTER_HOUR_SLOTS, 1),
      loadKwh: constant(QUARTER_HOUR_SLOTS, 0.5),
      providerEstimate: false,
    };
    // Ohne economics-Schluessel: kein Geldschluessel (Altresultate stabil).
    const plain = runPlanningCalculationV2({ request: request(), ...base });
    expect("economics" in plain).toBe(false);
    expect(planningCalculationResultV2Schema.safeParse(plain).success).toBe(true);
    // Mit Input: 17520 selbst × 0,36 + 17520 feed × 0,08 = 7708,80 Jahr 1.
    const money = runPlanningCalculationV2({
      request: request({
        economics: {
          importPriceCtPerKwh: 36,
          priceEscalationRate: 0,
          feedInTariffCtPerKwh: 8,
          feedInTariffSource: "override",
          investmentEuro: 20_000,
          alternativeImportPriceCtPerKwh: null,
          horizonYears: 20,
          priceSource: "profile",
          settingsRevision: 0,
        },
      }),
      ...base,
    });
    expect(planningCalculationResultV2Schema.safeParse(money).success).toBe(true);
    expect(money.economics).toMatchObject({
      importPriceCtPerKwh: 36,
      feedInTariffCtPerKwh: 8,
      feedInTariffSource: "override",
      investmentEuro: 20_000,
      horizonYears: 20,
      annualSavingsEuro: 7_708.8,
      amortizationYears: 3,
      // F4.4a: 17520 × 0,36 ohne PV; mit PV Netzbezug 0 (kein Speicher
      // noetig, PV deckt Last); kein Neutarif.
      annualBillsEuro: { noPvEuro: 6_307.2, currentEuro: 0, newTariffEuro: null },
    });
    expect(money.economics!.cumulativeCashflowEuro).toHaveLength(20);
    expect(money.economics!.irr).not.toBeNull();
    // Geld aendert den Input-SHA (Tarife sind Reproduktionsinput).
    expect(money.inputSha256).not.toBe(plain.inputSha256);
  });
});
