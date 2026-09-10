/**
 * F4.1 v2-Run (Spec F4-01): PlanningCalculationRequestV2 + zwei
 * Viertelstunden-Serien (PV-Erzeugung, Last, je exakt 35.040 Slots) ->
 * deterministisches PlanningCalculationResultV2.
 *
 * Reihenfolge PV -> Last -> Speicher -> Netz und zyklischer SoC entsprechen
 * CALCULATION_V2_DISPATCH_VERSION ("load_first_cyclic_soc.v1"); Export ist
 * gemaess CALCULATION_V2_GRID_EXPORT_LIMIT unbegrenzt. Die Datei ist additiv
 * neben engine.ts; die eingefrorene engine-v2.ts wird nur aufgerufen, nie
 * geaendert. Alle ESTIMATE-Annahmen sind an den Funktionen markiert.
 *
 * Noch fehlende Eingabe-Slices (ESTIMATE, keine stillen Defaults): Die
 * Serien pvKwh/loadKwh muessen spaetere Slices liefern (F4.1B-Geometrie,
 * Provider-Rezepte, Verbrauchsprofile). Diese Schicht erfindet keine
 * Erzeugungs- oder Lastdaten, sondern weist unvollstaendige Serien
 * fail-closed ab. Warnungsklassen ohne Datengrundlage im v2-Request
 * (unknown_profile_field, bidirectional/backup) gehoeren zu den Slices, die
 * Profil-/Requirement-Eingaben tragen, und werden hier nicht behauptet.
 * Branch `existing_installation` ist fail-closed (kein
 * Bestand-Port baseline/geplant/Delta; Neuanlagen-Rechnung waere falsch).
 */
import {
  cyclicSocStart,
  dispatchQuarterHours,
  neumaierSum,
  QUARTER_HOUR_SLOTS,
  F401EngineError,
  type StorageParams,
} from "./engine-v2";
import {
  planningCalculationRequestV2Schema,
  planningCalculationResultV2Schema,
  type PlanningCalculationRequestV2,
  type PlanningCalculationResultV2,
} from "./contract-v2";
import {
  computeEconomics,
  computeExistingBillDelta,
  computeTouBillEuro,
  roundMoney,
} from "./economics-v2";
import { hashPlanningCalculationInputV2 } from "./prepare-v2";
import {
  averageDailySchedule,
  cyclicSocStartTou,
  dispatchQuarterHoursTou,
} from "./tou-dispatch-v2";
import {
  CALCULATION_V2_MODEL_ID,
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_QUALITY,
  CALCULATION_V2_RESULT_CONTRACT_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
  CALCULATION_V2_VALIDATION_STATUS,
} from "./versions-v2";

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const SLOTS_PER_DAY = 96;
const SLOT_HOURS = 0.25;
/**
 * Zyklus-Rest nach 35.040 Slots (Spec F4-01, Gate-Tabelle: zyklischer SOC
 * atol 1e-8 kWh). Die Clamp-Komposition ist nicht-expansiv, daher bleibt
 * die Float-Drift in der Groessenordnung weniger ulps (empirisch 0 in
 * Tag/Nacht- und Vollastprofilen); die Schranke ist fail-closed.
 */
const CYCLIC_SOC_ATOL_KWH = 1e-8;
/** Jahresbilanz-Toleranz nach Rundung (Vertrag: Centi-kWh). */
const ANNUAL_BALANCE_ATOL_KWH = 0.01;

export type RunPlanningCalculationV2Input = {
  request: unknown;
  pvKwh: unknown;
  loadKwh: unknown;
  /**
   * true, wenn beide Serien auf Provider-Schaetzungen (z. B. PVGIS-Rezept)
   * statt Messdaten beruhen. Die Engine kennt die Provenienz nicht und
   * raet sie nicht.
   */
  providerEstimate: boolean;
  /**
   * Slice B: Bestands-Reihe (nur Bestand-Branch; sonst null/undefined).
   * Der Run verlangt sie fail-closed, sobald der Branch sie braucht.
   */
  existingPvKwh?: unknown;
};

function runError(detail: string): never {
  throw new F401EngineError(detail);
}

