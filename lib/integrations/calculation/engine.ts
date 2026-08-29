import {
  CALCULATION_CANONICALIZATION_VERSION,
  PLANNING_CALCULATION_RESULT_CONTRACT_VERSION,
  hashPlanningCalculationInput,
  hashPlanningCalculationResult,
  validatePlanningCalculationRequest,
  validatePlanningCalculationResultForRequest,
  type PlanningCalculationRequestV1,
  type PlanningCalculationResultBodyV1,
  type PlanningCalculationResultV1,
} from "./contract";
import {
  PLANNING_MODEL_ID,
  PLANNING_MODEL_SOURCE_REVISION,
  PLANNING_MODEL_VERSION,
} from "./versions";

const HOURS_PER_YEAR = 8_760;
const PROVIDER_SYSTEM_LOSS_PERCENT = 14;
// Model-internal clean-room coefficients. Their compatibility boundary is the
// pinned model version; customer/project overrides only enter through the
// explicit resolvedAssumptions section of planning-calculation.v1.
const PEAK_POWER_KWP_PER_ROOF_M2 = 0.2;
const EV_CONSUMPTION_KWH_PER_KM = 0.2;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

type AnnualEnergy = Extract<
  PlanningCalculationResultV1,
  { branch: "new_installation" }
>["calculation"]["annual"];
type MonthlyEnergy = Extract<
  PlanningCalculationResultV1,
  { branch: "new_installation" }
>["calculation"]["monthly"];
type Warning = PlanningCalculationResultBodyV1["warnings"][number];

type EnergySimulation = {
  annual: AnnualEnergy;
  monthly: MonthlyEnergy;
};

type HourMetadata = { month: number; day: number; hour: number };

export class PlanningCalculationEngineError extends Error {
  readonly code = "engine_invalid_response" as const;

  constructor(readonly paths: string[] = []) {
    super("planning calculation engine could not produce a valid result");
  }
}

function engineError(paths: string[] = []): never {
  throw new PlanningCalculationEngineError(paths);
}

function buildHourMetadata(): HourMetadata[] {
  const result = new Array<HourMetadata>(HOURS_PER_YEAR);
  let hourIndex = 0;
  let dayIndex = 0;
  for (let month = 0; month < MONTH_DAYS.length; month += 1) {
    for (let day = 0; day < MONTH_DAYS[month]; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        result[hourIndex] = { month, day: dayIndex, hour };
        hourIndex += 1;
      }
      dayIndex += 1;
    }
  }
  return result;
}

const HOURS = buildHourMetadata();

