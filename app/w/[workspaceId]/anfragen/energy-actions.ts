"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  authorizedAction,
  authorizedQuery,
  NotAuthenticatedError,
} from "@/lib/action";
import {
  canonicalizeCalculationJson,
  mergeRequestedPackages,
  ProjectRequirementsRechnerV1Schema,
  REQUESTED_PACKAGES_UNSET,
  requestedPackageKeys,
  type PackageFormDelta,
  type PackagePaymentKind,
  type RequestedPackages,
} from "@/lib/integrations/calculation/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  confirmProjectEnergyProfile,
  EnergyProfileConflictError,
  EnergyProfileInvalidError,
  EnergyProfileNotFoundError,
  EnergyProfilePrerequisitesError,
  EnergyProfileRateLimitError,
  EnergyProfileRetryConflictError,
  EnergyProfileRoofAcknowledgementError,
  EnergyProfileUnsupportedSourceError,
  getProjectEnergyProfileCandidate,
  readLatestProjectRequirement,
  saveProjectEnergyProfile,
  type LatestProjectRequirement,
  type ProjectEnergyProfileCandidate,
} from "@/modules/energy";

type EnergyProfile = ProjectEnergyProfileCandidate["profile"];

export type SaveProjectEnergyProfileState =
  | { status: "idle" }
  | { status: "success"; revision: number; changed: boolean; confirmed: boolean }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "stale" }
  | { status: "address_not_ready" }
  | { status: "profile_missing" }
  | { status: "roof_review_required" }
  | { status: "unsupported_source" }
  | { status: "packages_unsupported" };

export type ConfirmProjectEnergyProfileState =
  | { status: "idle" }
  | { status: "success"; jobId: string; replayed: boolean }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "stale" }
  | { status: "address_not_ready" }
  | { status: "profile_missing" }
  | { status: "roof_review_required" }
  | { status: "prerequisites_missing" }
  | { status: "unsupported_source" }
  | { status: "retry_conflict" }
  | { status: "rate_limited"; retryAfterSeconds: number };

type SharedEnergyActionErrorState =
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "stale" }
  | { status: "address_not_ready" }
  | { status: "profile_missing" }
  | { status: "roof_review_required" }
  | { status: "unsupported_source" };

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;

function optionalNumber(min: number, max: number, integer = false) {
  return z.string().refine((value) => value === value.trim()).transform((value, ctx) => {
    if (value === "") return null;
    if (!(integer ? INTEGER_PATTERN : DECIMAL_PATTERN).test(value)) {
      ctx.addIssue({ code: "custom", message: "invalid number" });
      return z.NEVER;
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
      ctx.addIssue({ code: "custom", message: "number out of range" });
      return z.NEVER;
    }
    return number;
  });
}

const positiveRevision = z.string().regex(INTEGER_PATTERN).transform(Number).pipe(
  z.number().int().safe().min(1),
);
const nonNegativeRevision = z.string().regex(INTEGER_PATTERN).transform(Number).pipe(
  z.number().int().safe().min(0),
);
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.literal(""), z.enum(values)]).transform((value) => value === "" ? null : value);

// F4.2 Custom-Lastprofil: 12 Monats-kWh + je 24 Werktags-/Wochenendstunden.
// Nur bei Monatsprofil-Option erlaubt (branchabhängige Allowlist unten);
// halb belegte Tage verweigert die Schema-Refine.
const customMonthlyFieldNames = Array.from(
  { length: 12 },
  (_, month) => `customMonthly.${month}`,
);
const customWeekdayFieldNames = Array.from(
  { length: 24 },
  (_, hour) => `customWeekday.${hour}`,
);
const customWeekendFieldNames = Array.from(
  { length: 24 },
  (_, hour) => `customWeekend.${hour}`,
);
const customProfileFieldNames = [
  ...customMonthlyFieldNames,
  ...customWeekdayFieldNames,
  ...customWeekendFieldNames,
];
const MONTHLY_LOAD_PROFILE_FORM_VALUE = "customer_monthly_hourly.v1";
const CSV_LOAD_PROFILE_FORM_VALUE = "customer_csv.v1";

// F1-19 Eingabemodus: consumption (Rechner), property (Objekt-Schaetzung),
// roomwise (Raumliste), manual (freie Operateur-Eingabe). Modus-Sektionen
// sind branch-abhaengig exakt erlaubt (Allowlist unten + Refine).
const inputModeSchema = z.enum(["consumption", "property", "roomwise", "manual"]);
const heatingTypeSchema = z.enum([
  "gas",
  "oil",
  "heat_pump",
  "district_heating",
  "direct_electric",
  "biomass",
  "other",
]);
const roomUsageSchema = z.enum([
  "living",
  "bedroom",
  "kitchen",
  "bathroom",
  "hallway",
  "office",
  "commercial",
  "storage",
  "other",
]);
const roomCountSchema = z.string().regex(/^(?:0|[1-9]|[1-3][0-9]|40)$/u).transform(Number);
// Paket-Matrix: "" = unveraendert (Merge serverseitig), sonst explizit.
const packageWantedSchema = z.enum(["", "true", "false"]).transform((value) =>
  value === "" ? null : value === "true",
);
const packagePaymentSchema = z.enum(["", "purchase", "leasing", "financing"]).transform(
  (value) => (value === "" ? null : value),
);

