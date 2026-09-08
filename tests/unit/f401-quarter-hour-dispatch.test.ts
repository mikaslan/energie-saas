import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CALCULATION_V2_SOURCE_REVISION } from "@/lib/integrations/calculation/versions-v2";
import {
  QUARTER_HOUR_SLOTS,
  cyclicSocStart,
  diffuseWeight,
  directWeight,
  dispatchQuarterHours,
  neumaierSum,
  quarterSlotsForHour,
  reconstructQuarters,
  type StorageParams,
} from "@/lib/integrations/calculation/engine-v2";

// F4.1A RED: energieerhaltende Viertelstundenachse und Dispatch
// PV -> Last -> Speicher -> Netz (Spec F4-01, ESTIMATE-Regeln sichtbar).
// Diese Tests muessen ohne engine-v2.ts rot sein (TDD).

const STORAGE: StorageParams = {
  capacityKwh: 10,
  socMinKwh: 1,
  socMaxKwh: 9,
  chargeKw: 5,
  dischargeKw: 5,
  etaCharge: 0.95,
  etaDischarge: 0.95,
};

describe("F4.1A quarter-hour axis", () => {
  it("bildet 8760 Stunden auf exakt 35040 Slots ab", () => {
    expect(QUARTER_HOUR_SLOTS).toBe(35_040);
    const seen = new Set<number>();
    for (let hour = 0; hour < 8_760; hour += 1) {
      const slots = quarterSlotsForHour(hour);
      expect(slots).toHaveLength(4);
      expect(slots).toEqual([4 * hour, 4 * hour + 1, 4 * hour + 2, 4 * hour + 3]);
      for (const slot of slots) seen.add(slot);
    }
    expect(seen.size).toBe(35_040);
  });

  it("weist Stunden ausserhalb 0..8759 ab", () => {
    expect(() => quarterSlotsForHour(-1)).toThrow();
    expect(() => quarterSlotsForHour(8_760)).toThrow();
  });
});

