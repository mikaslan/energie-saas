/**
 * F4.4b Preisgefuehrter Speicher-Dispatch (Spec F4-04b-tou-arbitrage):
 * 24-Stunden-Bezugspreis (TOU) + Tag-Voraussicht + Netzladung (Arbitrage)
 * + mittlerer 24-h-Ladefahrplan.
 *
 * Die eingefrorene engine-v2.ts wird nur aufgerufen (cyclicSocStart,
 * Neumaier-Summe), nie geaendert. Die SoC-Dynamik bleibt exakt
 * `clamp(soc + delta)` mit SoC-unabhaengigen Deltas (Preisgatter haengen
 * nur von PV/Last/Preis ab), daher gilt der zyklische Fixpunkt wie F4.1.
 *
 * ESTIMATE-Annahmen sind an den Konstanten/Funktionen markiert.
 */

import {
  cyclicSocStart,
  neumaierSum,
  F401EngineError,
  type StorageParams,
} from "./engine-v2";

const SLOTS_PER_DAY = 96;
const SLOTS_PER_HOUR = 4;
const SLOT_HOURS = 0.25;
const HOURS_PER_DAY = 24;
/** Slot-Energiebilanz vor Persistenz (gleich engine-v2). */
const BALANCE_ATOL_KWH = 1e-9;
/** Gueltiger TOU-Arbeitspreis [Ct/kWh] (Flattarif kennt 1..200; 0 erlaubt). */
const TOU_PRICE_MIN_CT = 0;
const TOU_PRICE_MAX_CT = 200;
/** Tagespreisspanne, unter der TOU als flach gilt [ESTIMATE]. */
const FLAT_DAY_SPREAD_CT = 1;
/**
 * Mindestmarge Median-gegen-P25 nach Rundungsverlust fuer Netzladung
 * [ESTIMATE: keine Zyklen-/Degradationskosten eingepreist].
 */
const ARBITRAGE_MARGIN_CT = 0.5;

function touError(detail: string): never {
  throw new F401EngineError(`TOU-Dispatch v2 verletzt: ${detail}`);
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) touError(`${name} ist nicht endlich`);
}

/**
 * TOU-24-h-Profil pruefen (exakt 24 endliche Preise 0..200 Ct/kWh).
 * Fail-closed: jede Verletzung wirft.
 */
export function assertTouPrices(value: unknown): number[] {
  if (!Array.isArray(value)) touError("TOU-Profil ist kein Array");
  if (value.length !== HOURS_PER_DAY) {
    touError(`TOU-Profil hat ${value.length} statt 24 Stundenpreise`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      touError(`TOU-Preis[${index}] ist nicht endlich`);
    }
    if (entry < TOU_PRICE_MIN_CT || entry > TOU_PRICE_MAX_CT) {
      touError(`TOU-Preis[${index}] ausserhalb 0..200 Ct/kWh`);
    }
  }
  return value as number[];
}

export type TouDayPolicy = {
  /** Netzladung erlaubt (Spanne + Marge + Speicher vorhanden). */
  gridChargeAllowed: boolean;
  /** Entladen erst ab diesem Stundenpreis (Tagesmedian). */
  dischargeFromCt: number;
  /** Netzladung bis zu diesem Stundenpreis (Tages-P25). */
  gridChargeUpToCt: number;
  /** Flacher Tag: Verhalten exakt wie Flattarif. */
  flatDay: boolean;
};

/**
 * Tagespolitik aus den 24 Stundenpreisen: Median als Entladeschwelle,
 * P25 als Netzlade-Obergrenze, Wirtschaftlichkeit gegen
 * Rundungsverluste [ESTIMATE].
 */
export function touDayPolicy(
  pricesCt: readonly number[],
  storage: StorageParams,
): TouDayPolicy {
  const prices = assertTouPrices(pricesCt);
  const sorted = [...prices].sort((a, b) => a - b);
  const spread = sorted[HOURS_PER_DAY - 1]! - sorted[0]!;
  const usableKwh = storage.socMaxKwh - storage.socMinKwh;
  // Quartile als Mittel der Randwerte (24 gerade): Median aus den beiden
  // mittleren, P25 aus der unteren Haelfte.
  const median = (sorted[11]! + sorted[12]!) / 2;
  const p25 = (sorted[5]! + sorted[6]!) / 2;
  const roundTrip = storage.etaCharge * storage.etaDischarge;
  const flatDay = spread < FLAT_DAY_SPREAD_CT;
  const gridChargeAllowed = !flatDay
    && usableKwh > 0
    && median * roundTrip - p25 >= ARBITRAGE_MARGIN_CT;
  return {
    gridChargeAllowed,
    dischargeFromCt: median,
    gridChargeUpToCt: p25,
    flatDay,
  };
}

export type TouSlotResult = {
  pvKwh: number;
  loadKwh: number;
  directKwh: number;
  pvChargeInKwh: number;
  gridChargeInKwh: number;
  dischargeOutKwh: number;
  socBeforeKwh: number;
  socAfterKwh: number;
  storageLossKwh: number;
  exportKwh: number;
  importKwh: number;
};

