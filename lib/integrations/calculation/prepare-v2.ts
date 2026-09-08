/**
 * F4.1 v2-Prepare (Spec F4-01): Claim -> PlanningCalculationRequestV2 mit
 * gepinnter Achse. Speicherparameter kommen explizit aus dem Claim (keine
 * stillen Defaults); die Ableitung aus Requirements gehoert zu einem
 * eigenen Slice. Additiv neben prepare.ts.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  canonicalizeCalculationJson,
  ProjectRequirementsRechnerV1Schema,
  siteEnergyProfileV1Schema,
} from "./contract";
import { planningCalculationRequestV2Schema, type PlanningCalculationRequestV2 } from "./contract-v2";
import { planningSourceSnapshotSchema } from "./preparation";
import {
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_DEFAULTS_VERSION,
} from "./versions-v2";

const finite = () => z.number().finite();

const claimSchema = z.strictObject({
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
  contractVersion: z.literal(CALCULATION_V2_CONTRACT_VERSION),
  defaultsVersion: z.literal(CALCULATION_V2_DEFAULTS_VERSION),
  // Optionales Inbetriebnahmedatum; fehlt es, gilt asOfDate (ESTIMATE,
  // bis die v2-Annahmenaufloesung Commissioning-Regeln traegt).
  commissioningDate: z.iso.date().optional(),
  providerRequest: z.strictObject({
    latitude: finite().min(-90).max(90),
    longitude: finite().min(-180).max(180),
  }),
  storage: z.strictObject({
    capacityKwh: finite().min(0).max(10_000),
    socMinKwh: finite().min(0).max(10_000),
    socMaxKwh: finite().min(0).max(10_000),
    chargeKw: finite().min(0).max(1_000),
    dischargeKw: finite().min(0).max(1_000),
    etaCharge: finite().gt(0).max(1),
    etaDischarge: finite().gt(0).max(1),
  }).refine(
    (storage) => storage.socMinKwh <= storage.socMaxKwh
      && storage.socMaxKwh <= storage.capacityKwh,
    { message: "socMinKwh <= socMaxKwh <= capacityKwh verletzt" },
  ),
  preparation: z.strictObject({
    profile: siteEnergyProfileV1Schema,
    requirements: ProjectRequirementsRechnerV1Schema,
    sourceSnapshot: planningSourceSnapshotSchema,
  }),
});

export type PlanningCalculationBuildClaimV2 = z.input<typeof claimSchema>;

export type PreparedPlanningCalculationInputV2 = {
  inputSha256: string;
  inputSnapshot: PlanningCalculationRequestV2;
};

export class PlanningCalculationInputError extends Error {
  readonly code = "engine_invalid" as const;

  constructor(readonly paths: string[] = []) {
    super("planning calculation v2 input is invalid");
  }
}

function inputError(error: z.ZodError): never {
  throw new PlanningCalculationInputError(
    [...new Set(error.issues.map((issue) =>
      issue.path.length === 0 ? "/" : `/${issue.path.map(String).join("/")}`))]
      .slice(0, 20),
  );
}

function utcDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PlanningCalculationInputError(["/startedAt"]);
  }
  return date.toISOString().slice(0, 10);
}

export function hashPlanningCalculationInputV2(snapshot: PlanningCalculationRequestV2): string {
  return createHash("sha256").update(canonicalizeCalculationJson(snapshot), "utf8").digest("hex");
}

export function buildPreparedPlanningCalculationInputV2(
  raw: unknown,
): PreparedPlanningCalculationInputV2 {
  const parsed = claimSchema.safeParse(raw);
  if (!parsed.success) inputError(parsed.error);
  const claim = parsed.data!;
  const asOfDate = utcDate(claim.startedAt);
  const snapshot = planningCalculationRequestV2Schema.safeParse({
    contractVersion: CALCULATION_V2_CONTRACT_VERSION,
    canonicalizationVersion: "planning-jcs.v1",
    branch: claim.preparation.requirements.branch,
    asOfDate,
    commissioningDate: claim.commissioningDate ?? asOfDate,
    bindings: {
      workspaceId: claim.workspaceId,
      projectId: claim.projectId,
      siteId: claim.siteId,
      addressRevision: claim.addressRevision,
      pinConfirmedAddressRevision: claim.pinConfirmedAddressRevision,
      energyProfileId: claim.energyProfileId,
      energyProfileRevision: claim.energyProfileRevision,
      confirmedEnergyProfileRevision: claim.confirmedEnergyProfileRevision,
      confirmedEnergyProfileAddressRevision: claim.confirmedEnergyProfileAddressRevision,
      projectRequirementId: claim.projectRequirementId,
      projectRequirementRevision: claim.projectRequirementRevision,
      sourceCalculatorSnapshotId: claim.sourceCalculatorSnapshotId,
    },
    site: {
      countryCode: "DE",
      latitude: claim.providerRequest.latitude,
      longitude: claim.providerRequest.longitude,
    },
    axis: { slots: 35_040, resolution: "quarter_hour" },
    storage: claim.storage,
  });
  if (!snapshot.success) inputError(snapshot.error);
  const inputSnapshot = snapshot.data!;
  return { inputSha256: hashPlanningCalculationInputV2(inputSnapshot), inputSnapshot };
}