describe("F4.1A reconstruction", () => {
  it("erhaelt die Stundenenergie exakt (0.25*sum(X_q) = X_h)", () => {
    const quarters = reconstructQuarters(2, [0.1, 0.5, 0.9, 0.3]);
    expect(0.25 * neumaierSum(quarters)).toBeCloseTo(2, 12);
  });

  it("verteilt Nullenergie auf Nullslots", () => {
    expect(reconstructQuarters(0, [0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
  });

  it("bricht bei positiver Energie ohne Gewicht ab", () => {
    expect(() => reconstructQuarters(1, [0, 0, 0, 0])).toThrow();
  });

  it("direkte Gewichte sind max(0,sin α), diffuse 1 genau bei α>0", () => {
    expect(directWeight(Math.PI / 2)).toBeCloseTo(1, 12);
    expect(directWeight(-0.1)).toBe(0);
    expect(directWeight(0)).toBe(0);
    expect(diffuseWeight(0.01)).toBe(1);
    expect(diffuseWeight(0)).toBe(0);
    expect(diffuseWeight(-0.5)).toBe(0);
  });
});

describe("F4.1A dispatch", () => {
  it("ohne Speicher gilt direkt=min, Rest Export/Import", () => {
    const noStorage: StorageParams = {
      ...STORAGE,
      chargeKw: 0,
      dischargeKw: 0,
      socMinKwh: 0,
      socMaxKwh: 0,
    };
    const result = dispatchQuarterHours({
      pvKwh: [1, 0.2],
      loadKwh: [0.4, 0.5],
      storage: noStorage,
      socStartKwh: 0,
    });
    expect(result.slots[0]?.directKwh).toBeCloseTo(0.4, 12);
    expect(result.slots[0]?.exportKwh).toBeCloseTo(0.6, 12);
    expect(result.slots[1]?.directKwh).toBeCloseTo(0.2, 12);
    expect(result.slots[1]?.importKwh).toBeCloseTo(0.3, 12);
  });

  it("laedt Ueberschuss zuerst in den Speicher statt zu exportieren", () => {
    const result = dispatchQuarterHours({
      pvKwh: [2, 0],
      loadKwh: [0.5, 0.5],
      storage: STORAGE,
      socStartKwh: 1,
    });
    // Slot 0: 1.5 kWh Ueberschuss, Ladeleistung 5 kW * 0.25 h = 1.25 kWh AC.
    expect(result.slots[0]?.chargeInKwh).toBeCloseTo(1.25, 12);
    expect(result.slots[0]?.exportKwh).toBeCloseTo(0.25, 12);
  });

  it("haelt die Slot-Energiebilanz je Slot ein (E_pv+Import = Last+Export+Verlust+dSOC)", () => {
    const pv = [1.2, 0.1, 0.8, 0.3, 2.1, 0, 0.4, 1.7];
    const load = [0.5, 0.6, 0.4, 0.9, 0.7, 0.8, 0.5, 0.6];
    const result = dispatchQuarterHours({
      pvKwh: pv,
      loadKwh: load,
      storage: STORAGE,
      socStartKwh: 5,
    });
    for (const slot of result.slots) {
      const left = slot.pvKwh + slot.importKwh;
      const right = slot.loadKwh + slot.exportKwh + slot.storageLossKwh
        + (slot.socAfterKwh - slot.socBeforeKwh);
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1e-9);
    }
  });

  it("findet den kleinsten zyklischen SOC-Fixpunkt", () => {
    const deltas = [1, 1, -0.5, -0.5, 2, -3, 0.5, -0.5];
    const start = cyclicSocStart(deltas, STORAGE);
    expect(start).toBeGreaterThanOrEqual(STORAGE.socMinKwh - 1e-9);
    expect(start).toBeLessThanOrEqual(STORAGE.socMaxKwh + 1e-9);
    const again = cyclicSocStart(deltas, STORAGE);
    expect(again).toBeCloseTo(start, 9);
  });

  it("deckt die Spec-Speicherfaelle D<0, D=0, D>0 ab", () => {
    // D>0 startet oben, D<=0 unten (Spec-Formel s*).
    expect(cyclicSocStart([0.5], STORAGE)).toBe(STORAGE.socMaxKwh);
    expect(cyclicSocStart([-0.5], STORAGE)).toBe(STORAGE.socMinKwh);
    expect(cyclicSocStart([0.5, -0.5], STORAGE)).toBe(STORAGE.socMinKwh);
    // Volle/leere Grenzen kappen Ladung/Entladung exakt.
    const full = dispatchQuarterHours({
      pvKwh: [5],
      loadKwh: [0],
      storage: STORAGE,
      socStartKwh: STORAGE.socMaxKwh,
    });
    expect(full.slots[0]?.chargeInKwh).toBe(0);
    expect(full.slots[0]?.exportKwh).toBe(5);
    const empty = dispatchQuarterHours({
      pvKwh: [0],
      loadKwh: [5],
      storage: STORAGE,
      socStartKwh: STORAGE.socMinKwh,
    });
    expect(empty.slots[0]?.dischargeOutKwh).toBe(0);
    expect(empty.slots[0]?.importKwh).toBe(5);
  });

  it("bilanziert Speicherverluste beidseitig", () => {
    const result = dispatchQuarterHours({
      pvKwh: [3, 0],
      loadKwh: [0, 1],
      storage: STORAGE,
      socStartKwh: 1,
    });
    const charge = result.slots[0]?.chargeInKwh ?? Number.NaN;
    const discharge = result.slots[1]?.dischargeOutKwh ?? Number.NaN;
    expect(charge).toBeGreaterThan(0);
    expect(discharge).toBeGreaterThan(0);
    const loss = result.totals.storageLossKwh;
    expect(loss).toBeCloseTo(
      charge * (1 - STORAGE.etaCharge)
        + discharge * (1 / STORAGE.etaDischarge - 1),
      12,
    );
    expect(loss).toBeGreaterThan(0);
  });

  it("weist ungueltige Speicherparameter ab", () => {
    const bad: StorageParams = { ...STORAGE, etaCharge: 0 };
    expect(() => dispatchQuarterHours({
      pvKwh: [1],
      loadKwh: [1],
      storage: bad,
      socStartKwh: 1,
    })).toThrow();
    const badSoc: StorageParams = { ...STORAGE, socMinKwh: 9, socMaxKwh: 8 };
    expect(() => cyclicSocStart([0.5], badSoc)).toThrow();
  });

  it("summiert mit Neumaier stabil (Ausloeschungs-Fall)", () => {
    expect(neumaierSum([1e16, 1, -1e16])).toBe(1);
    expect(neumaierSum([0.1, 0.2])).toBeCloseTo(0.3, 15);
  });
});

describe("F4.1A source freeze", () => {
  it("pinnt den echten Blob-SHA der eingefrorenen Engine-Bytes", () => {
    const enginePath = path.resolve(
      process.cwd(),
      "lib/integrations/calculation/engine-v2.ts",
    );
    const actual = execFileSync("git", ["hash-object", enginePath], {
      encoding: "utf8",
    }).trim();
    expect(CALCULATION_V2_SOURCE_REVISION).toBe(actual);
  });
});