export type TouHourSchedule = {
  hour: number;
  chargeKw: number;
  dischargeKw: number;
  gridChargeKw: number;
  socKwh: number;
};

export type TouDispatchTotals = {
  importKwh: number;
  exportKwh: number;
  pvChargeInKwh: number;
  gridChargeInKwh: number;
  dischargeOutKwh: number;
  storageLossKwh: number;
  socStartKwh: number;
  socEndKwh: number;
};

function requireTouSeries(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) touError(`${name} ist kein Array`);
  if (value.length === 0 || value.length % SLOTS_PER_DAY !== 0) {
    touError(`${name} deckt keine ganzen Tage ab`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      touError(`${name}[${index}] ist nicht endlich`);
    }
    if (entry < 0) touError(`${name}[${index}] ist negativ`);
  }
  return value as number[];
}

type DesiredFlows = {
  deltas: number[];
  pvCharge: number[];
  charge: number[];
  discharge: number[];
};

/**
 * SoC-unabhaengige Wunschstroeme (Preisgatter nur aus PV/Last/Preis):
 * Direktverbrauch zuerst, PV-Ueberschuss in den Speicher, Entladen nur
 * ab Medianpreis (flacher Tag: immer), Netzladung nur bis P25 und nur bei
 * ausreichender Marge.
 */
function desiredFlows(
  pvKwh: number[],
  loadKwh: number[],
  storage: StorageParams,
  prices: number[],
  policy: TouDayPolicy,
): DesiredFlows {
  const chargeLimitKwh = storage.chargeKw * SLOT_HOURS;
  const dischargeLimitKwh = storage.dischargeKw * SLOT_HOURS;
  const deltas = new Array<number>(pvKwh.length);
  const pvCharge = new Array<number>(pvKwh.length);
  const charge = new Array<number>(pvKwh.length);
  const discharge = new Array<number>(pvKwh.length);
  for (let index = 0; index < pvKwh.length; index += 1) {
    const pv = pvKwh[index]!;
    const load = loadKwh[index]!;
    const price = prices[Math.floor((index % SLOTS_PER_DAY) / SLOTS_PER_HOUR)]!;
    const direct = Math.min(pv, load);
    const surplus = pv - direct;
    const deficit = load - direct;
    const pvChargeKwh = Math.min(surplus, chargeLimitKwh);
    const gridChargeKwh = policy.gridChargeAllowed && price <= policy.gridChargeUpToCt
      ? Math.max(0, chargeLimitKwh - pvChargeKwh)
      : 0;
    const dischargeKwh = deficit > 0
      && (policy.flatDay || price >= policy.dischargeFromCt)
      ? Math.min(deficit, dischargeLimitKwh)
      : 0;
    pvCharge[index] = pvChargeKwh;
    charge[index] = pvChargeKwh + gridChargeKwh;
    discharge[index] = dischargeKwh;
    deltas[index] = storage.etaCharge * (pvChargeKwh + gridChargeKwh)
      - dischargeKwh / storage.etaDischarge;
  }
  return { deltas, pvCharge, charge, discharge };
}

/**
 * Zyklischer Start fuer den TOU-Dispatch: Fixpunkt der
 * SoC-unabhaengigen Wunsch-Deltas (exakt wie engine-v2, da Dynamik
 * `clamp(soc + delta)` ist).
 */
export function cyclicSocStartTou(input: {
  pvKwh: unknown;
  loadKwh: unknown;
  storage: StorageParams;
  touPricesCt: unknown;
}): number {
  const pvKwh = requireTouSeries(input.pvKwh, "pvKwh");
  const loadKwh = requireTouSeries(input.loadKwh, "loadKwh");
  if (pvKwh.length !== loadKwh.length) touError("pv/load-Laengen unterscheiden sich");
  const prices = assertTouPrices(input.touPricesCt);
  const policy = touDayPolicy(prices, input.storage);
  return cyclicSocStart(
    desiredFlows(pvKwh, loadKwh, input.storage, prices, policy).deltas,
    input.storage,
  );
}

/**
 * Preisgefuehrter Dispatch ueber ganze Tage (Laenge % 96 == 0).
 * Stundenpreis des Slots: Tagesprofil an der Slot-Ortsstunde
 * [ESTIMATE: Slot-Tage beginnen um lokale Mitternacht, Achse ab 1.1.].
 */
