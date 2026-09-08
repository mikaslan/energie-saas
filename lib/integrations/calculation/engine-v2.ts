/**
 * F4.1A Clean-Room-Kern: Viertelstundenachse und Dispatch PV -> Last ->
 * Speicher -> Netz (Spec F4-01-viertelstunden-simulation, Stand SPECIFIED).
 *
 * Reine Rechenfunktionen ohne IO, ohne Providerzugriff, ohne Rundung:
 * Summen nutzen Neumaier-Kompensation, Bilanz wird fail-closed gepinnt.
 * ESTIMATE-Regeln sind an den jeweiligen Funktionen markiert.
 * Geometrie (SPA/pvlib) gehoert zu F4.1B und kommt als Eingabe herein.
 */

export const QUARTER_HOUR_SLOTS = 35_040;
const HOURS_PER_YEAR = 8_760;
const QUARTERS_PER_HOUR = 4;
const SLOT_HOURS = 0.25;
/** Slot-Energiebilanz vor Persistenz (Spec-Tabelle). */
const BALANCE_ATOL_KWH = 1e-9;

export class F401EngineError extends Error {
  readonly code = "f401_engine_invalid_input" as const;

  constructor(readonly detail: string) {
    super(`f4.1 engine rejected input: ${detail}`);
  }
}

function fail(detail: string): never {
  throw new F401EngineError(detail);
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) fail(`${name} ist nicht endlich`);
}

/** Ordinale Achse `utc_to_berlin_standard_time_circular_then_drop_feb29.v2`:
 * Stunde h -> Slots [4h, 4h+1, 4h+2, 4h+3]. */
export function quarterSlotsForHour(hourIndex: number): [number, number, number, number] {
  if (!Number.isInteger(hourIndex) || hourIndex < 0 || hourIndex >= HOURS_PER_YEAR) {
    fail(`hourIndex ${hourIndex} ausserhalb 0..8759`);
  }
  const base = hourIndex * QUARTERS_PER_HOUR;
  return [base, base + 1, base + 2, base + 3];
}

/** Direkte Gewichte `max(0,sin α_q)` [ESTIMATE: Rekonstruktionsregel]. */
export function directWeight(solarElevationRad: number): number {
  requireFinite(solarElevationRad, "solarElevationRad");
  return Math.max(0, Math.sin(solarElevationRad));
}

/** Diffuse Gewichte `1` fuer `α_q>0`, sonst `0` [ESTIMATE]. */
export function diffuseWeight(solarElevationRad: number): number {
  requireFinite(solarElevationRad, "solarElevationRad");
  return solarElevationRad > 0 ? 1 : 0;
}

/**
 * Stundenmittel auf vier Slots verteilen: `X_q = 4·X_h·w_q/sum(w)`.
 * Bei positiver Quellenergie ohne Gewicht wird abgebrochen (Spec).
 */
export function reconstructQuarters(
  hourMean: number,
  weights: readonly [number, number, number, number],
): [number, number, number, number] {
  requireFinite(hourMean, "hourMean");
  if (hourMean < 0) fail("hourMean ist negativ");
  for (const weight of weights) {
    requireFinite(weight, "weight");
    if (weight < 0) fail("weight ist negativ");
  }
  const total = weights[0]! + weights[1]! + weights[2]! + weights[3]!;
  if (!(total > 0)) {
    if (hourMean === 0) return [0, 0, 0, 0];
    fail("positive Quellenergie ohne Gewicht");
  }
  const scale = (QUARTERS_PER_HOUR * hourMean) / total;
  return [
    weights[0]! * scale,
    weights[1]! * scale,
    weights[2]! * scale,
    weights[3]! * scale,
  ];
}

/** Neumaier-Summation (kompensiert, Spec-Pflicht). */
export function neumaierSum(values: ArrayLike<number>): number {
  let sum = 0;
  let compensation = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    requireFinite(value, "summand");
    const next = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  return sum + compensation;
}

export type StorageParams = {
  capacityKwh: number;
  socMinKwh: number;
  socMaxKwh: number;
  chargeKw: number;
  dischargeKw: number;
  etaCharge: number;
  etaDischarge: number;
};

function validateStorage(storage: StorageParams): void {
  const names = [
    "capacityKwh",
    "socMinKwh",
    "socMaxKwh",
    "chargeKw",
    "dischargeKw",
    "etaCharge",
    "etaDischarge",
  ] as const;
  for (const name of names) requireFinite(storage[name], name);
  if (!(storage.etaCharge > 0 && storage.etaCharge <= 1)) {
    fail("etaCharge ausserhalb (0,1]");
  }
  if (!(storage.etaDischarge > 0 && storage.etaDischarge <= 1)) {
    fail("etaDischarge ausserhalb (0,1]");
  }
  if (storage.chargeKw < 0 || storage.dischargeKw < 0) {
    fail("Lade-/Entladeleistung ist negativ");
  }
  if (!(storage.capacityKwh >= 0)) fail("capacityKwh ist negativ");
  if (!(storage.socMinKwh >= 0)) fail("socMinKwh ist negativ");
  if (!(storage.socMinKwh <= storage.socMaxKwh)) {
    fail("socMinKwh liegt ueber socMaxKwh");
  }
  if (!(storage.socMaxKwh <= storage.capacityKwh)) {
    fail("socMaxKwh liegt ueber capacityKwh");
  }
}

