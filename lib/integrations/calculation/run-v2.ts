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
import { hashPlanningCalculationInputV2 } from "./prepare-v2";
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
/** Zyklus-Rest nach 35.040 Slots (Float-Drift, vgl. engine.ts 1e-6). */
const CYCLIC_SOC_ATOL_KWH = 1e-6;
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
};

function runError(detail: string): never {
  throw new F401EngineError(detail);
}

function roundEnergy(value: number): number {
  if (!Number.isFinite(value)) runError("Zwischenergebnis ist nicht endlich");
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
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

export function runPlanningCalculationV2(
  input: RunPlanningCalculationV2Input,
): PlanningCalculationResultV2 {
  const request = requireRequest(input.request);
  const pvKwh = requireSeries(input.pvKwh, "pvKwh");
  const loadKwh = requireSeries(input.loadKwh, "loadKwh");
  if (typeof input.providerEstimate !== "boolean") {
    runError("providerEstimate ist kein Boolean");
  }
  const storage: StorageParams = { ...request.storage };
  const socStartKwh = cyclicSocStart(cyclicDeltas(pvKwh, loadKwh, storage), storage);
  const { slots, totals } = dispatchQuarterHours({
    pvKwh,
    loadKwh,
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
    pvKwh,
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
  const warnings: PlanningCalculationResultV2["warnings"] = [];
  if (input.providerEstimate) {
    warnings.push({ code: "provider_estimate", severity: "info" });
  }
  if (request.branch === "existing_installation") {
    warnings.push({ code: "existing_installation_limited", severity: "info" });
  }
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
    warnings,
  };
  const parsed = planningCalculationResultV2Schema.safeParse(candidate);
  if (!parsed.success) runError("Result verletzt planning-calculation-result.v2");
  return parsed.data;
}
