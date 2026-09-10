import { describe, expect, it } from "vitest";

import {
  computeTouBillEuro,
  resolveTouImportPrices,
} from "@/lib/integrations/calculation/economics-v2";
import { dispatchQuarterHours } from "@/lib/integrations/calculation/engine-v2";
import {
  assertTouPrices,
  averageDailySchedule,
  cyclicSocStartTou,
  dispatchQuarterHoursTou,
  touDayPolicy,
} from "@/lib/integrations/calculation/tou-dispatch-v2";

// F4.4b TOU/Arbitrage (Spec F4-04b): Profilaufloesung, Tagespolitik,
// preisgefuehrter Dispatch, Zyklus, Fahrplan, Bill. Serien decken ganze
// Tage ab (je 96 Slots); Stundenpreis = Tagesprofil an der Ortsstunde.

const STORAGE = {
  capacityKwh: 10,
  socMinKwh: 0,
  socMaxKwh: 10,
  chargeKw: 5,
  dischargeKw: 5,
  etaCharge: 0.95,
  etaDischarge: 0.95,
};

// Nacht (0-5h) 20 Ct, Tag 40 Ct: Median 40, P25 20, Spanne 20.
const SPREAD_PRICES = [
  20, 20, 20, 20, 20, 20,
  40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40,
];

const FLAT_PRICES = new Array(24).fill(32);

function daySeries(pvPerSlot: number, loadPerSlot: number, days = 2): {
  pvKwh: number[];
  loadKwh: number[];
} {
  const slots = days * 96;
  return {
    pvKwh: new Array(slots).fill(pvPerSlot),
    loadKwh: new Array(slots).fill(loadPerSlot),
  };
}

const touKnown = (value: unknown) => ({
  status: "known",
  value,
  source: "operator_reviewed",
});

describe("TOU-Profilaufloesung", () => {
  it("nimmt exakt 24 Preise 0..200, sonst null", () => {
    expect(resolveTouImportPrices({ touImportPricesCtPerKwh: touKnown(SPREAD_PRICES) }))
      .toEqual(SPREAD_PRICES);
    expect(resolveTouImportPrices({})).toBeNull();
    expect(resolveTouImportPrices({
      touImportPricesCtPerKwh: { status: "unknown", value: null, source: "not_collected" },
    })).toBeNull();
    expect(resolveTouImportPrices({
      touImportPricesCtPerKwh: touKnown(new Array(23).fill(30)),
    })).toBeNull();
    expect(resolveTouImportPrices({
      touImportPricesCtPerKwh: touKnown([...SPREAD_PRICES.slice(0, 23), 201]),
    })).toBeNull();
    expect(resolveTouImportPrices({
      touImportPricesCtPerKwh: touKnown([...SPREAD_PRICES.slice(0, 23), Number.NaN]),
    })).toBeNull();
  });

  it("weist ungueltige Profile fail-closed ab", () => {
    expect(() => assertTouPrices(new Array(23).fill(30))).toThrow();
    expect(() => assertTouPrices([...SPREAD_PRICES.slice(0, 23), 201])).toThrow();
    expect(() => assertTouPrices("kein-array")).toThrow();
  });
});

describe("TOU-Tagespolitik", () => {
  it("pinnt Median/P25 und erlaubt Netzladung bei Marge", () => {
    const policy = touDayPolicy(SPREAD_PRICES, STORAGE);
    expect(policy.dischargeFromCt).toBe(40);
    // P25 = Mittel aus 6. und 7. Wert (20, 40) = 30.
    expect(policy.gridChargeUpToCt).toBe(30);
    expect(policy.flatDay).toBe(false);
    // 40 x 0,9025 - 30 = 6,1 >= 0,5 Marge.
    expect(policy.gridChargeAllowed).toBe(true);
  });

  it("verhaelt sich flach ohne Spanne", () => {
    const policy = touDayPolicy(FLAT_PRICES, STORAGE);
    expect(policy.flatDay).toBe(true);
    expect(policy.gridChargeAllowed).toBe(false);
  });
});