function roundEnergy(value: number): number {
  if (!Number.isFinite(value)) runError("Zwischenergebnis ist nicht endlich");
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Kanonische Serienschranke (35040 endliche, nichtnegative kWh/Slot).
 * Geteilt von Persist- und Finalize-Schicht, damit Claim/Run/Replay
 * dieselbe Schranke sehen.
 */
export function assertSlotSeriesV2(value: unknown, name: string): number[] {
  return requireSeries(value, name);
}

function requireSeries(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) runError(`${name} ist kein Array`);
  if (value.length !== QUARTER_HOUR_SLOTS) {
    runError(`${name} hat ${value.length} statt ${QUARTER_HOUR_SLOTS} Slots`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      runError(`${name}[${index}] ist nicht endlich`);
    }
    if (entry < 0) runError(`${name}[${index}] ist negativ`);
  }
  return value as number[];
}

function requireRequest(value: unknown): PlanningCalculationRequestV2 {
  const parsed = planningCalculationRequestV2Schema.safeParse(value);
  if (!parsed.success) runError("Request verletzt planning-calculation.v2");
  if (parsed.data.axis.slots !== QUARTER_HOUR_SLOTS) {
    runError("Request-Achse ist nicht 35040");
  }
  return parsed.data;
}

/**
 * SoC-unabhaengige Tages-Deltas fuer den zyklischen Fixpunkt: Ueberschuss
 * mal Ladewirkungsgrad bzw. Defizit durch Entladewirkungsgrad, jeweils mit
 * der Nennleistung geclippt. Die Dispatch-Dynamik ist exakt
 * `clamp(soc + delta)` (Monotonie der Float-Multiplikation mit positivem
 * Faktor vorausgesetzt), daher ist der Randfixpunkt aus cyclicSocStart ein
 * exakter Fixpunkt bis auf Float-Drift ueber 35.040 Slots.
 */
function cyclicDeltas(
  pvKwh: number[],
  loadKwh: number[],
  storage: StorageParams,
): number[] {
  const chargeLimitKwh = storage.chargeKw * SLOT_HOURS;
  const dischargeLimitKwh = storage.dischargeKw * SLOT_HOURS;
  const deltas = new Array<number>(QUARTER_HOUR_SLOTS);
  for (let index = 0; index < QUARTER_HOUR_SLOTS; index += 1) {
    const pv = pvKwh[index]!;
    const load = loadKwh[index]!;
    const direct = Math.min(pv, load);
    const surplus = pv - direct;
    const deficit = load - direct;
    deltas[index] = surplus > 0
      ? storage.etaCharge * Math.min(surplus, chargeLimitKwh)
      : -Math.min(deficit, dischargeLimitKwh) / storage.etaDischarge;
  }
  return deltas;
}

type MonthlySums = Array<{
  month: number;
  generationKwh: number;
  selfConsumptionKwh: number;
  gridImportKwh: number;
  feedInKwh: number;
}>;

function aggregateMonthly(input: {
  pvKwh: number[];
  directKwh: number[];
  dischargeOutKwh: number[];
  importKwh: number[];
  exportKwh: number[];
}): MonthlySums {
  const monthly: MonthlySums = [];
  let slot = 0;
  for (let month = 0; month < MONTH_DAYS.length; month += 1) {
    const monthSlots = MONTH_DAYS[month]! * SLOTS_PER_DAY;
    const end = slot + monthSlots;
    monthly.push({
      month: month + 1,
      generationKwh: roundEnergy(
        neumaierSum(input.pvKwh.slice(slot, end)),
      ),
      selfConsumptionKwh: roundEnergy(
        neumaierSum(input.directKwh.slice(slot, end))
        + neumaierSum(input.dischargeOutKwh.slice(slot, end)),
      ),
      gridImportKwh: roundEnergy(neumaierSum(input.importKwh.slice(slot, end))),
      feedInKwh: roundEnergy(neumaierSum(input.exportKwh.slice(slot, end))),
    });
    slot = end;
  }
  if (slot !== QUARTER_HOUR_SLOTS) runError("Monatsabdeckung ist nicht 35040");
  return monthly;
}