function roundEnergy(value: number): number {
  if (!Number.isFinite(value)) engineError();
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addNormalized(target: number[], weights: number[], annualKwh: number): void {
  if (annualKwh === 0) return;
  const totalWeight = sum(weights);
  if (!(totalWeight > 0)) engineError();
  const scale = annualKwh / totalWeight;
  for (let hour = 0; hour < HOURS_PER_YEAR; hour += 1) {
    target[hour] += weights[hour] * scale;
  }
}

function householdWeights(
  loadProfile: PlanningCalculationRequestV1["effectiveConsumption"]["loadProfile"]["value"],
): number[] {
  return HOURS.map(({ day, hour, month }) => {
    const weekend = day % 7 >= 5;
    const winter = month <= 1 || month >= 10 ? 1.15 : 1;
    if (loadProfile === "commercial_interval.v1") {
      const occupied = !weekend && hour >= 7 && hour < 19;
      return (occupied ? 1 : 0.18) * winter;
    }
    const breakfast = hour >= 6 && hour < 9 ? 1.45 : 0;
    const evening = hour >= 17 && hour < 23 ? 2 : 0;
    const daytime = hour >= 9 && hour < 17 ? (weekend ? 0.9 : 0.55) : 0;
    return (0.3 + breakfast + evening + daytime) * winter;
  });
}

function evWeights(
  pattern: PlanningCalculationRequestV1["effectiveConsumption"]["evChargingPattern"]["value"],
): number[] {
  return HOURS.map(({ day, hour }) => {
    const weekend = day % 7 >= 5;
    if (pattern === "daytime") return hour >= 9 && hour < 17 ? 1 : 0.02;
    if (pattern === "away") {
      return !weekend && hour >= 8 && hour < 18 ? 1 : 0.02;
    }
    return hour >= 18 && hour < 24 ? 1 : 0.02;
  });
}

function degreeWeights(
  temperatures: number[],
  kind: "heating" | "cooling",
): number[] {
  const weights = temperatures.map((temperature) => kind === "heating"
    ? Math.max(0, 18 - temperature)
    : Math.max(0, temperature - 22));
  return sum(weights) > 0 ? weights : new Array<number>(HOURS_PER_YEAR).fill(1);
}

function hotWaterWeights(): number[] {
  return HOURS.map(({ hour }) =>
    hour >= 5 && hour < 9 ? 1.4 : hour >= 18 && hour < 22 ? 1.2 : 0.2,
  );
}

function buildConsumptionSeries(input: PlanningCalculationRequestV1): number[] {
  const effective = input.effectiveConsumption;
  const temperatures = input.yieldSnapshots
    .slice()
    .sort((left, right) => codeUnitCompare(left.roofId, right.roofId))[0]
    ?.hourly.hourlyTemperatureC;
  if (temperatures === undefined || temperatures.length !== HOURS_PER_YEAR) engineError();

  const consumption = new Array<number>(HOURS_PER_YEAR).fill(0);
  addNormalized(
    consumption,
    householdWeights(effective.loadProfile.value),
    effective.householdKwhPerYear.value,
  );
  addNormalized(
    consumption,
    evWeights(effective.evChargingPattern.value),
    effective.evKmPerYear.value * EV_CONSUMPTION_KWH_PER_KM,
  );
  const heating = degreeWeights(temperatures, "heating");
  addNormalized(consumption, heating, effective.heatPumpKwhPerYear.value);
  addNormalized(consumption, heating, effective.heatingAcKwhPerYear.value);
  addNormalized(
    consumption,
    degreeWeights(temperatures, "cooling"),
    effective.coolingKwhPerYear.value,
  );
  addNormalized(consumption, hotWaterWeights(), effective.hotWaterKwhPerYear.value);
  return consumption;
}

function shadingFactor(
  roof: PlanningCalculationRequestV1["energyProfile"]["roofs"][number],
): number {
  if (roof.shading.status === "unknown") engineError();
  return {
    none: 1,
    light: 0.95,
    medium: 0.85,
    strong: 0.7,
  }[roof.shading.value];
}

function buildGenerationSeries(input: PlanningCalculationRequestV1): {
  generation: number[];
  systemPeakPowerKwp: number;
} {
  const roofs = input.energyProfile.roofs
    .slice()
    .sort((left, right) => codeUnitCompare(left.id, right.id));
  const yieldsByRoof = new Map(input.yieldSnapshots.map((entry) => [entry.roofId, entry]));
  const existingPv = input.energyProfile.existingAssets.pv;
  const totalArea = sum(roofs.map((roof) => roof.areaM2));
  if (!(totalArea > 0)) engineError();

  const systemPeakPowerKwp = input.branch === "new_installation"
    ? Math.min(1_000, totalArea * PEAK_POWER_KWP_PER_ROOF_M2)
    : existingPv.status === "known_present"
      ? existingPv.peakPowerKwp
      : engineError();
  const asOfYear = Number(input.asOfDate.slice(0, 4));
  const degradationYears = input.branch === "existing_installation"
    && existingPv.status === "known_present"
    ? Math.max(0, asOfYear - existingPv.commissioningYear)
    : 0;
  const degradationFactor = (1 - input.resolvedAssumptions.moduleDegradationPerYear.value)
    ** degradationYears;
  const relativeLossFactor =
    (1 - input.resolvedAssumptions.systemLossPercent.value / 100)
    / (1 - PROVIDER_SYSTEM_LOSS_PERCENT / 100);
  const generation = new Array<number>(HOURS_PER_YEAR).fill(0);

  for (const roof of roofs) {
    const snapshot = yieldsByRoof.get(roof.id);
    if (snapshot === undefined) engineError();
    const capacityKwp = systemPeakPowerKwp * roof.areaM2 / totalArea;
    const annualPerKwp = snapshot.annual.annualYieldKwhPerKwp;
    const sourcePowerTotal = sum(snapshot.hourly.hourlyPowerWPerKwp);
    if (annualPerKwp > 0 && !(sourcePowerTotal > 0)) engineError();
    if (annualPerKwp === 0) continue;

    const annualGeneration = annualPerKwp
      * capacityKwp
      * shadingFactor(roof)
      * relativeLossFactor
      * degradationFactor;
    for (let hour = 0; hour < HOURS_PER_YEAR; hour += 1) {
      generation[hour] += snapshot.hourly.hourlyPowerWPerKwp[hour]
        / sourcePowerTotal
        * annualGeneration;
    }
  }

  return { generation, systemPeakPowerKwp: roundEnergy(systemPeakPowerKwp) };
}

function emptyMonthlyAccumulator(): Array<{
  generationKwh: number;
  selfConsumptionKwh: number;
  gridImportKwh: number;
  feedInKwh: number;
}> {
  return Array.from({ length: 12 }, () => ({
    generationKwh: 0,
    selfConsumptionKwh: 0,
    gridImportKwh: 0,
    feedInKwh: 0,
  }));
}

function clampStateOfCharge(value: number, usableCapacityKwh: number): number {
  return Math.min(usableCapacityKwh, Math.max(0, value));
}

function storageStateDelta(
  generatedKwh: number,
  consumedKwh: number,
  efficiency: number,
): number {
  const direct = Math.min(generatedKwh, consumedKwh);
  const surplus = generatedKwh - direct;
  const deficit = consumedKwh - direct;
  return surplus > 0 ? surplus * efficiency : -deficit;
}

/**
 * Waehlt den kleinsten stationaeren SOC fuer ein zyklisch wiederholtes Jahr.
 *
 * Jede Stundenabbildung ist `clamp(soc + delta, 0, capacity)`. Ihre
 * Jahreskomposition hat dieselbe Form. Bei positivem Jahressaldo ist ihr
 * oberes, sonst ihr unteres Randbild ein Fixpunkt; bei exakt ausgeglichenem
 * Jahr liefert das untere Randbild den kleinsten Fixpunkt. Damit gilt ohne
 * Warm-up-Heuristik oder Iterationsabbruch reproduzierbar SOC(0) = SOC(8760).
 */
function cyclicInitialStateOfCharge(
  generation: number[],
  consumption: number[],
  usableCapacityKwh: number,
  efficiency: number,
): number {
  if (usableCapacityKwh === 0) return 0;
  let emptyBoundary = 0;
  let fullBoundary = usableCapacityKwh;
  let annualDelta = 0;
  let compensation = 0;

  for (let hour = 0; hour < HOURS_PER_YEAR; hour += 1) {
    const delta = storageStateDelta(generation[hour], consumption[hour], efficiency);
    emptyBoundary = clampStateOfCharge(emptyBoundary + delta, usableCapacityKwh);
    fullBoundary = clampStateOfCharge(fullBoundary + delta, usableCapacityKwh);

    // Kompensierte Summe haelt die Vorzeichenentscheidung auch bei 8.760 sehr
    // unterschiedlich grossen Stundenwerten deterministisch stabil.
    const correctedDelta = delta - compensation;
    const nextAnnualDelta = annualDelta + correctedDelta;
    compensation = (nextAnnualDelta - annualDelta) - correctedDelta;
    annualDelta = nextAnnualDelta;
  }

  return annualDelta > 0 ? fullBoundary : emptyBoundary;
}

function simulateEnergy(
  input: PlanningCalculationRequestV1,
  generation: number[],
  consumption: number[],
  storageCapacityKwh: number,
): EnergySimulation {
  const efficiency = input.resolvedAssumptions.storageRoundtripEfficiency.value;
  const usableCapacity = storageCapacityKwh
    * input.resolvedAssumptions.storageDepthOfDischarge.value;
  const initialStateOfCharge = cyclicInitialStateOfCharge(
    generation,
    consumption,
    usableCapacity,
    efficiency,
  );
  let stateOfCharge = initialStateOfCharge;
  let directConsumption = 0;
  let fromStorage = 0;
  let chargedFromGeneration = 0;
  let storedFromGeneration = 0;
  let storageConversionLoss = 0;
  const monthlyRaw = emptyMonthlyAccumulator();

  for (let hour = 0; hour < HOURS_PER_YEAR; hour += 1) {
    const generated = generation[hour];
    const consumed = consumption[hour];
    const direct = Math.min(generated, consumed);
    const surplus = generated - direct;
    const deficit = consumed - direct;
    const chargeInput = usableCapacity > 0
      ? Math.min(surplus, Math.max(0, (usableCapacity - stateOfCharge) / efficiency))
      : 0;
    const stored = chargeInput * efficiency;
    stateOfCharge += stored;
    const discharged = Math.min(deficit, stateOfCharge);
    stateOfCharge -= discharged;
    const feedIn = surplus - chargeInput;
    const gridImport = deficit - discharged;
    const selfConsumption = direct + discharged;

    directConsumption += direct;
    fromStorage += discharged;
    chargedFromGeneration += chargeInput;
    storedFromGeneration += stored;
    storageConversionLoss += chargeInput - stored;
    const month = monthlyRaw[HOURS[hour].month];
    month.generationKwh += generated;
    month.selfConsumptionKwh += selfConsumption;
    month.gridImportKwh += gridImport;
    month.feedInKwh += feedIn;
  }

  const monthly = monthlyRaw.map((month, index) => ({
    month: index + 1,
    generationKwh: roundEnergy(month.generationKwh),
    selfConsumptionKwh: roundEnergy(month.selfConsumptionKwh),
    gridImportKwh: roundEnergy(month.gridImportKwh),
    feedInKwh: roundEnergy(month.feedInKwh),
  }));
  const generationKwh = roundEnergy(sum(monthly.map((month) => month.generationKwh)));
  const selfConsumptionKwh = roundEnergy(
    sum(monthly.map((month) => month.selfConsumptionKwh)),
  );
  const feedInKwh = roundEnergy(sum(monthly.map((month) => month.feedInKwh)));
  const gridImportKwh = roundEnergy(sum(monthly.map((month) => month.gridImportKwh)));
  const consumptionKwh = roundEnergy(selfConsumptionKwh + gridImportKwh);
  const fromStorageKwh = roundEnergy(fromStorage);
  // Direkten Verbrauch aus seinem nicht-negativen Stundenfluss aggregieren.
  // Die Differenz zweier bereits separat gerundeter Jahressummen kann am
  // Kleinlastrand sonst -0.000001 kWh erzeugen, obwohl jede Stunde gueltig ist.
  const directConsumptionKwh = roundEnergy(directConsumption);
  const storageLossKwh = roundEnergy(storageConversionLoss);
  const annual: AnnualEnergy = {
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
    storageFullCycles: usableCapacity === 0 ? 0 : roundEnergy(fromStorage / usableCapacity),
    fromVehicleKwh: 0,
  };
  // Die zyklische Randbedingung verhindert, dass ein verbleibender End-SOC als
  // Verlust etikettiert wird. `storageLossKwh` umfasst nur die beim Laden
  // angefallene Umwandlungsdifferenz; Monatsrundung darf hoechstens die
  // vertragliche Centi-kWh-Toleranz erzeugen.
  if (
    Math.abs(stateOfCharge - initialStateOfCharge) > 0.000_001
    || Math.abs(storedFromGeneration - fromStorage) > 0.01
    || Math.abs(
      generationKwh - selfConsumptionKwh - feedInKwh - storageLossKwh
    ) > 0.01
    || chargedFromGeneration + 0.01 < fromStorage
  ) {
    engineError();
  }
  return { annual, monthly };
}

function resultWarnings(input: PlanningCalculationRequestV1): Warning[] {
  const warnings: Warning[] = [
    { code: "not_f4_reference_validated", severity: "warning" },
    { code: "provider_estimate", severity: "info" },
  ];
  const hasUnknownEffectiveField = Object.values(input.effectiveConsumption)
    .some((field) => field.resolution === "versioned_default");
  if (hasUnknownEffectiveField) {
    warnings.push({ code: "unknown_profile_field", severity: "warning" });
  }
  if (input.branch === "existing_installation") {
    warnings.push({ code: "existing_installation_limited", severity: "info" });
  }
  if (input.projectRequirements.requestedProducts.bidirectionalCharging) {
    warnings.push({ code: "bidirectional_charging_not_modeled", severity: "warning" });
  }
  if (input.projectRequirements.requestedProducts.backupPower) {
    warnings.push({ code: "backup_power_not_modeled", severity: "warning" });
  }
  return warnings;
}

function baseResult(
  input: PlanningCalculationRequestV1,
): Omit<PlanningCalculationResultBodyV1, "branch" | "calculation"> {
  return {
    contractVersion: PLANNING_CALCULATION_RESULT_CONTRACT_VERSION,
    canonicalizationVersion: CALCULATION_CANONICALIZATION_VERSION,
    model: {
      id: PLANNING_MODEL_ID,
      version: PLANNING_MODEL_VERSION,
      sourceRevision: PLANNING_MODEL_SOURCE_REVISION,
    },
    inputSha256: hashPlanningCalculationInput(input),
    quality: "server_reproduced_estimate",
    validationStatus: "not_f4_reference_validated",
    temporalResolution: "hourly_8760",
    roundingVersion: "wmee-energy-rounding.v1",
    warnings: resultWarnings(input),
  };
}

function existingStorageCapacity(input: PlanningCalculationRequestV1): number {
  const storage = input.energyProfile.existingAssets.storage;
  if (storage.status === "known_present") return storage.capacityKwh;
  if (storage.status === "known_absent") return 0;
  return engineError();
}

export function calculatePlanningEstimate(input: unknown): PlanningCalculationResultV1 {
  const validatedInput = validatePlanningCalculationRequest(input);
  if (!validatedInput.ok) engineError();
  const request = validatedInput.value;
  const consumption = buildConsumptionSeries(request);
  const { generation, systemPeakPowerKwp } = buildGenerationSeries(request);
  const base = baseResult(request);
  let body: PlanningCalculationResultBodyV1;

  if (request.branch === "new_installation") {
    const plannedStorageCapacityKwh = request.effectiveStorageRequest.valueKwh;
    const simulation = simulateEnergy(
      request,
      generation,
      consumption,
      plannedStorageCapacityKwh,
    );
    body = {
      ...base,
      branch: "new_installation",
      calculation: {
        systemPeakPowerKwp,
        plannedStorageCapacityKwh,
        ...simulation,
      },
    };
  } else {
    const existingPv = request.energyProfile.existingAssets.pv;
    if (existingPv.status !== "known_present") engineError();
    const existingStorageCapacityKwh = existingStorageCapacity(request);
    const addedStorageCapacityKwh = request.effectiveStorageRequest.valueKwh;
    const baseline = simulateEnergy(
      request,
      generation,
      consumption,
      existingStorageCapacityKwh,
    );
    const planned = simulateEnergy(
      request,
      generation,
      consumption,
      existingStorageCapacityKwh + addedStorageCapacityKwh,
    );
    body = {
      ...base,
      branch: "existing_installation",
      calculation: {
        existingSystemPeakPowerKwp: systemPeakPowerKwp,
        existingStorageCapacityKwh,
        addedStorageCapacityKwh,
        baseline,
        planned,
        delta: {
          additionalSelfConsumptionKwh: roundEnergy(
            planned.annual.selfConsumptionKwh - baseline.annual.selfConsumptionKwh,
          ),
          autonomyRatePercentagePoints:
            (planned.annual.autonomyRate - baseline.annual.autonomyRate) * 100,
        },
      },
    };
  }

  const candidate = { ...body, resultSha256: hashPlanningCalculationResult(body) };
  const result = validatePlanningCalculationResultForRequest(request, candidate);
  if (!result.ok) engineError(result.paths);
  return result.value;
}