const profileFormSchema = z.strictObject({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  expectedAddressRevision: positiveRevision,
  expectedLatestRevision: nonNegativeRevision,
  roofCount: z.string().regex(/^[1-4]$/u).transform(Number),
  // F1-19: prefault statt required — alte Formulare/Tests ohne neue Felder
  // bleiben gueltig (consumption, keine Raeume, Pakete unveraendert).
  inputMode: inputModeSchema.prefault("consumption"),
  roomCount: roomCountSchema.prefault("0"),
  // F1-19 property-Sektion (nur im property-Branch erlaubt, dort Pflicht;
  // .optional() wie Custom-Felder: fehlende Keys zählen als leer).
  heatingType: z.union([z.literal(""), heatingTypeSchema]).transform((value) =>
    value === "" ? null : value,
  ).optional(),
  residentCount: optionalNumber(1, 20, true).optional(),
  // F1-19 Paket-Matrix (alle Modi; leer/fehlend = unveraendert).
  pkgSolarWanted: packageWantedSchema.prefault(""),
  pkgSolarPayment: packagePaymentSchema.prefault(""),
  pkgStorageWanted: packageWantedSchema.prefault(""),
  pkgStoragePayment: packagePaymentSchema.prefault(""),
  pkgWallboxWanted: packageWantedSchema.prefault(""),
  pkgWallboxPayment: packagePaymentSchema.prefault(""),
  pkgHeatingWanted: packageWantedSchema.prefault(""),
  pkgHeatingPayment: packagePaymentSchema.prefault(""),
  buildingType: optionalEnum([
    "single_family",
    "two_family",
    "multi_family",
    "commercial",
  ]),
  buildingYear: optionalNumber(1800, 2200, true),
  heatedAreaM2: optionalNumber(0, 10_000),
  householdKwhPerYear: optionalNumber(0, 100_000),
  electricityPriceCentsPerKwh: optionalNumber(1, 200),
  annualPriceIncreasePercent: optionalNumber(-10, 25),
  loadProfile: optionalEnum([
    "wmee_household_hourly.v1",
    "customer_monthly_hourly.v1",
    "commercial_interval.v1",
    "customer_csv.v1",
  ]),
  // F4.2c Lastgang-CSV: eine Zahl pro Zeile (8760/35040, leer = kein CSV).
  loadProfileCsv: csvValueListField().optional(),
  evKmPerYear: optionalNumber(0, 200_000),
  evChargingPattern: optionalEnum(["evening", "daytime", "away"]),
  heatPumpKwhPerYear: optionalNumber(0, 100_000),
  // F4.3 WP-COP: thermischer Bedarf + optionale Kennlinienparameter.
  // .optional() wie Custom-Felder: fehlende Keys zählen als leer.
  heatPumpThermalKwhPerYear: optionalNumber(0, 100_000).optional(),
  heatPumpCopNominal: optionalNumber(1, 8).optional(),
  heatPumpBivalenceTempC: optionalNumber(-25, 15).optional(),
  heatPumpHotWaterShare: optionalNumber(0, 1).optional(),
  // F4.5 Wirtschaftlichkeit: Investition + Einspeisekaskade.
  investmentEuro: optionalNumber(0, 10_000_000).optional(),
  feedInTariffCtPerKwh: optionalNumber(0, 100).optional(),
  feedInCommissioningYear: optionalNumber(1990, 2100, true).optional(),
  // Boden-Albedo (Muneer-Reflexion; leer = fixture-gepinnt 0.2).
  groundAlbedo: optionalNumber(0, 1).optional(),
  // F4.4a Tarifvergleich: optionaler Neutarif (leer = kein Vergleich).
  alternativeImportPriceCtPerKwh: optionalNumber(1, 200).optional(),
  // F4-04c Mehrjahres-Serie: optionale Neutarif-Eskalation % p. a.
  // (leer = gleiche Eskalation wie aktueller Tarif, dokumentiert).
  alternativeImportPriceEscalationPct: optionalNumber(-10, 25).optional(),
  // F4-04d Grundpreis je Tarif (€/Jahr, leer = 0, kein Vergleich).
  baseFeeEuroPerYear: optionalNumber(0, 100_000).optional(),
  alternativeBaseFeeEuroPerYear: optionalNumber(0, 100_000).optional(),
  // F4-04e Leistungspreis je Tarif (€/kW, leer = 0, kein Vergleich).
  demandChargeEuroPerKw: optionalNumber(0, 10_000).optional(),
  alternativeDemandChargeEuroPerKw: optionalNumber(0, 10_000).optional(),
  // F4-04f Vergleichstarife (je Gruppe: Name oder alles leer; Cap 3
  // durch genau drei Gruppen, Teilmengen fail-closed in der Assembly).
  cmp0Name: z.string().max(40).optional(),
  cmp0Price: optionalNumber(1, 200).optional(),
  cmp0Escalation: optionalNumber(-10, 25).optional(),
  cmp0BaseFee: optionalNumber(0, 100_000).optional(),
  cmp0Demand: optionalNumber(0, 10_000).optional(),
  cmp1Name: z.string().max(40).optional(),
  cmp1Price: optionalNumber(1, 200).optional(),
  cmp1Escalation: optionalNumber(-10, 25).optional(),
  cmp1BaseFee: optionalNumber(0, 100_000).optional(),
  cmp1Demand: optionalNumber(0, 10_000).optional(),
  cmp2Name: z.string().max(40).optional(),
  cmp2Price: optionalNumber(1, 200).optional(),
  cmp2Escalation: optionalNumber(-10, 25).optional(),
  cmp2BaseFee: optionalNumber(0, 100_000).optional(),
  cmp2Demand: optionalNumber(0, 10_000).optional(),
  // F4.4b TOU: 24 Stundenpreise Komma-getrennt (leer = kein TOU).
  touImportPricesCt: touPriceListField().optional(),
  coolingKwhPerYear: optionalNumber(0, 100_000),
  heatingAcKwhPerYear: optionalNumber(0, 100_000),
  hotWaterKwhPerYear: optionalNumber(0, 20_000),
  pvStatus: z.enum(["unknown", "known_absent", "known_present"]),
  pvPeakPowerKwp: optionalNumber(0.000_001, 1_000),
  pvCommissioningYear: optionalNumber(1900, 2200, true),
  storageStatus: z.enum(["unknown", "known_absent", "known_present"]),
  storageCapacityKwh: optionalNumber(0.000_001, 1_000),
  wallboxStatus: z.enum(["unknown", "known_absent", "known_present"]),
  evStatus: z.enum(["unknown", "known_absent", "known_present"]),
  // Optional (Pflicht nur per Allowlist+Refine im Monats-Branch);
  // fehlende Keys sind undefined und zählen als leer.
  ...Object.fromEntries(
    customProfileFieldNames.map((name) => [name, optionalNumber(0, 100_000).optional()]),
  ),
}).superRefine((value, ctx) => {
  if (
    value.pvStatus === "known_present"
    && (value.pvPeakPowerKwp === null || value.pvCommissioningYear === null)
  ) {
    ctx.addIssue({ code: "custom", path: ["pvStatus"], message: "missing PV details" });
  }
  if (value.storageStatus === "known_present" && value.storageCapacityKwh === null) {
    ctx.addIssue({ code: "custom", path: ["storageStatus"], message: "missing storage" });
  }
  const record = value as unknown as Record<string, number | null>;
  const monthly = customMonthlyFieldNames.map((name) => record[name] ?? null);
  const weekday = customWeekdayFieldNames.map((name) => record[name] ?? null);
  const weekend = customWeekendFieldNames.map((name) => record[name] ?? null);
  if (value.loadProfile === MONTHLY_LOAD_PROFILE_FORM_VALUE) {
    if (monthly.some((kwh) => kwh === null)) {
      ctx.addIssue({ code: "custom", path: ["loadProfile"], message: "missing monthly kWh" });
    }
    for (const [dayName, day] of [["weekday", weekday], ["weekend", weekend]] as const) {
      const filled = day.filter((kwh) => kwh !== null);
      if (filled.length > 0 && filled.length < 24) {
        ctx.addIssue({ code: "custom", path: ["loadProfile"], message: `partial ${dayName} hours` });
      }
    }
  } else if ([...monthly, ...weekday, ...weekend].some((kwh) => kwh !== null)) {
    ctx.addIssue({ code: "custom", path: ["loadProfile"], message: "custom values without monthly option" });
  }
  // F4.2c: CSV-Option verlangt die Reihe (und umgekehrt).
  const csvValues = (value as unknown as Record<string, number[] | null | undefined>).loadProfileCsv ?? null;
  if (value.loadProfile === CSV_LOAD_PROFILE_FORM_VALUE) {
    if (csvValues === null) {
      ctx.addIssue({ code: "custom", path: ["loadProfile"], message: "missing csv series" });
    }
  } else if (csvValues !== null) {
    ctx.addIssue({ code: "custom", path: ["loadProfile"], message: "csv series without csv option" });
  }
  // F4.3: thermischer und legacy-elektrischer WP-Bedarf zugleich ist ein
  // Widerspruch (keine stille Praezedenz). Kennlinienparameter ohne
  // Thermalbedarf sind unbelegt (kein COP-Pfad).
  // .optional()-Felder: fehlende Keys (undefined) zählen wie leere ("").
  const thermalKwh = value.heatPumpThermalKwhPerYear ?? null;
  const thermalFilled = thermalKwh !== null && thermalKwh > 0;
  if (thermalFilled && value.heatPumpKwhPerYear !== null && value.heatPumpKwhPerYear > 0) {
    ctx.addIssue({ code: "custom", path: ["heatPumpThermalKwhPerYear"], message: "thermal and electrical heat pump conflict" });
  }
  if (
    !thermalFilled
    && (
      (value.heatPumpCopNominal ?? null) !== null
      || (value.heatPumpBivalenceTempC ?? null) !== null
      || (value.heatPumpHotWaterShare ?? null) !== null
    )
  ) {
    ctx.addIssue({ code: "custom", path: ["heatPumpThermalKwhPerYear"], message: "COP parameters without thermal demand" });
  }
  // F1-19 Modus-Kopplung: property verlangt Heizart + Bewohner, roomwise
  // 1..40 Raeume, andere Modi keine Modus-Sektion (Allowlist verhindert
  // fremde Felder; halb belegte Modi scheitern hier, nicht still).
  if (value.inputMode === "property") {
    if ((value.heatingType ?? null) === null || (value.residentCount ?? null) === null) {
      ctx.addIssue({ code: "custom", path: ["inputMode"], message: "property needs heating type and residents" });
    }
    if (value.roomCount !== 0) {
      ctx.addIssue({ code: "custom", path: ["inputMode"], message: "rooms only in roomwise mode" });
    }
  } else if (value.inputMode === "roomwise") {
    if (value.roomCount < 1 || value.roomCount > 40) {
      ctx.addIssue({ code: "custom", path: ["inputMode"], message: "roomwise needs 1..40 rooms" });
    }
  } else if (value.roomCount !== 0) {
    ctx.addIssue({ code: "custom", path: ["inputMode"], message: "rooms only in roomwise mode" });
  }
});

