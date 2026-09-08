import { describe, expect, it } from "vitest";

import { neumaierSum, QUARTER_HOUR_SLOTS } from "@/lib/integrations/calculation/engine-v2";
import {
  PLANNING_ASSUMPTIONS_V2_VERSION,
  buildUniformLoadSourceV2,
  PLANNING_ASSUMPTIONS_V2,
  resolveRoofProviderInputsV2,
} from "@/lib/integrations/calculation/planning-assumptions-v2";

// Weg-2-Upstream (F4.1 v2-Fetch): versionierte, begruendete Planungs-
// annahmen (ESTIMATE, transparent, kein stiller Default) + Dach-Resolver
// aus belegten Profildaechern + uniforme Lastbasis aus belegten kWh.

function roof(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dach-sued",
    areaM2: 52,
    azimuthDeg: 5,
    tiltDeg: 35,
    type: "pitched",
    ...overrides,
  };
}

describe("F4.1 v2 planning assumptions", () => {
  it("pinnt die versionierte Annahme mit belegter Basis", () => {
    expect(PLANNING_ASSUMPTIONS_V2_VERSION).toBe("wmee-planning-assumptions.v1");
    expect(PLANNING_ASSUMPTIONS_V2.version).toBe(PLANNING_ASSUMPTIONS_V2_VERSION);
    expect(Object.isFrozen(PLANNING_ASSUMPTIONS_V2)).toBe(true);
    expect(Object.isFrozen(PLANNING_ASSUMPTIONS_V2.roof)).toBe(true);
    expect(Object.isFrozen(PLANNING_ASSUMPTIONS_V2.load)).toBe(true);
    // Belegt: v1-Produktionspins (contract.ts-Literale, live verifiziert).
    expect(PLANNING_ASSUMPTIONS_V2.roof.pvTechnology).toBe("crystSi");
    expect(PLANNING_ASSUMPTIONS_V2.roof.mountingPlace).toBe("free");
    expect(PLANNING_ASSUMPTIONS_V2.roof.systemLossPercent).toBe(14);
    // ESTIMATE (Midpoints, Upgrade-Pfade dokumentiert).
    expect(PLANNING_ASSUMPTIONS_V2.roof.specificPowerWPerM2).toBe(200);
    expect(PLANNING_ASSUMPTIONS_V2.load.basisShape).toBe("uniform");
    expect(PLANNING_ASSUMPTIONS_V2.load.evKwhPerKm).toBe(0.2);
  });

  it("loest Daecher mit kWp aus belegter Flaeche auf", () => {
    const resolved = resolveRoofProviderInputsV2({
      roofs: [roof(), roof({ id: "dach-nord", areaM2: 30, azimuthDeg: -175, tiltDeg: 30 })],
    });
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toMatchObject({
      roofId: "dach-sued",
      tiltDeg: 35,
      azimuthDeg: 5,
      areaM2: 52,
      peakPowerKwp: 10.4,
      pvTechnology: "crystSi",
      mountingPlace: "free",
      systemLossPercent: 14,
      paramsVersion: PLANNING_ASSUMPTIONS_V2_VERSION,
    });
    expect(resolved[1]?.peakPowerKwp).toBeCloseTo(6, 12);
    // Negative Sued-Null-Azimute (Ost) sind gueltig, keine Geometrie-Range.
    const east = resolveRoofProviderInputsV2({ roofs: [roof({ azimuthDeg: -90 })] });
    expect(east[0]?.azimuthDeg).toBe(-90);
  });

  it("verweigert leere, ueberzählige und ungueltige Daecher fail-closed", () => {
    expect(() => resolveRoofProviderInputsV2({ roofs: [] })).toThrow();
    expect(() => resolveRoofProviderInputsV2({
      roofs: Array.from({ length: 5 }, (_, index) => roof({ id: `dach-${index}` })),
    })).toThrow();
    for (const bad of [
      roof({ areaM2: 0 }),
      roof({ areaM2: -3 }),
      roof({ tiltDeg: 91 }),
      roof({ azimuthDeg: 361 }),
      roof({ id: "" }),
      { id: "x", areaM2: 10, tiltDeg: 30 },
    ]) {
      expect(() => resolveRoofProviderInputsV2({ roofs: [bad] })).toThrow();
    }
  });

  it("baut uniforme Lastquellen mit Provenienz aus belegten kWh", () => {
    const basis = buildUniformLoadSourceV2({ sourceKind: "basis", annualKwh: 4200 });
    expect(basis.sourceKind).toBe("basis");
    expect(basis.sourceRevision).toBe(PLANNING_ASSUMPTIONS_V2_VERSION);
    expect(basis.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(basis.slotEnergyKwh).toHaveLength(QUARTER_HOUR_SLOTS);
    const expected = 4200 / QUARTER_HOUR_SLOTS;
    expect(basis.slotEnergyKwh[0]).toBe(expected);
    expect(basis.slotEnergyKwh[QUARTER_HOUR_SLOTS - 1]).toBe(expected);
    // Exaktheit misst die Neumaier-Summe (load-v2-Mass); naive reduce driftet.
    expect(neumaierSum(basis.slotEnergyKwh)).toBeCloseTo(4200, 12);
    const ev = buildUniformLoadSourceV2({ sourceKind: "ev", annualKwh: 2400 });
    expect(neumaierSum(ev.slotEnergyKwh)).toBeCloseTo(2400, 12);
    expect(() => buildUniformLoadSourceV2({ sourceKind: "basis", annualKwh: -1 })).toThrow();
    expect(() => buildUniformLoadSourceV2({ sourceKind: "basis", annualKwh: Number.NaN })).toThrow();
  });
});