type DispatchedSummary = {
  annual: PlanningCalculationResultV2["annual"];
  monthly: PlanningCalculationResultV2["monthly"];
};

/**
 * Ein Dispatch-Lauf (Neuanlage oder eine Bestands-Seite): zyklischer
 * SoC-Dispatch, Guards, Monats-/Jahres-Summary. Byte-identisch zur
 * bisherigen Neuanlagen-Rechnung (Extraktion ohne Verhaltenswechsel).
 */
function dispatchAndSummarize(input: {
  pvKwh: number[];
  loadKwh: number[];
  storage: StorageParams;
}): DispatchedSummary {
  const storage: StorageParams = { ...input.storage };
  const socStartKwh = cyclicSocStart(cyclicDeltas(input.pvKwh, input.loadKwh, storage), storage);
  const { slots, totals } = dispatchQuarterHours({
    pvKwh: input.pvKwh,
    loadKwh: input.loadKwh,
    storage,
    socStartKwh,
  });
  if (Math.abs(totals.socEndKwh - totals.socStartKwh) > CYCLIC_SOC_ATOL_KWH) {
    runError("zyklische SoC-Randbedingung verletzt");
  }
  const usableCapacityKwh = storage.socMaxKwh - storage.socMinKwh;
  // Bei zyklischem SoC kann nicht mehr entladen als (wirkungsgradbereinigt)
  // geladen wurde; sonst ist die Dispatch-Kette inkonsistent.
  if (
    totals.dischargeOutKwh
    > totals.chargeInKwh * storage.etaCharge * storage.etaDischarge + ANNUAL_BALANCE_ATOL_KWH
  ) {
    runError("Entladung uebersteigt wirkungsgradbereinigte Ladung");
  }
  const pick = (select: (slot: (typeof slots)[number]) => number): number[] =>
    slots.map(select);
  const monthly = aggregateMonthly({
    pvKwh: input.pvKwh,
    directKwh: pick((slot) => slot.directKwh),
    dischargeOutKwh: pick((slot) => slot.dischargeOutKwh),
    importKwh: pick((slot) => slot.importKwh),
    exportKwh: pick((slot) => slot.exportKwh),
  });
  const sumMonthly = (select: (month: MonthlySums[number]) => number): number =>
    roundEnergy(neumaierSum(monthly.map(select)));
  const generationKwh = sumMonthly((month) => month.generationKwh);
  const selfConsumptionKwh = sumMonthly((month) => month.selfConsumptionKwh);
  const feedInKwh = sumMonthly((month) => month.feedInKwh);
  const gridImportKwh = sumMonthly((month) => month.gridImportKwh);
  const consumptionKwh = roundEnergy(selfConsumptionKwh + gridImportKwh);
  const directConsumptionKwh = roundEnergy(neumaierSum(pick((slot) => slot.directKwh)));
  const fromStorageKwh = roundEnergy(neumaierSum(pick((slot) => slot.dischargeOutKwh)));
  const storageLossKwh = roundEnergy(neumaierSum(pick((slot) => slot.storageLossKwh)));
  // Energieerhaltung: Erzeugung = Eigenverbrauch + Einspeisung + Verlust
  // (zyklischer SoC traegt nichts bei). Toleranz deckt Monatsrundung ab.
  if (
    Math.abs(generationKwh - selfConsumptionKwh - feedInKwh - storageLossKwh)
    > ANNUAL_BALANCE_ATOL_KWH
  ) {
    runError("Jahres-Energiebilanz verletzt");
  }
  return {
    annual: {
      generationKwh,
      consumptionKwh,
      directConsumptionKwh,
      fromStorageKwh,
      selfConsumptionKwh,
      feedInKwh,
      gridImportKwh,
      storageLossKwh,
      selfConsumptionRate: generationKwh === 0 ? 0 : selfConsumptionKwh / generationKwh,
      autonomyRate: consumptionKwh === 0 ? 0 : selfConsumptionKwh / consumptionKwh,
      storageFullCycles: usableCapacityKwh === 0
        ? 0
        : roundEnergy(totals.dischargeOutKwh / usableCapacityKwh),
    },
    monthly,
  };
}