const roofFormSchema = z.strictObject({
  id: z.string().min(1).max(64).refine((value) => value === value.trim()),
  areaM2: optionalNumber(0.000_001, 2_000).pipe(z.number()),
  azimuthDeg: optionalNumber(-180, 180).pipe(z.number()),
  tiltDeg: optionalNumber(0, 90).pipe(z.number()),
  type: z.enum(["pitched", "flat"]),
  shading: optionalEnum(["none", "light", "medium", "strong"]),
  reviewed: z.enum(["true", "false"]).transform((value) => value === "true"),
  replaceDefault: z.enum(["true", "false"]).transform((value) => value === "true"),
});

// F1-19 Raumzeile (roomwise-Modus): Name/Flaeche/Nutzung/Heizkoerper,
// je Zeile vollstaendig oder gar nicht (halb fail-closed).
const roomFormSchema = z.strictObject({
  name: z.string().min(1).max(64).refine((value) => value === value.trim()),
  areaM2: optionalNumber(0.000_001, 2_000).pipe(z.number()),
  usage: roomUsageSchema,
  radiators: optionalNumber(0, 50, true).pipe(z.number()),
});

const propertyBranchFields = ["heatingType", "residentCount"] as const;

// F1-19: erlaubt, aber nicht Pflicht (alte Formulare ohne diese Felder
// bleiben gueltig; Schema-Prefaults liefern die Defaults).
const optionalProfileFields = [
  "inputMode",
  "roomCount",
  "pkgSolarWanted",
  "pkgSolarPayment",
  "pkgStorageWanted",
  "pkgStoragePayment",
  "pkgWallboxWanted",
  "pkgWallboxPayment",
  "pkgHeatingWanted",
  "pkgHeatingPayment",
] as const;

