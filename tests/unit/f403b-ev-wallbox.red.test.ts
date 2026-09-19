import { describe, expect, it } from "vitest";

import {
  SITE_ENERGY_PROFILE_SCHEMA_VERSION,
  siteEnergyProfileV1Schema,
} from "@/lib/integrations/calculation/contract";
import {
  buildHeatPumpCopSourceV2,
  HEAT_PUMP_HOT_WATER_SHARE_DEFAULT,
} from "@/lib/integrations/calculation/heat-pump-cop-v2";
import { buildEvPatternSourceV2 } from "@/lib/integrations/calculation/load-shapes-v2";
import { PLANNING_ASSUMPTIONS_V2 } from "@/lib/integrations/calculation/planning-assumptions-v2";

// F4-03b RED-Spec (docs/spec/F4-03b-ev-wallbox.md): EV-Segmentfaktoren,
// Wallbox-Kappung, Intake-Widerspruchscheck. NUR existierende Imports;
// die fehlenden Features lassen diese Tests ROT laufen (Beleg in der Spec).
// Pin-Tests (Default 0.2, WW-Split 0) sichern heutiges Verhalten ab.

function label(date: string, hour: number, quarter = 0): string {
  const hh = String(hour).padStart(2, "0");
  const mm = String(quarter * 15).padStart(2, "0");
  return `${date}T${hh}:${mm}+01:00`;
}

function yearStamps(): string[] {
  const stamps: string[] = [];
  const start = Date.UTC(2020, 0, 1);
  for (let day = 0; day < 366; day += 1) {
    const stamp = new Date(start + day * 86_400_000).toISOString().slice(0, 10);
    if (stamp === "2020-02-29") continue;
    stamps.push(stamp);
  }
  return stamps;
}

function fullYearLabels(): string[] {
  const labels: string[] = [];
  for (const stamp of yearStamps()) {
    for (let quarter = 0; quarter < 96; quarter += 1) {
      labels.push(label(stamp, Math.floor(quarter / 4), quarter % 4));
    }
  }
  return labels;
}

function syntheticTemperatures(): { times: string[]; temperatures: Map<string, number> } {
  const times = Array.from({ length: 8_760 }, (_, index) => `hour-${index}`);
  const temperatures = new Map<string, number>(times.map((time) => [time, 10]));
  return { times, temperatures };
}

const unknownField = () => ({
  status: "unknown" as const,
  value: null,
  source: "not_collected" as const,
});

const knownField = (value: unknown) => ({
  status: "known" as const,
  value,
  source: "customer_input" as const,
});

function contradictionProfile(): Record<string, unknown> {
  return {
    schemaVersion: SITE_ENERGY_PROFILE_SCHEMA_VERSION,
    inputMode: "consumption",
    building: {
      type: unknownField(),
      year: unknownField(),
      heatedAreaM2: unknownField(),
    },
    roofs: [
      {
        id: "dach-sued",
        areaM2: 52,
        azimuthDeg: 5,
        tiltDeg: 35,
        type: "pitched",
        shading: unknownField(),
        source: "default",
      },
    ],
    consumption: {
      householdKwhPerYear: unknownField(),
      electricityPriceCentsPerKwh: unknownField(),
      annualPriceIncreasePercent: unknownField(),
      loadProfile: unknownField(),
      evKmPerYear: knownField(15_000),
      evChargingPattern: knownField("evening"),
      heatPumpKwhPerYear: unknownField(),
      coolingKwhPerYear: unknownField(),
      heatingAcKwhPerYear: unknownField(),
      hotWaterKwhPerYear: unknownField(),
    },
    existingAssets: {
      pv: { status: "known_absent", source: "rechner_branch" },
      storage: { status: "unknown", source: "not_collected" },
      wallbox: { status: "unknown", source: "not_collected" },
      ev: { status: "known_absent", source: "rechner_input" },
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
  };
}

// SKIP-Grund: F4-03b ist SPECIFIED, nicht implementiert (3/5 Tests ROT,
// Beleg in docs/spec/F4-03b-ev-wallbox.md „ROT-Beleg"). Das Follow-up,
// das Segmentfaktoren + Wallbox-Kappung + Widerspruchscheck baut,
// entfernt dieses .skip wieder.
describe.skip("F4-03b EV-Segmentfaktoren und Wallbox-Kappung (RED)", () => {
  it("bietet Segmentfaktoren klein/mittel/gross als ESTIMATE an", () => {
    const load = PLANNING_ASSUMPTIONS_V2.load as unknown as Record<string, unknown>;
    expect(load.evKwhPerKmBySegment).toEqual({
      small: 0.15,
      medium: 0.18,
      large: 0.22,
    });
  });

  it("kappt EV-Slots auf wallboxMaxKw (Default 11 kW)", () => {
    const input = {
      annualKwh: 40_000,
      pattern: "evening",
      slotLabels: fullYearLabels(),
      wallboxMaxKw: 11,
    } as Parameters<typeof buildEvPatternSourceV2>[0] & { wallboxMaxKw: number };
    const source = buildEvPatternSourceV2(input);
    const maxSlotKwh = Math.max(...source.slotEnergyKwh);
    expect(maxSlotKwh).toBeLessThanOrEqual(11 * 0.25);
  });

  it("verweigert km > 0 bei gleichzeitig known_absent (fail-explicit)", () => {
    const parsed = siteEnergyProfileV1Schema.safeParse(contradictionProfile());
    expect(parsed.success).toBe(false);
  });
});

// F4-03b Status-quo-Pins (GRÜN, laufen immer): sichern heutiges
// Verhalten bis zur Implementierung der RED-Features oben.
describe("F4-03b Status-quo-Pins (0.2-Default, WW-Split 0)", () => {
  it("pinnt den pauschalen Default 0.2 kWh/km bis zum Beleg", () => {
    expect(PLANNING_ASSUMPTIONS_V2.load.evKwhPerKm).toBe(0.2);
  });

  it("rechnet WW-Split-Default 0 byte-identisch zum expliziten Wert", () => {
    const { times, temperatures } = syntheticTemperatures();
    const base = { hourlyTemperatureC: temperatures, hourTimesInOrder: times };
    const implicit = buildHeatPumpCopSourceV2({ thermalKwh: 10_000, ...base });
    const explicit = buildHeatPumpCopSourceV2({
      thermalKwh: 10_000,
      hotWaterShare: 0,
      ...base,
    });
    expect(HEAT_PUMP_HOT_WATER_SHARE_DEFAULT).toBe(0);
    expect(explicit.slotEnergyKwh).toEqual(implicit.slotEnergyKwh);
    expect(explicit.sourceSha256).toBe(implicit.sourceSha256);
  });
});
