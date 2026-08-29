import { z } from "zod";

import {
  CALCULATION_CANONICALIZATION_VERSION,
  PLANNING_CALCULATION_CONTRACT_VERSION,
  ProjectRequirementsRechnerV1Schema,
  hashPlanningCalculationInput,
  siteEnergyProfileV1Schema,
  validatePlanningCalculationRequest,
  type PlanningCalculationRequestV1,
  type SiteEnergyProfileV1,
} from "./contract";
import { planningSourceSnapshotSchema } from "./preparation";
import { PLANNING_DEFAULTS_VERSION } from "./versions";

const planningDateSchema = z.iso.date();
const finite = () => z.number().finite();

type SourceAssumptions = NonNullable<
  z.infer<typeof planningSourceSnapshotSchema>["inputs"]["assumptions"]
>;

const claimSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  siteId: z.uuid(),
  startedAt: z.union([z.date(), z.iso.datetime({ offset: true })]),
  addressRevision: z.int().min(1),
  pinConfirmedAddressRevision: z.int().min(1),
  energyProfileId: z.uuid(),
  energyProfileRevision: z.int().min(1),
  confirmedEnergyProfileRevision: z.int().min(1),
  confirmedEnergyProfileAddressRevision: z.int().min(1),
  projectRequirementId: z.uuid(),
  projectRequirementRevision: z.int().min(1),
  sourceCalculatorSnapshotId: z.uuid(),
  contractVersion: z.literal(PLANNING_CALCULATION_CONTRACT_VERSION),
  defaultsVersion: z.literal(PLANNING_DEFAULTS_VERSION),
  providerRequest: z.object({
    latitude: finite().min(-90).max(90),
    longitude: finite().min(-180).max(180),
  }),
  preparation: z.object({
    profile: siteEnergyProfileV1Schema,
    requirements: ProjectRequirementsRechnerV1Schema,
    sourceSnapshot: planningSourceSnapshotSchema,
  }),
});

export type PlanningCalculationBuildClaim = z.input<typeof claimSchema>;

export type PreparedPlanningCalculationInput = {
  inputSha256: string;
  inputSnapshot: PlanningCalculationRequestV1;
  providerSnapshot: PlanningCalculationRequestV1["yieldSnapshots"];
};

export class PlanningCalculationInputError extends Error {
  readonly code = "engine_invalid" as const;

  constructor(readonly paths: string[] = []) {
    super("planning calculation input is invalid");
  }
}

const DEFAULTS = {
  loadProfile: "wmee_household_hourly.v1",
  evKmPerYear: 0,
  evChargingPattern: "evening",
  heatPumpKwhPerYear: 0,
  coolingKwhPerYear: 0,
  heatingAcKwhPerYear: 0,
  hotWaterKwhPerYear: 0,
  systemLossPercent: 14,
  storageRoundtripEfficiency: 0.92,
  storageDepthOfDischarge: 0.9,
  moduleDegradationPerYear: 0.005,
  horizonYears: 20,
} as const;

type Consumption = SiteEnergyProfileV1["consumption"];
type EffectiveConsumption = PlanningCalculationRequestV1["effectiveConsumption"];
type ResolvedAssumptions = PlanningCalculationRequestV1["resolvedAssumptions"];

function inputError(paths: string[] = []): never {
  throw new PlanningCalculationInputError(paths);
}

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) =>
    issue.path.length === 0 ? "/" : `/${issue.path.map(String).join("/")}`))]
    .slice(0, 20);
}

function utcDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) inputError();
  return date.toISOString().slice(0, 10);
}

function profileValue<T>(
  field: { status: "known"; value: T } | { status: "unknown"; value: null },
  profileField: string,
): { resolution: "profile_value"; value: T; profileField: string } | null {
  return field.status === "known"
    ? { resolution: "profile_value", value: field.value, profileField }
    : null;
}