const baseProfileFields = [
  "workspaceId",
  "projectId",
  "expectedAddressRevision",
  "expectedLatestRevision",
  "roofCount",
  "buildingType",
  "buildingYear",
  "heatedAreaM2",
  "householdKwhPerYear",
  "electricityPriceCentsPerKwh",
  "annualPriceIncreasePercent",
  "loadProfile",
  "evKmPerYear",
  "evChargingPattern",
  "heatPumpKwhPerYear",
  "heatPumpThermalKwhPerYear",
  "heatPumpCopNominal",
  "heatPumpBivalenceTempC",
  "heatPumpHotWaterShare",
  "investmentEuro",
  "feedInTariffCtPerKwh",
  "feedInCommissioningYear",
  "groundAlbedo",
  "alternativeImportPriceCtPerKwh",
  "alternativeImportPriceEscalationPct",
  "baseFeeEuroPerYear",
  "alternativeBaseFeeEuroPerYear",
  "demandChargeEuroPerKw",
  "alternativeDemandChargeEuroPerKw",
  "cmp0Name",
  "cmp0Price",
  "cmp0Escalation",
  "cmp0BaseFee",
  "cmp0Demand",
  "cmp1Name",
  "cmp1Price",
  "cmp1Escalation",
  "cmp1BaseFee",
  "cmp1Demand",
  "cmp2Name",
  "cmp2Price",
  "cmp2Escalation",
  "cmp2BaseFee",
  "cmp2Demand",
  "touImportPricesCt",
  "coolingKwhPerYear",
  "heatingAcKwhPerYear",
  "hotWaterKwhPerYear",
  "pvStatus",
  "pvPeakPowerKwp",
  "pvCommissioningYear",
  "storageStatus",
  "storageCapacityKwh",
  "wallboxStatus",
  "evStatus",
] as const;
const roofFieldSuffixes = [
  "id",
  "areaM2",
  "azimuthDeg",
  "tiltDeg",
  "type",
  "shading",
  "reviewed",
  "replaceDefault",
] as const;
const roomFieldSuffixes = ["name", "areaM2", "usage", "radiators"] as const;

type ParsedProfileForm = z.infer<typeof profileFormSchema> & {
  roofs: Array<z.infer<typeof roofFormSchema>>;
  rooms: Array<z.infer<typeof roomFormSchema>>;
};