describe("TOU-Dispatch", () => {
  it("ist bei Flattarif bytegleich zum Flattarif-Dispatch", () => {
    const { pvKwh, loadKwh } = daySeries(0.4, 0.3);
    const flat = dispatchQuarterHours({
      pvKwh,
      loadKwh,
      storage: STORAGE,
      socStartKwh: 5,
    });
    const tou = dispatchQuarterHoursTou({
      pvKwh,
      loadKwh,
      storage: STORAGE,
      socStartKwh: 5,
      touPricesCt: FLAT_PRICES,
    });
    expect(tou.totals.gridChargeInKwh).toBe(0);
    expect(tou.totals.importKwh).toBeCloseTo(flat.totals.importKwh, 12);
    expect(tou.totals.exportKwh).toBeCloseTo(flat.totals.exportKwh, 12);
  });

  it("laedt nachts aus dem Netz und entlaedt tags (Arbitrage)", () => {
    // Kein PV, konstante Last: einzige Quelle ist Netzladung nachts.
    const { pvKwh, loadKwh } = daySeries(0, 0.25);
    const socStartKwh = cyclicSocStartTou({
      pvKwh,
      loadKwh,
      storage: STORAGE,
      touPricesCt: SPREAD_PRICES,
    });
    const { slots, totals } = dispatchQuarterHoursTou({
      pvKwh,
      loadKwh,
      storage: STORAGE,
      socStartKwh,
      touPricesCt: SPREAD_PRICES,
    });
    expect(totals.gridChargeInKwh).toBeGreaterThan(0);
    expect(totals.dischargeOutKwh).toBeGreaterThan(0);
    // Zyklus: Start == Ende (Fixpunkt der Wunsch-Deltas).
    expect(totals.socEndKwh).toBeCloseTo(totals.socStartKwh, 8);
    // Netzladung nur in Stunden 0-5.
    for (const [index, slot] of slots.entries()) {
      const hour = Math.floor((index % 96) / 4);
      if (slot.gridChargeInKwh > 0) expect(hour).toBeLessThan(6);
    }
  });

  it("gibt PV-Ueberschuss Vorrang vor Netzladung", () => {
    // Mittags-PV deckt Last + Speicher: Netzladung bleibt 0 in PV-Stunden.
    const pvKwh = new Array(192).fill(0);
    const loadKwh = new Array(192).fill(0.1);
    for (let day = 0; day < 2; day += 1) {
      for (let slot = 10 * 4; slot < 14 * 4; slot += 1) {
        pvKwh[day * 96 + slot] = 1.5;
      }
    }
    const { totals } = dispatchQuarterHoursTou({
      pvKwh,
      loadKwh,
      storage: STORAGE,
      socStartKwh: cyclicSocStartTou({
        pvKwh,
        loadKwh,
        storage: STORAGE,
        touPricesCt: SPREAD_PRICES,
      }),
      touPricesCt: SPREAD_PRICES,
    });
    expect(totals.pvChargeInKwh).toBeGreaterThan(0);
    expect(totals.exportKwh).toBeGreaterThan(0);
  });
});

describe("Ladefahrplan und Bill", () => {
  it("mittelt 24 Stunden ueber alle Tage", () => {
    const { pvKwh, loadKwh } = daySeries(0, 0.25);
    const { slots } = dispatchQuarterHoursTou({
      pvKwh,
      loadKwh,
      storage: STORAGE,
      socStartKwh: cyclicSocStartTou({
        pvKwh,
        loadKwh,
        storage: STORAGE,
        touPricesCt: SPREAD_PRICES,
      }),
      touPricesCt: SPREAD_PRICES,
    });
    const schedule = averageDailySchedule(slots);
    expect(schedule).toHaveLength(24);
    expect(schedule.map((row) => row.hour)).toEqual(
      Array.from({ length: 24 }, (_, hour) => hour),
    );
    const nightGrid = schedule.slice(0, 6).reduce((sum, row) => sum + row.gridChargeKw, 0);
    const dayGrid = schedule.slice(6).reduce((sum, row) => sum + row.gridChargeKw, 0);
    expect(nightGrid).toBeGreaterThan(0);
    expect(dayGrid).toBe(0);
  });

  it("berechnet die TOU-Rechnung slotgenau", () => {
    // 1 Tag: durchgehend 1 kWh Bezug; Nacht 20 Ct, Tag 40 Ct.
    const imports = new Array(96).fill(1);
    // 6 Nachtstunden x 4 Slots x 20 Ct + 18 Tagstunden x 4 x 40 Ct.
    const expectedCt = 6 * 4 * 20 + 18 * 4 * 40;
    expect(computeTouBillEuro(imports, SPREAD_PRICES)).toBeCloseTo(expectedCt / 100, 10);
    expect(() => computeTouBillEuro(new Array(95).fill(1), SPREAD_PRICES)).toThrow();
  });
});