function profileValueOrDefault<T>(
  field: { status: "known"; value: T } | { status: "unknown"; value: null },
  profileField: string,
  defaultKey: string,
  fallback: T,
) {
  return profileValue(field, profileField) ?? {
    resolution: "versioned_default" as const,
    value: fallback,
    defaultKey,
    defaultsVersion: PLANNING_DEFAULTS_VERSION,
  };
}

function resolveConsumption(consumption: Consumption): EffectiveConsumption {
  const household = profileValue(
    consumption.householdKwhPerYear,
    "/consumption/householdKwhPerYear",
  );
  if (household === null) inputError();

  return {
    householdKwhPerYear: household as EffectiveConsumption["householdKwhPerYear"],
    loadProfile: profileValueOrDefault(
      consumption.loadProfile,
      "/consumption/loadProfile",
      "loadProfile",
      DEFAULTS.loadProfile,
    ) as EffectiveConsumption["loadProfile"],
    evKmPerYear: profileValueOrDefault(
      consumption.evKmPerYear,
      "/consumption/evKmPerYear",
      "evKmPerYear",
      DEFAULTS.evKmPerYear,
    ) as EffectiveConsumption["evKmPerYear"],
    evChargingPattern: profileValueOrDefault(
      consumption.evChargingPattern,
      "/consumption/evChargingPattern",
      "evChargingPattern",
      DEFAULTS.evChargingPattern,
    ) as EffectiveConsumption["evChargingPattern"],
    heatPumpKwhPerYear: profileValueOrDefault(
      consumption.heatPumpKwhPerYear,
      "/consumption/heatPumpKwhPerYear",
      "heatPumpKwhPerYear",
      DEFAULTS.heatPumpKwhPerYear,
    ) as EffectiveConsumption["heatPumpKwhPerYear"],
    coolingKwhPerYear: profileValueOrDefault(
      consumption.coolingKwhPerYear,
      "/consumption/coolingKwhPerYear",
      "coolingKwhPerYear",
      DEFAULTS.coolingKwhPerYear,
    ) as EffectiveConsumption["coolingKwhPerYear"],
    heatingAcKwhPerYear: profileValueOrDefault(
      consumption.heatingAcKwhPerYear,
      "/consumption/heatingAcKwhPerYear",
      "heatingAcKwhPerYear",
      DEFAULTS.heatingAcKwhPerYear,
    ) as EffectiveConsumption["heatingAcKwhPerYear"],
    hotWaterKwhPerYear: profileValueOrDefault(
      consumption.hotWaterKwhPerYear,
      "/consumption/hotWaterKwhPerYear",
      "hotWaterKwhPerYear",
      DEFAULTS.hotWaterKwhPerYear,
    ) as EffectiveConsumption["hotWaterKwhPerYear"],
  };
}

function assumptionValue<T>(
  value: T | null | undefined,
  sourceField: string,
  defaultKey: string,
  fallback: T,
) {
  return value === null || value === undefined
    ? {
        resolution: "versioned_default" as const,
        value: fallback,
        defaultKey,
        defaultsVersion: PLANNING_DEFAULTS_VERSION,
      }
    : {
        resolution: "rechner_input" as const,
        value,
        source: "rechner_snapshot" as const,
        sourceField,
      };
}

function resolvedAssumptions(
  source: SourceAssumptions,
  defaultCommissioningDate: string,
): ResolvedAssumptions {
  return {
    systemLossPercent: assumptionValue(
      source.systemLossPercent,
      "/inputs/assumptions/systemLossPercent",
      "systemLossPercent",
      DEFAULTS.systemLossPercent,
    ),
    storageRoundtripEfficiency: assumptionValue(
      source.storageRoundtripEfficiency,
      "/inputs/assumptions/storageRoundtripEfficiency",
      "storageRoundtripEfficiency",
      DEFAULTS.storageRoundtripEfficiency,
    ),
    storageDepthOfDischarge: assumptionValue(
      source.storageDepthOfDischarge,
      "/inputs/assumptions/storageDepthOfDischarge",
      "storageDepthOfDischarge",
      DEFAULTS.storageDepthOfDischarge,
    ),
    moduleDegradationPerYear: assumptionValue(
      source.moduleDegradationPerYear,
      "/inputs/assumptions/moduleDegradationPerYear",
      "moduleDegradationPerYear",
      DEFAULTS.moduleDegradationPerYear,
    ),
    horizonYears: assumptionValue(
      source.horizonYears,
      "/inputs/assumptions/horizonYears",
      "horizonYears",
      DEFAULTS.horizonYears,
    ),
    commissioningDate: assumptionValue(
      source.plannedCommissioningDate,
      "/inputs/assumptions/plannedCommissioningDate",
      "commissioningDate",
      defaultCommissioningDate,
    ),
  } as ResolvedAssumptions;
}