export function dispatchQuarterHoursTou(input: {
  pvKwh: unknown;
  loadKwh: unknown;
  storage: StorageParams;
  socStartKwh: number;
  touPricesCt: unknown;
}): { slots: TouSlotResult[]; totals: TouDispatchTotals } {
  const pvKwh = requireTouSeries(input.pvKwh, "pvKwh");
  const loadKwh = requireTouSeries(input.loadKwh, "loadKwh");
  if (pvKwh.length !== loadKwh.length) touError("pv/load-Laengen unterscheiden sich");
  const prices = assertTouPrices(input.touPricesCt);
  const { storage, socStartKwh } = input;
  requireFinite(socStartKwh, "socStartKwh");
  if (socStartKwh < storage.socMinKwh || socStartKwh > storage.socMaxKwh) {
    touError("socStartKwh ausserhalb [socMinKwh,socMaxKwh]");
  }
  const policy = touDayPolicy(prices, storage);
  const desired = desiredFlows(pvKwh, loadKwh, storage, prices, policy);
  const slots: TouSlotResult[] = new Array(pvKwh.length);
  let soc = socStartKwh;
  for (let index = 0; index < pvKwh.length; index += 1) {
    const pv = pvKwh[index]!;
    const load = loadKwh[index]!;
    const direct = Math.min(pv, load);
    const surplus = pv - direct;
    const deficit = load - direct;
    // PV-Ladung hat Vorrang vor Netzladung (Eigenverbrauch zuerst).
    const headroom = Math.max(0, (storage.socMaxKwh - soc) / storage.etaCharge);
    const pvChargeIn = Math.min(desired.pvCharge[index]!, headroom);
    const gridChargeIn = Math.min(
      desired.charge[index]! - desired.pvCharge[index]!,
      Math.max(0, headroom - pvChargeIn),
    );
    const dischargeOut = Math.min(
      desired.discharge[index]!,
      Math.max(0, (soc - storage.socMinKwh) * storage.etaDischarge),
    );
    const socAfter = soc
      + storage.etaCharge * (pvChargeIn + gridChargeIn)
      - dischargeOut / storage.etaDischarge;
    const storageLoss = (pvChargeIn + gridChargeIn) * (1 - storage.etaCharge)
      + dischargeOut * (1 / storage.etaDischarge - 1);
    const exportKwh = surplus - pvChargeIn;
    const importKwh = deficit - dischargeOut + gridChargeIn;
    if (Math.abs((pv + importKwh) - (load + exportKwh + storageLoss + (socAfter - soc)))
      > BALANCE_ATOL_KWH) {
      touError(`Slot-Energiebilanz verletzt an Index ${index}`);
    }
    slots[index] = {
      pvKwh: pv,
      loadKwh: load,
      directKwh: direct,
      pvChargeInKwh: pvChargeIn,
      gridChargeInKwh: gridChargeIn,
      dischargeOutKwh: dischargeOut,
      socBeforeKwh: soc,
      socAfterKwh: socAfter,
      storageLossKwh: storageLoss,
      exportKwh,
      importKwh,
    };
    soc = socAfter;
  }
  const pick = (select: (slot: TouSlotResult) => number): number[] =>
    slots.map(select);
  return {
    slots,
    totals: {
      importKwh: neumaierSum(pick((slot) => slot.importKwh)),
      exportKwh: neumaierSum(pick((slot) => slot.exportKwh)),
      pvChargeInKwh: neumaierSum(pick((slot) => slot.pvChargeInKwh)),
      gridChargeInKwh: neumaierSum(pick((slot) => slot.gridChargeInKwh)),
      dischargeOutKwh: neumaierSum(pick((slot) => slot.dischargeOutKwh)),
      storageLossKwh: neumaierSum(pick((slot) => slot.storageLossKwh)),
      socStartKwh,
      socEndKwh: soc,
    },
  };
}

/**
 * Mittlerer 24-h-Ladefahrplan: je Ortsstunde Mittel ueber alle Tage
 * (Laden/Entladen/Netzladung in kW, SoC in kWh).
 */
export function averageDailySchedule(slots: readonly TouSlotResult[]): TouHourSchedule[] {
  if (slots.length === 0 || slots.length % SLOTS_PER_DAY !== 0) {
    touError("Fahrplan braucht ganze Tage");
  }
  const days = slots.length / SLOTS_PER_DAY;
  const schedule: TouHourSchedule[] = [];
  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    let chargeKwh = 0;
    let dischargeKwh = 0;
    let gridKwh = 0;
    let socKwh = 0;
    for (let day = 0; day < days; day += 1) {
      for (let quarter = 0; quarter < SLOTS_PER_HOUR; quarter += 1) {
        const slot = slots[day * SLOTS_PER_DAY + hour * SLOTS_PER_HOUR + quarter]!;
        chargeKwh += slot.pvChargeInKwh + slot.gridChargeInKwh;
        dischargeKwh += slot.dischargeOutKwh;
        gridKwh += slot.gridChargeInKwh;
        socKwh += slot.socBeforeKwh;
      }
    }
    schedule.push({
      hour,
      chargeKw: chargeKwh / days / SLOT_HOURS / SLOTS_PER_HOUR,
      dischargeKw: dischargeKwh / days / SLOT_HOURS / SLOTS_PER_HOUR,
      gridChargeKw: gridKwh / days / SLOT_HOURS / SLOTS_PER_HOUR,
      socKwh: socKwh / (days * SLOTS_PER_HOUR),
    });
  }
  return schedule;
}