function exactFormValue(formData: FormData, name: string): FormDataEntryValue | null {
  const values = formData.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function parseProfileForm(formData: FormData): ParsedProfileForm | null {
  const rawRoofCount = exactFormValue(formData, "roofCount");
  const parsedRoofCount = z.string().regex(/^[1-4]$/u).transform(Number).safeParse(
    rawRoofCount,
  );
  if (!parsedRoofCount.success) return null;
  const rawRoomCount = exactFormValue(formData, "roomCount");
  const parsedRoomCount = roomCountSchema.safeParse(rawRoomCount ?? "0");
  if (!parsedRoomCount.success) return null;

  const allowed = new Set<string>(baseProfileFields);
  for (let index = 0; index < parsedRoofCount.data; index += 1) {
    for (const suffix of roofFieldSuffixes) allowed.add(`roof.${index}.${suffix}`);
  }
  for (let index = 0; index < parsedRoomCount.data; index += 1) {
    for (const suffix of roomFieldSuffixes) allowed.add(`room.${index}.${suffix}`);
  }
  // F4.2: Custom-Felder nur bei Monatsprofil-Option (exakt, branchabhängig).
  const rawLoadProfile = exactFormValue(formData, "loadProfile");
  const monthlyBranch = rawLoadProfile === MONTHLY_LOAD_PROFILE_FORM_VALUE;
  if (monthlyBranch) {
    for (const name of customProfileFieldNames) allowed.add(name);
  }
  // F4.2c: CSV-Feld nur bei CSV-Option (exakt, branchabhängig).
  const csvBranch = rawLoadProfile === CSV_LOAD_PROFILE_FORM_VALUE;
  if (csvBranch) {
    allowed.add("loadProfileCsv");
  }
  // F1-19: property-Felder nur im property-Branch (exakt, branchabhängig).
  const rawInputMode = exactFormValue(formData, "inputMode");
  const propertyBranch = rawInputMode === "property";
  if (propertyBranch) {
    for (const name of propertyBranchFields) allowed.add(name);
  }
  // F1-19: optionale Felder (inputMode/roomCount/Paket-Matrix) sind
  // erlaubt, aber nicht Pflicht — alte Formulare bleiben gültig. Sie
  // laufen über eine eigene Allowlist; die Pflichtmenge bleibt exakt.
  const optionalAllowed = new Set<string>(optionalProfileFields);

  const seen = new Set<string>();
  const seenOptional = new Set<string>();
  for (const name of formData.keys()) {
    // Next/React ergänzt verschlüsselte Action-Metadaten. Sie sind keine
    // Fachfelder und werden nie an Parser oder Service weitergereicht.
    if (name.startsWith("$ACTION_")) continue;
    if (optionalAllowed.has(name)) {
      if (seenOptional.has(name)) return null;
      seenOptional.add(name);
      continue;
    }
    if (!allowed.has(name) || seen.has(name)) return null;
    seen.add(name);
  }
  if (seen.size !== allowed.size) return null;

  const rawBase = Object.fromEntries(
    [
      ...baseProfileFields,
      ...optionalProfileFields,
      ...(monthlyBranch ? customProfileFieldNames : []),
      ...(csvBranch ? ["loadProfileCsv"] : []),
      ...(propertyBranch ? [...propertyBranchFields] : []),
    ].map((name) => {
      const value = exactFormValue(formData, name);
      // Fehlende optionale Felder: undefined (Prefault-Defaults greifen).
      if (value === null && (optionalProfileFields as readonly string[]).includes(name)) {
        return [name, undefined];
      }
      return [name, value];
    }),
  );
  const parsedBase = profileFormSchema.safeParse(rawBase);
  if (
    !parsedBase.success
    || parsedBase.data.roofCount !== parsedRoofCount.data
    || parsedBase.data.roomCount !== parsedRoomCount.data
  ) return null;

  const roofs = [];
  for (let index = 0; index < parsedRoofCount.data; index += 1) {
    const rawRoof = Object.fromEntries(
      roofFieldSuffixes.map((suffix) => [
        suffix,
        exactFormValue(formData, `roof.${index}.${suffix}`),
      ]),
    );
    const parsedRoof = roofFormSchema.safeParse(rawRoof);
    if (!parsedRoof.success) return null;
    roofs.push(parsedRoof.data);
  }
  const rooms = [];
  for (let index = 0; index < parsedRoomCount.data; index += 1) {
    const rawRoom = Object.fromEntries(
      roomFieldSuffixes.map((suffix) => [
        suffix,
        exactFormValue(formData, `room.${index}.${suffix}`),
      ]),
    );
    const parsedRoom = roomFormSchema.safeParse(rawRoom);
    if (!parsedRoom.success) return null;
    rooms.push(parsedRoom.data);
  }
  return { ...parsedBase.data, roofs, rooms };
}

const confirmFormFields = new Set([
  "workspaceId",
  "projectId",
  "expectedAddressRevision",
  "expectedProfileRevision",
]);
const confirmFormSchema = z.strictObject({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  expectedAddressRevision: positiveRevision,
  expectedProfileRevision: positiveRevision,
});

function parseConfirmForm(formData: FormData): z.infer<typeof confirmFormSchema> | null {
  const seen = new Set<string>();
  for (const name of formData.keys()) {
    if (name.startsWith("$ACTION_")) continue;
    if (!confirmFormFields.has(name) || seen.has(name)) return null;
    seen.add(name);
  }
  if (seen.size !== confirmFormFields.size) return null;
  const parsed = confirmFormSchema.safeParse({
    workspaceId: exactFormValue(formData, "workspaceId"),
    projectId: exactFormValue(formData, "projectId"),
    expectedAddressRevision: exactFormValue(formData, "expectedAddressRevision"),
    expectedProfileRevision: exactFormValue(formData, "expectedProfileRevision"),
  });
  return parsed.success ? parsed.data : null;
}

// F4.2c: CSV-Textfeld -> kWh-Reihe (8760/35040) oder null (leer).
// Ungueltig -> Formfehler, kein Speichern (fail-closed). Dezimalpunkt
// oder -komma; Tausendertrennzeichen verboten (kein Raten).
function csvValueListField() {
  return z.string().max(1_000_000).refine((value) => value === value.trim()).transform((value, ctx) => {
    if (value === "") return null;
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
    if (lines.length !== 8_760 && lines.length !== 35_040) {
      ctx.addIssue({ code: "custom", message: "csv needs 8760 or 35040 lines" });
      return z.NEVER;
    }
    const numbers: number[] = [];
    for (const line of lines) {
      const normalized = line.includes(",") && !line.includes(".")
        ? line.replace(",", ".")
        : line;
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(normalized)) {
        ctx.addIssue({ code: "custom", message: "csv line is not a number" });
        return z.NEVER;
      }
      const number = Number(normalized);
      if (!Number.isFinite(number) || number < 0 || number > 1_000_000) {
        ctx.addIssue({ code: "custom", message: "csv value out of range 0..1000000" });
        return z.NEVER;
      }
      numbers.push(number);
    }
    return numbers;
  });
}

// F4.4b: TOU-Textfeld -> 24 Preise (0..200 Ct/kWh) oder null (leer).
// Ungueltig -> Formfehler, kein Speichern (fail-closed).
function touPriceListField() {
  return z.string().max(1000).refine((value) => value === value.trim()).transform((value, ctx) => {
    if (value === "") return null;
    const parts = value.split(",").map((part) => part.trim());
    if (parts.length !== 24 || parts.some((part) => !DECIMAL_PATTERN.test(part))) {
      ctx.addIssue({ code: "custom", message: "tou needs 24 comma-separated prices" });
      return z.NEVER;
    }
    const numbers = parts.map(Number);
    if (numbers.some((price) => !Number.isFinite(price) || price < 0 || price > 200)) {
      ctx.addIssue({ code: "custom", message: "tou prices out of range 0..200" });
      return z.NEVER;
    }
    return numbers;
  });
}

function knownOrUnknown<T>(value: T | null):
  | { status: "known"; value: T; source: "operator_reviewed" }
  | { status: "unknown"; value: null; source: "not_collected" } {
  return value === null
    ? { status: "unknown", value: null, source: "not_collected" }
    : { status: "known", value, source: "operator_reviewed" };
}

function simpleAsset(status: "unknown" | "known_absent" | "known_present"):
  EnergyProfile["existingAssets"]["wallbox"] {
  return status === "unknown"
    ? { status: "unknown", source: "not_collected" }
    : { status, source: "operator_reviewed" };
}

function replacementRoofId(addressRevision: number, index: number): string {
  return `manual-roof-a${addressRevision}-r${index + 1}`;
}

