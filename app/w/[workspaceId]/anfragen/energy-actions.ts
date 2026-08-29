"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  authorizedAction,
  authorizedQuery,
  NotAuthenticatedError,
} from "@/lib/action";
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
  saveProjectEnergyProfile,
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
  | { status: "unsupported_source" };

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

const profileFormSchema = z.strictObject({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  expectedAddressRevision: positiveRevision,
  expectedLatestRevision: nonNegativeRevision,
  roofCount: z.string().regex(/^[1-4]$/u).transform(Number),
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
  ]),
  evKmPerYear: optionalNumber(0, 200_000),
  evChargingPattern: optionalEnum(["evening", "daytime", "away"]),
  heatPumpKwhPerYear: optionalNumber(0, 100_000),
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

type ParsedProfileForm = z.infer<typeof profileFormSchema> & {
  roofs: Array<z.infer<typeof roofFormSchema>>;
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

  const allowed = new Set<string>(baseProfileFields);
  for (let index = 0; index < parsedRoofCount.data; index += 1) {
    for (const suffix of roofFieldSuffixes) allowed.add(`roof.${index}.${suffix}`);
  }

  const seen = new Set<string>();
  for (const name of formData.keys()) {
    // Next/React ergänzt verschlüsselte Action-Metadaten. Sie sind keine
    // Fachfelder und werden nie an Parser oder Service weitergereicht.
    if (name.startsWith("$ACTION_")) continue;
    if (!allowed.has(name) || seen.has(name)) return null;
    seen.add(name);
  }
  if (seen.size !== allowed.size) return null;

  const rawBase = Object.fromEntries(
    baseProfileFields.map((name) => [name, exactFormValue(formData, name)]),
  );
  const parsedBase = profileFormSchema.safeParse(rawBase);
  if (!parsedBase.success || parsedBase.data.roofCount !== parsedRoofCount.data) return null;

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
  return { ...parsedBase.data, roofs };
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

function buildSubmittedProfile(
  candidate: ProjectEnergyProfileCandidate,
  input: ParsedProfileForm,
): { profile: EnergyProfile; roofAcknowledgements: string[] } | null {
  const profile = structuredClone(candidate.profile);
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
    coolingKwhPerYear: knownOrUnknown(input.coolingKwhPerYear),
    heatingAcKwhPerYear: knownOrUnknown(input.heatingAcKwhPerYear),
    hotWaterKwhPerYear: knownOrUnknown(input.hotWaterKwhPerYear),
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

  try {
    const result = await authorizedAction(
      input.workspaceId,
      "project.write",
      "energy_profile",
      (tx, ctx) => saveProjectEnergyProfile(tx, ctx, {
        projectId: input.projectId,
        expectedAddressRevision: input.expectedAddressRevision,
        expectedLatestRevision: input.expectedLatestRevision,
        profile: submitted.profile,
        roofAcknowledgements: submitted.roofAcknowledgements,
      }),
    );
    revalidateEnergyPaths(input.workspaceId, input.projectId);
    return {
      status: "success",
      revision: result.revision,
      changed: result.changed,
      confirmed: result.confirmed,
    };
  } catch (error) {
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
