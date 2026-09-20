import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveEconomics } from "@/lib/integrations/calculation/economics-v2";
import { buildPreparedPlanningCalculationInputV2 } from "@/lib/integrations/calculation/prepare-v2";

// F4-01e Wandzeit-Fixes (RED-Guard, Ref docs/spec/F4-01e-wandzeit-fixes.md):
// NUR existierende Imports — kein Import aus noch nicht geschriebenem Code.
// ROT-Beleg per `npx tsx scripts/run-tests.mts tests/unit/f401e-wandzeit.red.test.ts`
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

const known = (value: number) => ({ status: "known", value, source: "operator_reviewed" });

function claim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    siteId: "33333333-3333-4333-8333-333333333333",
    startedAt: "2026-08-29T12:00:00.000Z",
    addressRevision: 1,
    pinConfirmedAddressRevision: 1,
    energyProfileId: "44444444-4444-4444-8444-444444444444",
    energyProfileRevision: 1,
    confirmedEnergyProfileRevision: 1,
    confirmedEnergyProfileAddressRevision: 1,
    projectRequirementId: "55555555-5555-4555-8555-555555555555",
    projectRequirementRevision: 1,
    sourceCalculatorSnapshotId: "66666666-6666-4666-8666-666666666666",
    contractVersion: "planning-calculation.v2",
    defaultsVersion: "wmee-planning-defaults.v2",
    providerRequest: { latitude: 52.52, longitude: 13.41 },
    storage: {
      capacityKwh: 10,
      socMinKwh: 1,
      socMaxKwh: 9,
      chargeKw: 5,
      dischargeKw: 5,
      etaCharge: 0.95,
      etaDischarge: 0.95,
    },
    preparation: {
      profile: {
        schemaVersion: "site-energy-profile.v1",
        inputMode: "consumption",
        building: {
          type: { status: "unknown", value: null, source: "not_collected" },
          year: { status: "unknown", value: null, source: "not_collected" },
          heatedAreaM2: { status: "unknown", value: null, source: "not_collected" },
        },
        roofs: [{
          id: "dach-1", areaM2: 40, azimuthDeg: 180, tiltDeg: 30,
          type: "pitched",
          shading: { status: "unknown", value: null, source: "not_collected" },
          source: "default",
        }],
        consumption: {
          householdKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
          electricityPriceCentsPerKwh: { status: "unknown", value: null, source: "not_collected" },
          annualPriceIncreasePercent: { status: "unknown", value: null, source: "not_collected" },
          loadProfile: { status: "unknown", value: null, source: "not_collected" },
          evKmPerYear: { status: "unknown", value: null, source: "not_collected" },
          evChargingPattern: { status: "unknown", value: null, source: "not_collected" },
          heatPumpKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
          coolingKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
          heatingAcKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
          hotWaterKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
        },
        existingAssets: {
          pv: { status: "known_absent", source: "operator_reviewed" },
          storage: { status: "known_absent", source: "operator_reviewed" },
          wallbox: { status: "known_absent", source: "operator_reviewed" },
          ev: { status: "known_absent", source: "operator_reviewed" },
        },
        provenance: {
          source: "rechner_snapshot",
          sourceSchemaVersion: "wmee-solar-snapshot.v1",
          sourceEngine: "wmee-solar.v1",
          roof: "default",
          consumption: "default",
          electricityPrice: "default",
          annualPriceIncrease: "default",
        },
      },
      requirements: {
        schemaVersion: "project-requirements.rechner.v1",
        source: "wmee-rechner-v3",
        branch: "new_installation",
        requestedProducts: {
          targetStorageKwh: 8,
          wallbox: false,
          bidirectionalCharging: false,
          backupPower: false,
        },
      },
      sourceSnapshot: {
        schemaVersion: "wmee-solar-snapshot.v1",
        branch: "new_installation",
        inputs: {},
      },
    },
    ...overrides,
  };
}

// SKIP-Grund: F4-01e noch nicht implementiert (reine Spec + RED-Beleg, ROT am
// 2026-09-20 bewiesen, Auszug in der Spec). Ref:
// docs/spec/F4-01e-wandzeit-fixes.md — aktivieren, sobald der
// Umsetzungs-Slice (EEG-Jahr/Stichtag/Rohbyte-Bindung) landet.
describe.skip("f401e wandzeit fixes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("EEG-Jahr-Falle: Post-EEG-Kippe ist wandzeitfrei (Inbetriebnahme 2015, Wandzeit 2030 vs 2040)", () => {
    const input = consumption({ feedInCommissioningYear: known(2015) });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-06-01T00:00:00.000Z"));
    const source2030 = resolveEconomics(input)!.feedInTariffSource;
    vi.setSystemTime(new Date("2040-06-01T00:00:00.000Z"));
    const source2040 = resolveEconomics(input)!.feedInTariffSource;
    expect(source2040).toBe(source2030);
  });

  it("EEG-Jahr-Falle: Default-Jahr folgt asOfDate, nicht Laufzeitjahr (Wandzeit 2025 vs 2026)", () => {
    const input = consumption();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T00:00:00.000Z"));
    const tariff2025 = resolveEconomics(input)!.feedInTariffCtPerKwh;
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const tariff2026 = resolveEconomics(input)!.feedInTariffCtPerKwh;
    expect(tariff2026).toBe(tariff2025);
  });

  it("Claim-Drift: startedAt-Drift aendert weder asOfDate noch inputSha256", () => {
    const a = buildPreparedPlanningCalculationInputV2(claim());
    const b = buildPreparedPlanningCalculationInputV2(
      claim({ startedAt: "2026-09-02T12:00:00.000Z" }),
    );
    expect(b.inputSnapshot.asOfDate).toBe(a.inputSnapshot.asOfDate);
    expect(b.inputSha256).toBe(a.inputSha256);
  });

  it("Hash-Mismatch: Request bindet Rohbytes-Provenienz je Abruf (rawSha256)", () => {
    const prepared = buildPreparedPlanningCalculationInputV2(claim());
    const snapshot = prepared.inputSnapshot as unknown as Record<string, unknown>;
    expect(snapshot).toHaveProperty("providerFetches");
    const fetches = snapshot["providerFetches"] as Array<Record<string, unknown>>;
    expect(fetches.length).toBeGreaterThan(0);
    for (const fetch of fetches) {
      expect(fetch["rawSha256"]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("asOfDate-Pflicht: eingefrorener Stichtag aus Preparation schlaegt Claim-Wandzeit", () => {
    const frozen = structuredClone(claim()) as unknown as {
      startedAt: string;
      preparation: Record<string, unknown>;
    };
    frozen.preparation["frozenAsOfDate"] = "2026-08-29";
    frozen.startedAt = "2026-09-02T12:00:00.000Z";
    const prepared = buildPreparedPlanningCalculationInputV2(frozen);
    expect(prepared.inputSnapshot.asOfDate).toBe("2026-08-29");
  });
});