// F4.2: Monats-/Tageswerte aus dem Formular (Refine garantiert
// Vollständigkeit je Branch); null ohne Monats-Option.
function customLoadProfileFromForm(input: ParsedProfileForm): {
  monthlyKwh: number[];
  weekdayHourlyKwh: number[] | null;
  weekendHourlyKwh: number[] | null;
} | null {
  if (input.loadProfile !== MONTHLY_LOAD_PROFILE_FORM_VALUE) return null;
  const record = input as unknown as Record<string, number | null | undefined>;
  const monthlyKwh = customMonthlyFieldNames.map((name) => record[name] ?? null);
  if (monthlyKwh.some((kwh) => kwh === null)) return null;
  const day = (names: string[]): number[] | null => {
    const values = names.map((name) => record[name] ?? null);
    if (values.every((kwh) => kwh === null)) return null;
    if (values.some((kwh) => kwh === null)) return null;
    return values as number[];
  };
  return {
    monthlyKwh: monthlyKwh as number[],
    weekdayHourlyKwh: day(customWeekdayFieldNames),
    weekendHourlyKwh: day(customWeekendFieldNames),
  };
}

// F4-04f: Vergleichstarife aus drei Formulargruppen (je Gruppe Name +
// Preis Pflicht, Rest optional mit Current-Fallback in der Engine).
// Leere Gruppe = kein Tarif; Teilgruppe oder Doppelname = null
// (fail-closed, kein stilles Ergänzen).
function comparisonTariffsFromForm(input: ParsedProfileForm): Array<{
  name: string;
  importPriceCtPerKwh: number;
  priceEscalationPct?: number;
  baseFeeEuroPerYear?: number;
  demandChargeEuroPerKw?: number;
}> | null {
  const record = input as unknown as Record<string, string | number | null | undefined>;
  const tariffs: Array<{
    name: string;
    importPriceCtPerKwh: number;
    priceEscalationPct?: number;
    baseFeeEuroPerYear?: number;
    demandChargeEuroPerKw?: number;
  }> = [];
  const seen = new Set<string>();
  for (const prefix of ["cmp0", "cmp1", "cmp2"] as const) {
    const rawName = record[`${prefix}Name`];
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const price = record[`${prefix}Price`] ?? null;
    const escalation = record[`${prefix}Escalation`] ?? null;
    const baseFee = record[`${prefix}BaseFee`] ?? null;
    const demand = record[`${prefix}Demand`] ?? null;
    const anySet = name !== "" || price !== null || escalation !== null || baseFee !== null || demand !== null;
    if (!anySet) continue;
    if (name === "" || typeof price !== "number") return null;
    if (seen.has(name)) return null;
    seen.add(name);
    tariffs.push({
      name,
      importPriceCtPerKwh: price,
      ...(typeof escalation === "number" ? { priceEscalationPct: escalation } : {}),
      ...(typeof baseFee === "number" ? { baseFeeEuroPerYear: baseFee } : {}),
      ...(typeof demand === "number" ? { demandChargeEuroPerKw: demand } : {}),
    });
  }
  return tariffs;
}

