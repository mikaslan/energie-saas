import { describe, expect, it } from "vitest";

import {
  PLANNING_SOLAR_DISPLAY_VERSION,
  planningSolarDisplayV1Schema,
  resolveSolarDisplay,
} from "@/lib/integrations/planning/contracts/solar-display";

/**
 * F3-06a Sonnenstands-Anzeige — Contract-RED.
 * Vertrag: docs/spec/F3-06a-sonnenstand.md
 * Modul fehlt (Stufe-0 noch nicht implementiert) → Import-RED.
 */

const BERLIN_NOON_MIDSUMMER = Date.UTC(2026, 5, 21, 12, 0, 0);

describe("F3-06a Sonnenstands-Contract", () => {
  it("F306-CON-01: Version pinnt, gültige Eingabe parst", () => {
    expect(PLANNING_SOLAR_DISPLAY_VERSION).toBe("planning-solar-display.v1");
    const parsed = planningSolarDisplayV1Schema.safeParse({
      schemaVersion: PLANNING_SOLAR_DISPLAY_VERSION,
      latitude: 52.52,
      longitude: 13.405,
      instantMsUtc: BERLIN_NOON_MIDSUMMER,
    });
    expect(parsed.success).toBe(true);
  });

  it("F306-CON-02: Range-/Typ-Rejects (fail-closed)", () => {
    const base = {
      schemaVersion: PLANNING_SOLAR_DISPLAY_VERSION,
      latitude: 52.52,
      longitude: 13.405,
      instantMsUtc: BERLIN_NOON_MIDSUMMER,
    };
    const bad = [
      { ...base, schemaVersion: "planning-solar-display.v2" },
      { ...base, latitude: 91 },
      { ...base, latitude: -91 },
      { ...base, latitude: Number.NaN },
      { ...base, longitude: 181 },
      { ...base, longitude: Number.POSITIVE_INFINITY },
      { ...base, instantMsUtc: 0 },
      { ...base, instantMsUtc: -1 },
      { ...base, instantMsUtc: 12.5 },
      { ...base, extra: 1 },
    ];
    for (const candidate of bad) {
      expect(
        planningSolarDisplayV1Schema.safeParse(candidate).success,
        JSON.stringify(candidate),
      ).toBe(false);
    }
  });

  it("F306-CON-03: bekannte Position + sunUp-Ableitung", () => {
    const noon = resolveSolarDisplay({
      schemaVersion: PLANNING_SOLAR_DISPLAY_VERSION,
      latitude: 52.52,
      longitude: 13.405,
      instantMsUtc: BERLIN_NOON_MIDSUMMER,
    });
    expect(noon.sunUp).toBe(true);
    expect(noon.elevationDeg).toBeGreaterThan(55);
    expect(noon.elevationDeg).toBeLessThan(65);
    expect(noon.azimuthDegNorth).toBeGreaterThanOrEqual(195);
    expect(noon.azimuthDegNorth).toBeLessThanOrEqual(215);
    const midnight = resolveSolarDisplay({
      schemaVersion: PLANNING_SOLAR_DISPLAY_VERSION,
      latitude: 52.52,
      longitude: 13.405,
      instantMsUtc: Date.UTC(2026, 5, 21, 0, 0, 0),
    });
    expect(midnight.sunUp).toBe(false);
  });
});
