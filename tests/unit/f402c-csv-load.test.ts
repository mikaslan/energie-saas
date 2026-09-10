import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { mapProviderYearToQuarterSlots } from "@/lib/integrations/calculation/axis-v2";
import { neumaierSum } from "@/lib/integrations/calculation/engine-v2";
import { buildLoadSourcesFromProfileV2 } from "@/lib/integrations/calculation/fetch-compose-v2";
import {
  buildCsvProfileSourceV2,
  CSV_PROFILE_V2_SOURCE_ID,
} from "@/lib/integrations/calculation/load-shapes-v2";

// F4.2c Lastgang-CSV (Spec F4-02c): Builder (8760/35040, ESTIMATE-
// Viertelung), Compose-Auswahl und Fail-closed-Pfade.

function horizontalTimes(): string[] {
  const envelope = JSON.parse(readFileSync(
    path.resolve(
      process.cwd(),
      "tests/fixtures/f401/pvgis-horizontal-2020-berlin-52-52-13-41.json",
    ),
    "utf8",
  )) as { hours: Array<{ t: string; t2m: number }> };
  return envelope.hours.map((hour) => hour.t);
}

function loadContext(): {
  slotLabels: string[];
  hourlyTemperatureC: Map<string, number>;
  hourTimesInOrder: string[];
} {
  const slots = mapProviderYearToQuarterSlots(horizontalTimes());
  const seen = new Set<string>();
  const hourTimesInOrder: string[] = [];
  for (const slot of slots) {
    if (seen.has(slot.providerObservedAtUtc)) continue;
    seen.add(slot.providerObservedAtUtc);
    hourTimesInOrder.push(slot.providerObservedAtUtc);
  }
  return {
    slotLabels: slots.map((slot) => slot.slotLabel),
    hourlyTemperatureC: new Map(hourTimesInOrder.map((time) => [time, 10])),
    hourTimesInOrder,
  };
}

const csvKnown = (value: unknown) => ({
  status: "known",
  value,
  source: "operator_reviewed",
});

function consumption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    householdKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
    loadProfile: { status: "unknown", value: null, source: "not_collected" },
    ...overrides,
  };
}

describe("CSV-Basis-Builder", () => {
  it("viertelt 8760 Stundenwerte gleichmaessig und erhaelt die Summe", () => {
    const values = new Array(8_760).fill(1);
    const source = buildCsvProfileSourceV2({ values });
    expect(source.sourceId).toBe(CSV_PROFILE_V2_SOURCE_ID);
    expect(source.sourceKind).toBe("basis");
    expect(source.slotEnergyKwh).toHaveLength(35_040);
    expect(neumaierSum(source.slotEnergyKwh)).toBeCloseTo(8_760, 8);
    // Uniforme Viertelung: jeder Slot einer Stunde traegt 1/4.
    expect(source.slotEnergyKwh[0]).toBeCloseTo(0.25, 12);
    expect(source.slotEnergyKwh[3]).toBeCloseTo(0.25, 12);
    expect(source.slotEnergyKwh[4]).toBeCloseTo(0.25, 12);
  });

  it("uebernimmt 35040 Viertelstundenwerte direkt", () => {
    const values = new Array(35_040).fill(0);
    values[0] = 2;
    values[35_039] = 4;
    const source = buildCsvProfileSourceV2({ values });
    expect(source.slotEnergyKwh[0]).toBeCloseTo(2, 8);
    expect(source.slotEnergyKwh[35_039]).toBeCloseTo(4, 8);
    expect(neumaierSum(source.slotEnergyKwh)).toBeCloseTo(6, 8);
  });

  it("weist falsche Laengen, Negative und Nullsumme fail-closed ab", () => {
    expect(() => buildCsvProfileSourceV2({ values: new Array(100).fill(1) })).toThrow();
    expect(() => buildCsvProfileSourceV2({
      values: [...new Array(8_759).fill(1), -1],
    })).toThrow();
    expect(() => buildCsvProfileSourceV2({ values: new Array(8_760).fill(0) })).toThrow();
    expect(() => buildCsvProfileSourceV2({
      values: [...new Array(8_759).fill(1), Number.NaN],
    })).toThrow();
  });
});

describe("CSV-Compose-Auswahl", () => {
  const csv8760 = new Array(8_760).fill(1);

  it("waehlt die CSV-Basis bei Option + Reihe", () => {
    const sources = buildLoadSourcesFromProfileV2(
      {
        consumption: consumption({
          loadProfile: csvKnown("customer_csv.v1"),
          customCsvKwh: csvKnown(csv8760),
        }),
      },
      loadContext(),
    );
    const basis = sources.filter((source) => source.sourceKind === "basis");
    expect(basis).toHaveLength(1);
    expect(basis[0]!.sourceId).toBe(CSV_PROFILE_V2_SOURCE_ID);
    expect(neumaierSum(basis[0]!.slotEnergyKwh)).toBeCloseTo(8_760, 6);
  });

  it("bricht ohne Reihe, ohne Option, bei Widerspruch und falscher Laenge ab", () => {
    const context = loadContext();
    // Option ohne Reihe.
    expect(() => buildLoadSourcesFromProfileV2(
      { consumption: consumption({ loadProfile: csvKnown("customer_csv.v1") }) },
      context,
    )).toThrow();
    // Reihe ohne Option.
    expect(() => buildLoadSourcesFromProfileV2(
      { consumption: consumption({ customCsvKwh: csvKnown(csv8760) }) },
      context,
    )).toThrow();
    // Jahres-kWh widerspricht der CSV-Summe.
    expect(() => buildLoadSourcesFromProfileV2(
      {
        consumption: consumption({
          loadProfile: csvKnown("customer_csv.v1"),
          customCsvKwh: csvKnown(csv8760),
          householdKwhPerYear: csvKnown(6_000),
        }),
      },
      context,
    )).toThrow();
    // Falsche Reihenlaenge.
    expect(() => buildLoadSourcesFromProfileV2(
      {
        consumption: consumption({
          loadProfile: csvKnown("customer_csv.v1"),
          customCsvKwh: csvKnown(new Array(100).fill(1)),
        }),
      },
      context,
    )).toThrow();
  });
});
