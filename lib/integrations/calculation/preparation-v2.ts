/**
 * F4.1 v2-Preparation (Spec F4-01): interner Job-Eingabesnapshot fuer
 * planning-calculation.v2. Additiv neben preparation.ts; v1 bleibt
 * unberuehrt. Hash ueber dieselbe Kanonisierung wie v1.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  canonicalizeCalculationJson,
  ProjectRequirementsRechnerV1Schema,
  siteEnergyProfileV1Schema,
} from "./contract";
import {
  CALCULATION_V2_AXIS_VERSION,
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
} from "./versions-v2";
import { planningSourceSnapshotSchema } from "./preparation";
import { claimStorageV2Schema } from "./prepare-v2";

export const PROJECT_CALCULATION_PREPARATION_V2_VERSION =
  "project-calculation-preparation.v2" as const;

const finite = () => z.number().finite();

const geometrySurfaceV2Schema = z.strictObject({
  tiltDeg: finite().min(0).max(90),
  azimuthDeg: finite().min(0).max(360),
});

export const projectCalculationPreparationV2Schema = z.strictObject({
  schemaVersion: z.literal(PROJECT_CALCULATION_PREPARATION_V2_VERSION),
  latitude: finite().min(-90).max(90),
  longitude: finite().min(-180).max(180),
  axis: z.strictObject({
    slots: z.literal(35_040),
    resolution: z.literal("quarter_hour"),
    version: z.literal(CALCULATION_V2_AXIS_VERSION).default(CALCULATION_V2_AXIS_VERSION),
  }),
  providerRecipe: z.literal(CALCULATION_V2_PROVIDER_RECIPE_VERSION),
  geometry: z.strictObject({
    surfaces: z.array(geometrySurfaceV2Schema).min(1).max(8),
  }),
  profile: siteEnergyProfileV1Schema,
  requirements: ProjectRequirementsRechnerV1Schema,
  sourceSnapshot: planningSourceSnapshotSchema,
  // Eingefrorene Speicher-Provenienz der Reservierung (aus der
  // bestaetigten Batterie-Revision aufgeloest, kein Default): Der Worker
  // baut daraus den Claim, ohne den Katalog erneut zu lesen.
  storage: claimStorageV2Schema,
});

export type ProjectCalculationPreparationV2 = z.infer<
  typeof projectCalculationPreparationV2Schema
>;

export function buildProjectCalculationPreparationV2(input: unknown): ProjectCalculationPreparationV2 {
  const parsed = projectCalculationPreparationV2Schema.parse(input);
  return {
    ...parsed,
    axis: {
      slots: 35_040,
      resolution: "quarter_hour",
      version: CALCULATION_V2_AXIS_VERSION,
    },
  };
}

export function hashProjectCalculationPreparationV2(
  value: ProjectCalculationPreparationV2,
): string {
  return createHash("sha256")
    .update(canonicalizeCalculationJson(value), "utf8")
    .digest("hex");
}