export function buildPlanningCalculationInput(input: {
  claim: unknown;
  providerSnapshot: unknown;
  asOfDate?: string;
}): PreparedPlanningCalculationInput {
  const claim = claimSchema.safeParse(input.claim);
  const explicitAsOfDate = input.asOfDate === undefined
    ? null
    : planningDateSchema.safeParse(input.asOfDate);
  if (!claim.success) inputError(issuePaths(claim.error));
  if (explicitAsOfDate !== null && !explicitAsOfDate.success) {
    inputError(issuePaths(explicitAsOfDate.error));
  }

  const value = claim.data;
  const asOfDate = explicitAsOfDate?.data ?? utcDate(value.startedAt);
  const source = value.preparation.sourceSnapshot;
  if (source.branch !== value.preparation.requirements.branch) inputError();

  const assumptions = resolvedAssumptions(source.inputs.assumptions ?? {}, asOfDate);
  const commissioningDate = assumptions.commissioningDate.value;
  const providerSnapshots = Array.isArray(input.providerSnapshot)
    ? structuredClone(input.providerSnapshot)
    : inputError();
  const candidate = {
    contractVersion: PLANNING_CALCULATION_CONTRACT_VERSION,
    canonicalizationVersion: CALCULATION_CANONICALIZATION_VERSION,
    branch: value.preparation.requirements.branch,
    asOfDate,
    commissioningDate,
    bindings: {
      workspaceId: value.workspaceId,
      projectId: value.projectId,
      siteId: value.siteId,
      addressRevision: value.addressRevision,
      pinConfirmedAddressRevision: value.pinConfirmedAddressRevision,
      energyProfileId: value.energyProfileId,
      energyProfileRevision: value.energyProfileRevision,
      confirmedEnergyProfileRevision: value.confirmedEnergyProfileRevision,
      confirmedEnergyProfileAddressRevision: value.confirmedEnergyProfileAddressRevision,
      projectRequirementId: value.projectRequirementId,
      projectRequirementRevision: value.projectRequirementRevision,
      sourceCalculatorSnapshotId: value.sourceCalculatorSnapshotId,
    },
    site: {
      countryCode: "DE" as const,
      latitude: value.providerRequest.latitude,
      longitude: value.providerRequest.longitude,
    },
    energyProfile: structuredClone(value.preparation.profile),
    projectRequirements: structuredClone(value.preparation.requirements),
    effectiveConsumption: resolveConsumption(value.preparation.profile.consumption),
    effectiveStorageRequest: {
      resolution: "project_requirement" as const,
      valueKwh: value.preparation.requirements.requestedProducts.targetStorageKwh,
      requirementField: "/requestedProducts/targetStorageKwh" as const,
      meaning: value.preparation.requirements.branch === "new_installation"
        ? "planned_total_capacity" as const
        : "additional_capacity" as const,
    },
    resolvedAssumptions: assumptions,
    yieldSnapshots: providerSnapshots,
  };

  const validated = validatePlanningCalculationRequest(candidate);
  if (!validated.ok) inputError(validated.paths);
  const inputSnapshot = validated.value;
  return {
    inputSha256: hashPlanningCalculationInput(inputSnapshot),
    inputSnapshot,
    providerSnapshot: structuredClone(inputSnapshot.yieldSnapshots),
  };
}