function buildSubmittedProfile(
  candidate: ProjectEnergyProfileCandidate,
  input: ParsedProfileForm,
): { profile: EnergyProfile; roofAcknowledgements: string[] } | null {
  const profile = structuredClone(candidate.profile);
  // F4-04f: Teilgruppe/Doppelname verweigert den Save (fail-closed).
  const comparisonTariffs = comparisonTariffsFromForm(input);
  if (comparisonTariffs === null) return null;
  const comparisonTariffsOrAbort = comparisonTariffs.length === 0 ? null : comparisonTariffs;
  // F1-19 Modus: Refine garantiert Modus-Sektionen (Vollstaendigkeit je
  // Branch); fremde Sektionen werden explizit entfernt, nie mitgeschleppt.
  profile.inputMode = input.inputMode;
  delete profile.propertyEstimate;
  delete profile.rooms;
  if (input.inputMode === "property") {
    const heatingType = input.heatingType ?? null;
    const residentCount = input.residentCount ?? null;
    if (heatingType === null || residentCount === null) return null;
    profile.propertyEstimate = { heatingType, residentCount };
  } else if (input.inputMode === "roomwise") {
    if (input.rooms.length < 1) return null;
    profile.rooms = input.rooms.map((room) => ({
      name: room.name,
      areaM2: room.areaM2,
      usage: room.usage,
      radiatorCount: room.radiators,
    }));
  }
  profile.provenance = {
    ...profile.provenance,
    source: input.inputMode === "manual" ? "operator_manual" : "rechner_snapshot",
  };
  profile.building = {
    type: knownOrUnknown(input.buildingType),
    year: knownOrUnknown(input.buildingYear),
    heatedAreaM2: knownOrUnknown(input.heatedAreaM2),
  } as EnergyProfile["building"];
  profile.consumption = {
    householdKwhPerYear: knownOrUnknown(input.householdKwhPerYear),
    electricityPriceCentsPerKwh: knownOrUnknown(input.electricityPriceCentsPerKwh),
    annualPriceIncreasePercent: knownOrUnknown(input.annualPriceIncreasePercent),
    loadProfile: knownOrUnknown(input.loadProfile),
    evKmPerYear: knownOrUnknown(input.evKmPerYear),
    evChargingPattern: knownOrUnknown(input.evChargingPattern),
    heatPumpKwhPerYear: knownOrUnknown(input.heatPumpKwhPerYear),
    heatPumpThermalKwhPerYear: knownOrUnknown(input.heatPumpThermalKwhPerYear ?? null),
    heatPumpCopNominal: knownOrUnknown(input.heatPumpCopNominal ?? null),
    heatPumpBivalenceTempC: knownOrUnknown(input.heatPumpBivalenceTempC ?? null),
    heatPumpHotWaterShare: knownOrUnknown(input.heatPumpHotWaterShare ?? null),
    investmentEuro: knownOrUnknown(input.investmentEuro ?? null),
    feedInTariffCtPerKwh: knownOrUnknown(input.feedInTariffCtPerKwh ?? null),
    feedInCommissioningYear: knownOrUnknown(input.feedInCommissioningYear ?? null),
    groundAlbedo: knownOrUnknown(input.groundAlbedo ?? null),
    alternativeImportPriceCtPerKwh: knownOrUnknown(input.alternativeImportPriceCtPerKwh ?? null),
    alternativeImportPriceEscalationPct: knownOrUnknown(
      input.alternativeImportPriceEscalationPct ?? null,
    ),
    baseFeeEuroPerYear: knownOrUnknown(input.baseFeeEuroPerYear ?? null),
    alternativeBaseFeeEuroPerYear: knownOrUnknown(
      input.alternativeBaseFeeEuroPerYear ?? null,
    ),
    demandChargeEuroPerKw: knownOrUnknown(input.demandChargeEuroPerKw ?? null),
    alternativeDemandChargeEuroPerKw: knownOrUnknown(
      input.alternativeDemandChargeEuroPerKw ?? null,
    ),
    comparisonTariffs: knownOrUnknown(comparisonTariffsOrAbort),
    touImportPricesCtPerKwh: knownOrUnknown(input.touImportPricesCt ?? null),
    coolingKwhPerYear: knownOrUnknown(input.coolingKwhPerYear),
    heatingAcKwhPerYear: knownOrUnknown(input.heatingAcKwhPerYear),
    hotWaterKwhPerYear: knownOrUnknown(input.hotWaterKwhPerYear),
    customLoadProfile: knownOrUnknown(customLoadProfileFromForm(input)),
    customCsvKwh: knownOrUnknown(
      (input as unknown as Record<string, number[] | null | undefined>).loadProfileCsv ?? null,
    ),
  } as EnergyProfile["consumption"];

  if (
    input.pvStatus === "known_present"
    && input.pvPeakPowerKwp !== null
    && input.pvCommissioningYear !== null
  ) {
    profile.existingAssets.pv = {
      status: "known_present",
      source: "operator_reviewed",
      peakPowerKwp: input.pvPeakPowerKwp,
      commissioningYear: input.pvCommissioningYear,
    };
  } else if (input.pvStatus === "known_absent") {
    profile.existingAssets.pv = {
      status: "known_absent",
      source: "operator_reviewed",
    };
  } else if (input.pvStatus === "unknown") {
    profile.existingAssets.pv = { status: "unknown", source: "not_collected" };
  } else {
    return null;
  }

  if (input.storageStatus === "known_present" && input.storageCapacityKwh !== null) {
    profile.existingAssets.storage = {
      status: "known_present",
      source: "operator_reviewed",
      capacityKwh: input.storageCapacityKwh,
    };
  } else if (input.storageStatus === "known_absent") {
    profile.existingAssets.storage = {
      status: "known_absent",
      source: "operator_reviewed",
    };
  } else if (input.storageStatus === "unknown") {
    profile.existingAssets.storage = { status: "unknown", source: "not_collected" };
  } else {
    return null;
  }
  profile.existingAssets.wallbox = simpleAsset(input.wallboxStatus);
  profile.existingAssets.ev = simpleAsset(input.evStatus);

  const candidateRoofs = new Map(candidate.profile.roofs.map((roof) => [roof.id, roof]));
  const acknowledgements: string[] = [];
  const builtRoofs: EnergyProfile["roofs"] = [];
  for (const [index, roof] of input.roofs.entries()) {
    const candidateRoof = candidateRoofs.get(roof.id);
    if (roof.replaceDefault && candidateRoof?.source !== "default") return null;
    const id = roof.replaceDefault
      ? replacementRoofId(input.expectedAddressRevision, index)
      : roof.id;
    if (roof.reviewed) acknowledgements.push(id);
    const builtRoof: EnergyProfile["roofs"][number] = {
      id,
      areaM2: roof.areaM2,
      azimuthDeg: roof.azimuthDeg,
      tiltDeg: roof.tiltDeg,
      type: roof.type,
      shading: roof.shading === null
        ? { status: "unknown" as const, value: null, source: "not_collected" as const }
        : {
            status: "known" as const,
            value: roof.shading as "none" | "light" | "medium" | "strong",
            source: "operator_reviewed" as const,
          },
      source: candidateRoof?.source ?? "operator_reviewed" as const,
    };
    builtRoofs.push(builtRoof);
  }
  profile.roofs = builtRoofs;
  const uniqueIds = new Set(profile.roofs.map((roof) => roof.id));
  if (uniqueIds.size !== profile.roofs.length) return null;

  return { profile, roofAcknowledgements: acknowledgements };
}

function revalidateEnergyPaths(workspaceId: string, projectId: string): void {
  const projectPath = `/w/${workspaceId}/anfragen/${projectId}`;
  revalidatePath(projectPath);
  revalidatePath(`${projectPath}/energieprofil`);
}

// F1-19 Zielpakete: Der Editor traegt "leer = unveraendert"; der Merge
// laeuft gegen die juengste Anforderungsrevision und schreibt bei
// Aenderung eine neue Revision (requestedProducts unangetastet, nur
// requestedPackages ersetzt). Neue Revision = neue Bindung, d. h. die
// Planungsrechnung wird stale und laesst sich erneut bestaetigen.
class PackagesUnsupportedError extends Error {}

function packageDeltaFromForm(input: ParsedProfileForm): PackageFormDelta {
  return {
    solar: { wanted: input.pkgSolarWanted, paymentKind: input.pkgSolarPayment as PackagePaymentKind | null },
    storage: { wanted: input.pkgStorageWanted, paymentKind: input.pkgStoragePayment as PackagePaymentKind | null },
    wallbox: { wanted: input.pkgWallboxWanted, paymentKind: input.pkgWallboxPayment as PackagePaymentKind | null },
    heating: { wanted: input.pkgHeatingWanted, paymentKind: input.pkgHeatingPayment as PackagePaymentKind | null },
  };
}