function clampSoc(value: number, storage: StorageParams): number {
  return Math.min(storage.socMaxKwh, Math.max(storage.socMinKwh, value));
}

function foldClamp(start: number, deltas: ArrayLike<number>, storage: StorageParams): number {
  let soc = start;
  for (let index = 0; index < deltas.length; index += 1) {
    soc = clampSoc(soc + deltas[index]!, storage);
  }
  return soc;
}

/**
 * Kleinster zyklischer Fixpunkt `s*`: `D>0 ? F(SOCmax) : F(SOCmin)` mit
 * `F(s) = fold clamp(s+δ)`. Die δ-Folge ist SOC-unabhaengig und wird vom
 * Aufrufer aus Ueberschuss/Defizit gebildet.
 */
export function cyclicSocStart(deltas: ArrayLike<number>, storage: StorageParams): number {
  validateStorage(storage);
  let desired = 0;
  for (let index = 0; index < deltas.length; index += 1) {
    const delta = deltas[index]!;
    requireFinite(delta, "delta");
    desired += delta;
  }
  return desired > 0
    ? foldClamp(storage.socMaxKwh, deltas, storage)
    : foldClamp(storage.socMinKwh, deltas, storage);
}

export type QuarterSlotResult = {
  pvKwh: number;
  loadKwh: number;
  directKwh: number;
  chargeInKwh: number;
  dischargeOutKwh: number;
  socBeforeKwh: number;
  socAfterKwh: number;
  storageLossKwh: number;
  exportKwh: number;
  importKwh: number;
};

export type DispatchTotals = {
  pvKwh: number;
  loadKwh: number;
  directKwh: number;
  chargeInKwh: number;
  dischargeOutKwh: number;
  storageLossKwh: number;
  exportKwh: number;
  importKwh: number;
  socStartKwh: number;
  socEndKwh: number;
};

export function dispatchQuarterHours(input: {
  pvKwh: ArrayLike<number>;
  loadKwh: ArrayLike<number>;
  storage: StorageParams;
  socStartKwh: number;
}): { slots: QuarterSlotResult[]; totals: DispatchTotals } {
  const { pvKwh, loadKwh, storage, socStartKwh } = input;
  validateStorage(storage);
  requireFinite(socStartKwh, "socStartKwh");
  if (socStartKwh < storage.socMinKwh || socStartKwh > storage.socMaxKwh) {
    fail("socStartKwh ausserhalb [socMinKwh,socMaxKwh]");
  }
  if (pvKwh.length !== loadKwh.length) fail("pv/load-Laengen unterscheiden sich");
  const slots: QuarterSlotResult[] = new Array(pvKwh.length);
  let soc = socStartKwh;
  for (let index = 0; index < pvKwh.length; index += 1) {
    const pv = pvKwh[index]!;
    const load = loadKwh[index]!;
    requireFinite(pv, "pvKwh");
    requireFinite(load, "loadKwh");
    if (pv < 0 || load < 0) fail("pv/load ist negativ");
    const direct = Math.min(pv, load);
    const surplus = pv - direct;
    const deficit = load - direct;
    // PV -> Last -> Speicher -> Netz; keine Netzladung/Arbitrage [ESTIMATE].
    const chargeIn = Math.min(
      surplus,
      storage.chargeKw * SLOT_HOURS,
      (storage.socMaxKwh - soc) / storage.etaCharge,
    );
    const dischargeOut = Math.min(
      deficit,
      storage.dischargeKw * SLOT_HOURS,
      (soc - storage.socMinKwh) * storage.etaDischarge,
    );
    const socAfter = soc + storage.etaCharge * chargeIn - dischargeOut / storage.etaDischarge;
    const storageLoss = chargeIn * (1 - storage.etaCharge)
      + dischargeOut * (1 / storage.etaDischarge - 1);
    const exportKwh = surplus - chargeIn;
    const importKwh = deficit - dischargeOut;
    if (Math.abs((pv + importKwh) - (load + exportKwh + storageLoss + (socAfter - soc)))
      > BALANCE_ATOL_KWH) {
      fail(`Slot-Energiebilanz verletzt an Index ${index}`);
    }
    slots[index] = {
      pvKwh: pv,
      loadKwh: load,
      directKwh: direct,
      chargeInKwh: chargeIn,
      dischargeOutKwh: dischargeOut,
      socBeforeKwh: soc,
      socAfterKwh: socAfter,
      storageLossKwh: storageLoss,
      exportKwh,
      importKwh,
    };
    soc = socAfter;
  }
  const pick = (select: (slot: QuarterSlotResult) => number): number[] =>
    slots.map(select);
  return {
    slots,
    totals: {
      pvKwh: neumaierSum(pick((slot) => slot.pvKwh)),
      loadKwh: neumaierSum(pick((slot) => slot.loadKwh)),
      directKwh: neumaierSum(pick((slot) => slot.directKwh)),
      chargeInKwh: neumaierSum(pick((slot) => slot.chargeInKwh)),
      dischargeOutKwh: neumaierSum(pick((slot) => slot.dischargeOutKwh)),
      storageLossKwh: neumaierSum(pick((slot) => slot.storageLossKwh)),
      exportKwh: neumaierSum(pick((slot) => slot.exportKwh)),
      importKwh: neumaierSum(pick((slot) => slot.importKwh)),
      socStartKwh,
      socEndKwh: soc,
    },
  };
}