/**
 * Slice B: Bestands-Seite (v1-Port baseline/geplant/Delta). Baseline:
 * Bestands-PV + vorhandener Speicher; geplant: Bestands-PV +
 * vorhandener + neuer Speicher. Leistungs-/Wirkungsgrad-Parameter stammen
 * aus dem belegten Batterie-Request (v1-Analogie: gleiche Annahmen fuer
 * alte Kapazitaet); ohne aufgeloeste Batterie ist der Dispatch
 * unbestimmbar -> fail-closed (keine erfundenen C-Raten).
 */
function existingStorageParams(
  template: StorageParams,
  capacityKwh: number,
): StorageParams {
  if (!(capacityKwh >= 0) || !Number.isFinite(capacityKwh)) {
    runError("Bestandsspeicher ist ungueltig");
  }
  if (capacityKwh > 0 && !(template.capacityKwh > 0)) {
    // Positive alte Kapazitaet ohne belegte Batterie-Parameter:
    // C-Rate/Wirkungsgrad sind unbestimmbar -> fail-closed.
    runError("Bestands-Dispatch ohne belegte Batterie-Parameter");
  }
  // Bodenbasiert wie v1 (nutzbar ab 0): DoD-Verhaeltnis der belegten
  // Batterie auf die alte Kapazitaet uebertragen. Kapazitaet 0 ist
  // natuerliches No-op (kein Laden/Entladen moeglich).
  const usableRatio = template.capacityKwh > 0
    ? template.socMaxKwh / template.capacityKwh
    : 0;
  return {
    ...template,
    capacityKwh,
    socMinKwh: 0,
    socMaxKwh: capacityKwh * usableRatio,
  };
}

export function runPlanningCalculationV2(
  input: RunPlanningCalculationV2Input,
): PlanningCalculationResultV2 {
  const request = requireRequest(input.request);
  const pvKwh = requireSeries(input.pvKwh, "pvKwh");
  const loadKwh = requireSeries(input.loadKwh, "loadKwh");
  if (typeof input.providerEstimate !== "boolean") {
    runError("providerEstimate ist kein Boolean");
  }
  if (request.branch === "existing_installation") {
    return runExistingInstallationV2(request, loadKwh, input);
  }
  const { annual, monthly } = dispatchAndSummarize({
    pvKwh,
    loadKwh,
    storage: { ...request.storage },
  });
  const tou = touDispatchSection({
    pvKwh,
    loadKwh,
    storage: { ...request.storage },
    request,
  });
  return assembleResultV2(request, annual, monthly, input.providerEstimate, tou);
}

/** F4.4b TOU-Zweitdispatch ohne Ersparnis (Assembly ergaenzt sie). */
type TouDispatchPreSavings = {
  billEuro: number;
  gridChargeKwh: number;
  schedule24h: Array<{
    hour: number;
    chargeKw: number;
    dischargeKw: number;
    gridChargeKw: number;
    socKwh: number;
  }>;
};

/**
 * F4.4b TOU-Zweitdispatch (Neuanlage und geplante Bestands-Seite teilen
 * die Funktion): zyklischer preisgefuehrter Dispatch, Guards, Bill und
 * Ladefahrplan. Nur bei request.tou + request.economics; sonst undefined
 * (kein TOU-Block, kein Fehler).
 */