function packagesUpdatePlan(
  latest: LatestProjectRequirement | null,
  delta: PackageFormDelta,
): { changed: false } | { changed: true; requirements: unknown } {
  const touched = requestedPackageKeys.some(
    (key) => delta[key].wanted !== null || delta[key].paymentKind !== null,
  );
  if (latest === null) {
    if (!touched) return { changed: false };
    throw new PackagesUnsupportedError();
  }
  const parsed = ProjectRequirementsRechnerV1Schema.safeParse(latest.requirements);
  if (!parsed.success) throw new EnergyProfileInvalidError();
  const merged = mergeRequestedPackages(parsed.data.requestedPackages, delta);
  if (merged === null) throw new EnergyProfileInvalidError();
  const before: RequestedPackages = parsed.data.requestedPackages ?? REQUESTED_PACKAGES_UNSET;
  if (canonicalizeCalculationJson(before) === canonicalizeCalculationJson(merged)) {
    return { changed: false };
  }
  return { changed: true, requirements: { ...parsed.data, requestedPackages: merged } };
}

function saveKnownError(error: unknown): SharedEnergyActionErrorState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof EnergyProfileConflictError) return { status: "stale" };
  if (error instanceof EnergyProfileRoofAcknowledgementError) {
    return { status: "roof_review_required" };
  }
  if (error instanceof EnergyProfilePrerequisitesError && error.reason === "address_pin") {
    return { status: "address_not_ready" };
  }
  if (error instanceof EnergyProfileNotFoundError) return { status: "profile_missing" };
  if (error instanceof EnergyProfileUnsupportedSourceError) {
    return { status: "unsupported_source" };
  }
  if (error instanceof EnergyProfileInvalidError) return { status: "invalid" };
  return null;
}

function confirmKnownError(error: unknown): ConfirmProjectEnergyProfileState | null {
  const common = saveKnownError(error);
  if (common !== null) return common;
  if (error instanceof EnergyProfileRateLimitError) {
    return {
      status: "rate_limited",
      retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterSeconds)),
    };
  }
  if (error instanceof EnergyProfilePrerequisitesError) {
    return { status: "prerequisites_missing" };
  }
  if (error instanceof EnergyProfileRetryConflictError) {
    return { status: "retry_conflict" };
  }
  return null;
}

export async function saveProjectEnergyProfileAction(
  _previousState: SaveProjectEnergyProfileState,
  formData: FormData,
): Promise<SaveProjectEnergyProfileState> {
  const input = parseProfileForm(formData);
  if (input === null) return { status: "invalid" };

  let candidate: ProjectEnergyProfileCandidate | null;
  try {
    candidate = await authorizedQuery(
      input.workspaceId,
      "project.write",
      "energy_profile",
      (tx, ctx) => getProjectEnergyProfileCandidate(tx, ctx, input.projectId),
    );
  } catch (error) {
    const known = saveKnownError(error);
    if (known !== null) return known;
    throw error;
  }
  if (candidate === null) return { status: "profile_missing" };
  if (
    candidate.addressRevision !== input.expectedAddressRevision
    || candidate.expectedLatestRevision !== input.expectedLatestRevision
  ) return { status: "stale" };

  const submitted = buildSubmittedProfile(candidate, input);
  if (submitted === null) return { status: "invalid" };
  const packageDelta = packageDeltaFromForm(input);

  try {
    const result = await authorizedAction(
      input.workspaceId,
      "project.write",
      "energy_profile",
      async (tx, ctx) => {
        const saved = await saveProjectEnergyProfile(tx, ctx, {
          projectId: input.projectId,
          expectedAddressRevision: input.expectedAddressRevision,
          expectedLatestRevision: input.expectedLatestRevision,
          profile: submitted.profile,
          roofAcknowledgements: submitted.roofAcknowledgements,
        });
        // F1-19: Pakete in derselben Transaktion (Projekt-Lock zuerst,
        // dann Anforderungs-Sperre — keine partielle Speicherung). Ohne
        // gesetzte Paketfelder kein Anforderungs-Zugriff: alte Formulare
        // und reine Profil-Saves bleiben reine Profil-Saves.
        const touched = requestedPackageKeys.some(
          (key) => packageDelta[key].wanted !== null || packageDelta[key].paymentKind !== null,
        );
        if (touched) {
          const latest = await readLatestProjectRequirement(tx, input.workspaceId, input.projectId);
          const plan = packagesUpdatePlan(latest, packageDelta);
          // changed=true impliziert latest!=null (Plan wirft sonst); die
          // Wache ist nur Typverengung, kein fachlicher Zweig.
          if (plan.changed && latest !== null) {
            await tx.execute(sql`
              insert into project_requirement (
                id, workspace_id, project_id, revision, schema_version,
                source_snapshot_id, requirements
              ) values (
                ${randomUUID()}::uuid, ${input.workspaceId}::uuid,
                ${input.projectId}::uuid, ${latest.revision + 1},
                ${latest.schemaVersion},
                ${latest.sourceSnapshotId}::uuid,
                ${JSON.stringify(plan.requirements)}::jsonb
              )
            `);
          }
        }
        return saved;
      },
    );
    revalidateEnergyPaths(input.workspaceId, input.projectId);
    return {
      status: "success",
      revision: result.revision,
      changed: result.changed,
      confirmed: result.confirmed,
    };
  } catch (error) {
    if (error instanceof PackagesUnsupportedError) return { status: "packages_unsupported" };
    const known = saveKnownError(error);
    if (known !== null) return known;
    throw error;
  }
}

export async function confirmProjectEnergyProfileAction(
  _previousState: ConfirmProjectEnergyProfileState,
  formData: FormData,
): Promise<ConfirmProjectEnergyProfileState> {
  const input = parseConfirmForm(formData);
  if (input === null) return { status: "invalid" };

  try {
    const result = await authorizedAction(
      input.workspaceId,
      "project.write",
      "energy_profile",
      (tx, ctx) => confirmProjectEnergyProfile(tx, ctx, {
        projectId: input.projectId,
        expectedAddressRevision: input.expectedAddressRevision,
        expectedProfileRevision: input.expectedProfileRevision,
      }),
    );
    revalidateEnergyPaths(input.workspaceId, input.projectId);
    return { status: "success", jobId: result.jobId, replayed: result.replayed };
  } catch (error) {
    const known = confirmKnownError(error);
    if (known !== null) return known;
    throw error;
  }
}
