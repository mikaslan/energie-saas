import { createHash } from "node:crypto";
import { z } from "zod";

import {
  canonicalizeCalculationJson,
  ProjectRequirementsRechnerV1Schema,
  siteEnergyProfileV1Schema,
} from "./contract";

export const PROJECT_CALCULATION_PREPARATION_VERSION =
  "project-calculation-preparation.v1" as const;

const finite = () => z.number().finite();

export const planningSourceSnapshotSchema = z.object({
  schemaVersion: z.literal("wmee-solar-snapshot.v1"),
  branch: z.enum(["new_installation", "existing_installation"]),
  inputs: z.object({
    assumptions: z.object({
      systemLossPercent: finite().min(0).max(60).nullish(),
      storageRoundtripEfficiency: finite().min(0.01).max(1).nullish(),
      storageDepthOfDischarge: finite().min(0.01).max(1).nullish(),
      moduleDegradationPerYear: finite().min(0).max(0.2).nullish(),
      horizonYears: z.int().min(1).max(40).nullish(),
      plannedCommissioningDate: z.iso.date().nullish(),
    }).optional(),
  }),
});

export const projectCalculationPreparationV1Schema = z.strictObject({
  schemaVersion: z.literal(PROJECT_CALCULATION_PREPARATION_VERSION),
  latitude: finite().min(-90).max(90),
  longitude: finite().min(-180).max(180),
  profile: siteEnergyProfileV1Schema,
  requirements: ProjectRequirementsRechnerV1Schema,
  // Nur die fuer die Engine tatsaechlich benoetigte, explizit allowlistete
  // Rechner-Provenienz wird reserviert. Kundendaten oder spaeter mutierbare
  // Intake-Felder gelangen nicht in diesen internen Preparation-Snapshot.
  sourceSnapshot: planningSourceSnapshotSchema,
});

export type ProjectCalculationPreparationV1 = z.infer<
  typeof projectCalculationPreparationV1Schema
>;

export function buildProjectCalculationPreparation(input: {
  latitude: unknown;
  longitude: unknown;
  profile: unknown;
  requirements: unknown;
  sourceSnapshot: unknown;
}): ProjectCalculationPreparationV1 {
  return projectCalculationPreparationV1Schema.parse({
    schemaVersion: PROJECT_CALCULATION_PREPARATION_VERSION,
    ...input,
  });
}

export function hashProjectCalculationPreparation(
  value: ProjectCalculationPreparationV1,
): string {
  return createHash("sha256")
    .update(canonicalizeCalculationJson(value), "utf8")
    .digest("hex");
}