function touDispatchSection(input: {
  pvKwh: number[];
  loadKwh: number[];
  storage: StorageParams;
  request: PlanningCalculationRequestV2;
}): TouDispatchPreSavings | undefined {
  const { request } = input;
  if (request.tou === undefined || request.economics === undefined) return undefined;
  const prices = [...request.tou.importPricesCtPerKwh];
  const storage = { ...input.storage };
  const socStartKwh = cyclicSocStartTou({
    pvKwh: input.pvKwh,
    loadKwh: input.loadKwh,
    storage,
    touPricesCt: prices,
  });
  const { slots, totals } = dispatchQuarterHoursTou({
    pvKwh: input.pvKwh,
    loadKwh: input.loadKwh,
    storage,
    socStartKwh,
    touPricesCt: prices,
  });
  if (Math.abs(totals.socEndKwh - totals.socStartKwh) > CYCLIC_SOC_ATOL_KWH) {
    runError("zyklische TOU-SoC-Randbedingung verletzt");
  }
  // Entladung (zyklisch) nur aus gespeicherter Energie: PV- plus
  // Netzladung, wirkungsgradbereinigt.
  if (
    totals.dischargeOutKwh
    > (totals.pvChargeInKwh + totals.gridChargeInKwh)
      * storage.etaCharge * storage.etaDischarge + ANNUAL_BALANCE_ATOL_KWH
  ) {
    runError("TOU-Entladung uebersteigt wirkungsgradbereinigte Ladung");
  }
  const billEuro = computeTouBillEuro(
    slots.map((slot) => slot.importKwh),
    prices,
  );
  const schedule24h = averageDailySchedule(slots).map((row) => ({
    hour: row.hour,
    chargeKw: roundEnergy(row.chargeKw),
    dischargeKw: roundEnergy(row.dischargeKw),
    gridChargeKw: roundEnergy(row.gridChargeKw),
    socKwh: roundEnergy(row.socKwh),
  }));
  if (schedule24h.length !== 24) runError("TOU-Fahrplan hat nicht 24 Stunden");
  return {
    billEuro,
    gridChargeKwh: roundEnergy(totals.gridChargeInKwh),
    schedule24h,
  };
}

function runExistingInstallationV2(
  request: PlanningCalculationRequestV2,
  loadKwh: number[],
  input: RunPlanningCalculationV2Input,
): PlanningCalculationResultV2 {
  const context = request.existingInstallation;
  if (context === undefined) {
    runError("Bestands-Kontext fehlt im Request");
  }
  if (input.existingPvKwh === undefined || input.existingPvKwh === null) {
    runError("Bestands-Reihe fehlt im Provider-Input");
  }
  const existingPvKwh = requireSeries(input.existingPvKwh, "existingPvKwh");
  const addedStorageCapacityKwh = request.storage.capacityKwh;
  const baselineStorage = existingStorageParams(
    request.storage,
    context.storageCapacityKwh,
  );
  const plannedStorage = existingStorageParams(
    request.storage,
    context.storageCapacityKwh + addedStorageCapacityKwh,
  );
  const baseline = dispatchAndSummarize({
    pvKwh: existingPvKwh,
    loadKwh,
    storage: baselineStorage,
  });
  const planned = dispatchAndSummarize({
    pvKwh: existingPvKwh,
    loadKwh,
    storage: plannedStorage,
  });
  const additionalSelfConsumptionKwh = roundEnergy(
    planned.annual.selfConsumptionKwh - baseline.annual.selfConsumptionKwh,
  );
  const autonomyRatePercentagePoints = roundEnergy(
    (planned.annual.autonomyRate - baseline.annual.autonomyRate) * 100,
  );
  const candidate = {
    ...assembleResultV2(
      request,
      planned.annual,
      planned.monthly,
      input.providerEstimate,
      touDispatchSection({
        pvKwh: existingPvKwh,
        loadKwh,
        storage: plannedStorage,
        request,
      }),
    ),
    existingInstallation: {
      existingSystemPeakPowerKwp: context.systemPeakPowerKwp,
      existingStorageCapacityKwh: context.storageCapacityKwh,
      addedStorageCapacityKwh,
      baseline: {
        annual: baseline.annual,
        monthly: baseline.monthly,
      },
      delta: {
        additionalSelfConsumptionKwh,
        autonomyRatePercentagePoints,
        // F4.5b: Geldvergleich nur bei belegtem Importpreis (sonst fehlt
        // der Schluessel und Altketten bleiben unveraendert lesbar).
        ...(request.economics === undefined
          ? {}
          : {
            bills: computeExistingBillDelta(
              baseline.annual.gridImportKwh,
              planned.annual.gridImportKwh,
              request.economics.importPriceCtPerKwh,
            ),
          }),
      },
    },
  };
  const parsed = planningCalculationResultV2Schema.safeParse(candidate);
  if (!parsed.success) runError("Bestands-Result verletzt planning-calculation-result.v2");
  return parsed.data;
}

