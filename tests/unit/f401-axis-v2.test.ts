import { describe, expect, it } from "vitest";

import {
  AXIS_VERSION,
  constantQuarters,
  F401AxisError,
  mapProviderYearToQuarterSlots,
} from "@/lib/integrations/calculation/axis-v2";
import { CALCULATION_V2_AXIS_VERSION } from "@/lib/integrations/calculation/versions-v2";

// F4.1 v2-Achse: 8784 Providerstunden (UTC, SARAH-Minute) -> 35040 Slots,
// Berliner Standardzeit fest UTC+1, 29. Februar entfernt.

function providerYear2020(minute = "07"): string[] {
  const hours: string[] = [];
  const start = Date.UTC(2020, 0, 1, 0, 0);
  for (let index = 0; index < 8_784; index += 1) {
    const date = new Date(start + index * 3_600_000);
    const stamp = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`
      + `${String(date.getUTCDate()).padStart(2, "0")}`
      + `:${String(date.getUTCHours()).padStart(2, "0")}${minute}`;
    hours.push(stamp);
  }
  return hours;
}

describe("F4.1 v2 axis", () => {
  it("trägt die gepinnte Achsenversion", () => {
    expect(AXIS_VERSION).toBe(CALCULATION_V2_AXIS_VERSION);
    expect(AXIS_VERSION).toBe(
      "utc_to_berlin_standard_time_circular_then_drop_feb29.v2",
    );
  });

  it("bildet 8784 Stunden auf 35040 Slots ab und entfernt den 29. Februar", () => {
    const slots = mapProviderYearToQuarterSlots(providerYear2020());
    expect(slots).toHaveLength(35_040);
    expect(slots.map((slot) => slot.slot)).toEqual(
      Array.from({ length: 35_040 }, (_, index) => index),
    );
    expect(slots[0]).toMatchObject({
      slot: 0,
      hourIndex: 0,
      quarterIndex: 0,
      providerObservedAtUtc: "20200101:0007",
      providerHourStartUtc: "2020-01-01T00:00:00.000Z",
      evaluationInstantUtc: "2020-01-01T00:07:30.000Z",
      slotLabel: "2020-01-01T01:00+01:00",
    });
    expect(slots[3]).toMatchObject({
      quarterIndex: 3,
      evaluationInstantUtc: "2020-01-01T00:52:30.000Z",
      slotLabel: "2020-01-01T01:45+01:00",
    });
    // Kein Slot stammt aus Berliner 29.-Februar-Stunden, Labels sind
    // lueckenlos fortlaufend ohne Kollision.
    expect(slots.some((slot) => slot.slotLabel.includes("-02-29"))).toBe(false);
    // Berlin-29.-Februar sind UTC 28.02.23:00Z..29.02.22:00Z: deren letzte
    // Stunde fehlt, die Folge-Stunde (Berlin-01.03.) bleibt erhalten.
    expect(
      slots.some((slot) => slot.providerObservedAtUtc === "20200229:2207"),
    ).toBe(false);
    expect(
      slots.some((slot) => slot.providerObservedAtUtc === "20200229:2307"),
    ).toBe(true);
    expect(new Set(slots.map((slot) => slot.slotLabel)).size).toBe(35_040);
    // Letzter Slot: letzte UTC-Stunde 2020-12-31T23:xx + 1h.
    expect(slots[35_039]).toMatchObject({
      hourIndex: 8_759,
      quarterIndex: 3,
      providerHourStartUtc: "2020-12-31T23:00:00.000Z",
      slotLabel: "2021-01-01T00:45+01:00",
    });
  });

  it("hält Temperatur/Wind je Stunde konstant und weist Unendliches ab", () => {
    expect(constantQuarters(12.5)).toEqual([12.5, 12.5, 12.5, 12.5]);
    expect(() => constantQuarters(Number.NaN)).toThrow(F401AxisError);
  });

  it("bricht fail-closed bei falscher Zeilenzahl, Unordnung, Duplikat und Formfehler ab", () => {
    const hours = providerYear2020();
    expect(() => mapProviderYearToQuarterSlots(hours.slice(0, 8_783))).toThrow(
      F401AxisError,
    );
    const unsorted = [...hours];
    [unsorted[10], unsorted[11]] = [unsorted[11]!, unsorted[10]!];
    expect(() => mapProviderYearToQuarterSlots(unsorted)).toThrow(F401AxisError);
    const duplicate = [...hours];
    duplicate[500] = duplicate[499]!;
    expect(() => mapProviderYearToQuarterSlots(duplicate)).toThrow(F401AxisError);
    const badFormat = [...hours];
    badFormat[600] = "2020-01-01 00:07";
    expect(() => mapProviderYearToQuarterSlots(badFormat)).toThrow(F401AxisError);
    const badDate = [...hours];
    badDate[700] = "20200230:0007";
    expect(() => mapProviderYearToQuarterSlots(badDate)).toThrow(F401AxisError);
    // 8784 aufsteigende Stunden ohne 29. Februar sind das falsche
    // Providerjahr (Rezept pinnt 2020).
    const wrongYear: string[] = [];
    const start = Date.UTC(2021, 0, 1, 0, 0);
    for (let index = 0; index < 8_784; index += 1) {
      const date = new Date(start + index * 3_600_000);
      wrongYear.push(
        `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`
          + `${String(date.getUTCDate()).padStart(2, "0")}`
          + `:${String(date.getUTCHours()).padStart(2, "0")}07`,
      );
    }
    expect(() => mapProviderYearToQuarterSlots(wrongYear)).toThrow(F401AxisError);
  });
});
