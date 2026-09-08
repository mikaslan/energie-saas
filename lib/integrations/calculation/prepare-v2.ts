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
import { QUARTER_HOUR_SLOTS } from "./engine-v2";
import { planningSourceSnapshotSchema } from "./preparation";
import {
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_DEFAULTS_VERSION,
} from "./versions-v2";

const finite = () => z.number().finite();

// Explizite Speicherparameter des Claims (keine stillen Defaults).
// Als benannter Export, damit die v2-Preparation dieselbe Form als
// eingefrorene Reservierungs-Provenienz tragen kann.
export const claimStorageV2Schema = z.strictObject({
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
);

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
  storage: claimStorageV2Schema,
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

export type PlanningCalculationProviderRequestV2 = {
  latitude: number;
  longitude: number;
  roofs: Array<{
    roofId: string;
    tiltDeg: number;
    azimuthDeg: number;
    areaM2: number;
  }>;
  consumption: unknown;
};

export type PlanningCalculationProviderSeriesV2 = {
  pvKwh: number[];
  loadKwh: number[];
  providerEstimate: boolean;
};

export type PreparedPlanningCalculationPersistV2 = {
  inputSha256: string;
  inputSnapshot: PlanningCalculationRequestV2;
  pvKwh: number[];
  loadKwh: number[];
  providerEstimate: boolean;
};

// Worker-Claim-Sicht (Spec F4-01): Der Execute-Handler uebergibt den Claim
// so, wie ihn claimProjectCalculationJob liefert. Ungepruefte Fremdschluessel
// (Pins, Lease) werden gestrippt; benoetigt werden nur Bindungen, Start,
// Quell-Snapshot, v2-Provenienz und die daraus abgeleitete Provider-Anfrage.
// Ein fehlender/ungueltiger Teil (keine v2-Provenienz, kein Quell-Snapshot,
// keine Serien) ist engine_invalid, nie ein stiller Default.
const executeClaimV2Schema = z.object({
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
  providerRequestV2: z.strictObject({
    latitude: finite().min(-90).max(90),
    longitude: finite().min(-180).max(180),
    roofs: z.array(z.strictObject({
      roofId: z.string().trim().min(1).max(64),
      tiltDeg: finite().min(0).max(90),
      azimuthDeg: finite().min(-180).max(180),
      areaM2: finite().gt(0),
    })).min(1).max(4),
    consumption: z.unknown(),
  }),
  preparationV2: z.object({
    storage: claimStorageV2Schema,
    profile: siteEnergyProfileV1Schema,
    requirements: ProjectRequirementsRechnerV1Schema,
    sourceSnapshot: planningSourceSnapshotSchema,
  }),
});

const providerSeriesInputV2Schema = z.strictObject({
  pvKwh: z.array(z.number().finite().nonnegative()).length(QUARTER_HOUR_SLOTS),
  loadKwh: z.array(z.number().finite().nonnegative()).length(QUARTER_HOUR_SLOTS),
  providerEstimate: z.boolean(),
});

export function buildPlanningCalculationInputV2(input: {
  claim: unknown;
  providerSeries: unknown;
}): PreparedPlanningCalculationPersistV2 {
  const claim = executeClaimV2Schema.safeParse(input.claim);
  if (!claim.success) inputError(claim.error);
  const series = providerSeriesInputV2Schema.safeParse(input.providerSeries);
  if (!series.success) inputError(series.error);
  const value = claim.data!;
  const prepared = buildPreparedPlanningCalculationInputV2({
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    siteId: value.siteId,
    startedAt: value.startedAt,
    addressRevision: value.addressRevision,
    pinConfirmedAddressRevision: value.pinConfirmedAddressRevision,
    energyProfileId: value.energyProfileId,
    energyProfileRevision: value.energyProfileRevision,
    confirmedEnergyProfileRevision: value.confirmedEnergyProfileRevision,
    confirmedEnergyProfileAddressRevision: value.confirmedEnergyProfileAddressRevision,
    projectRequirementId: value.projectRequirementId,
    projectRequirementRevision: value.projectRequirementRevision,
    sourceCalculatorSnapshotId: value.sourceCalculatorSnapshotId,
    contractVersion: value.contractVersion,
    defaultsVersion: value.defaultsVersion,
    // Nur Geokoordinaten: Daecher/Verbrauch gehoeren dem Fetch, nicht dem
    // strikten Request-Claim (Extra-Keys wuerden fail-closed abweisen).
    providerRequest: {
      latitude: value.providerRequestV2.latitude,
      longitude: value.providerRequestV2.longitude,
    },
    storage: value.preparationV2.storage,
    preparation: {
      profile: value.preparationV2.profile,
      requirements: value.preparationV2.requirements,
      sourceSnapshot: value.preparationV2.sourceSnapshot,
    },
  });
  return {
    inputSha256: prepared.inputSha256,
    inputSnapshot: prepared.inputSnapshot,
    pvKwh: series.data!.pvKwh,
    loadKwh: series.data!.loadKwh,
    providerEstimate: series.data!.providerEstimate,
  };
}