function assembleResultV2(
  request: PlanningCalculationRequestV2,
  annual: DispatchedSummary["annual"],
  monthly: DispatchedSummary["monthly"],
  providerEstimate: boolean,
  touDispatch?: TouDispatchPreSavings,
): Omit<PlanningCalculationResultV2, "existingInstallation"> {
  const warnings: PlanningCalculationResultV2["warnings"] = [];
  if (providerEstimate) {
    warnings.push({ code: "provider_estimate", severity: "info" });
  }
  // F4.5: Geldrechnung nur bei belegtem economics-Input (Neuanlage und
  // Bestand teilen die Assembly; Bestand traegt bislang keinen Input und
  // bleibt ohne Geldschluessel).
  if (request.economics === undefined) {
    return baseResultV2(request, annual, monthly, warnings, undefined);
  }
  const economicsInput = request.economics;
  const money = computeEconomics(
    {
      generationKwh: annual.generationKwh,
      selfConsumptionKwh: annual.selfConsumptionKwh,
      feedInKwh: annual.feedInKwh,
      consumptionKwh: annual.consumptionKwh,
      gridImportKwh: annual.gridImportKwh,
    },
    economicsInput,
  );
  const economics = {
    importPriceCtPerKwh: economicsInput.importPriceCtPerKwh,
    priceEscalationRate: economicsInput.priceEscalationRate,
    feedInTariffCtPerKwh: economicsInput.feedInTariffCtPerKwh,
    feedInTariffSource: economicsInput.feedInTariffSource,
    investmentEuro: economicsInput.investmentEuro,
    alternativeImportPriceCtPerKwh: economicsInput.alternativeImportPriceCtPerKwh,
    horizonYears: economicsInput.horizonYears,
    priceSource: economicsInput.priceSource,
    settingsRevision: economicsInput.settingsRevision,
    ...money,
    // F4.4b: TOU-Block nur bei Zweitdispatch (Ersparnis gegen die
    // Flattarif-Rechnung mit PV aus derselben Geldrechnung).
    ...(touDispatch === undefined
      ? {}
      : {
        tou: {
          ...touDispatch,
          savingsVsFlatEuro: roundMoney(
            money.annualBillsEuro.currentEuro - touDispatch.billEuro,
          ),
        },
      }),
  };
  return baseResultV2(request, annual, monthly, warnings, economics);
}

/**
 * Ergebnis-Huelle (Warnungen + optionaler Geldschluessel -> Schema-Gate).
 * Extrahiert, damit Neuanlage/Bestand und Geld-/TOU-Pfade dieselbe
 * Huelle teilen (kein Verhaltenswechsel ausserhalb F4.4b).
 */
function baseResultV2(
  request: PlanningCalculationRequestV2,
  annual: DispatchedSummary["annual"],
  monthly: DispatchedSummary["monthly"],
  warnings: PlanningCalculationResultV2["warnings"],
  economics: PlanningCalculationResultV2["economics"],
): Omit<PlanningCalculationResultV2, "existingInstallation"> {
  const candidate = {
    contractVersion: CALCULATION_V2_RESULT_CONTRACT_VERSION,
    canonicalizationVersion: "planning-jcs.v1",
    model: {
      id: CALCULATION_V2_MODEL_ID,
      version: CALCULATION_V2_MODEL_VERSION,
      sourceRevision: CALCULATION_V2_SOURCE_REVISION,
    },
    inputSha256: hashPlanningCalculationInputV2(request),
    quality: CALCULATION_V2_QUALITY,
    validationStatus: CALCULATION_V2_VALIDATION_STATUS,
    temporalResolution: "quarter_hour_35040",
    roundingVersion: "wmee-energy-rounding.v1",
    annual,
    monthly,
    warnings,
    ...(economics === undefined ? {} : { economics }),
  };
  const parsed = planningCalculationResultV2Schema.safeParse(candidate);
  if (!parsed.success) runError("Result verletzt planning-calculation-result.v2");
  return parsed.data;
}
