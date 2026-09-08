/**
 * F4.1 v2-Reservation (Spec F4-01): Idempotenzschluessel der v2-Jobs.
 * Gleiche Konstruktion wie v1 (`reservationHash` in
 * modules/energy/service.ts), aber exakt das v2-Tupel aus versions-v2.ts
 * (Reservation-/Contract-/Recipe-/Model-/Defaults-Pins plus v2-Schema-SHA).
 * Reine Funktion; die Transaktionshuelle (Rate-Limit, Confirm, Insert,
 * Dispatch) folgt im Service-Slice.
 */
import { createHash } from "node:crypto";

import {
  CALCULATION_CANONICALIZATION_VERSION,
  canonicalizeCalculationJson,
} from "./contract";
import {
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_DEFAULTS_VERSION,
  CALCULATION_V2_MODEL_ID,
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  CALCULATION_V2_RESERVATION_VERSION,
  CALCULATION_V2_SCHEMA_SHA256,
  CALCULATION_V2_SOURCE_REVISION,
} from "./versions-v2";

export type ReservationBindingsV2 = {
  workspaceId: string;
  projectId: string;
  siteId: string;
  addressRevision: number;
  profileId: string;
  profileRevision: number;
  requirementId: string;
  requirementRevision: number;
  sourceSnapshotId: string;
};

export type ReservationBatteryV2 = {
  componentId: string;
  revision: number;
} | null;

export function reservationHashV2(
  bindings: ReservationBindingsV2,
  battery: ReservationBatteryV2,
): Buffer {
  return createHash("sha256")
    .update(
      canonicalizeCalculationJson({
        reservationVersion: CALCULATION_V2_RESERVATION_VERSION,
        canonicalizationVersion: CALCULATION_CANONICALIZATION_VERSION,
        schemaSha256: CALCULATION_V2_SCHEMA_SHA256,
        // Die Batterie-Provenienz ist Teil des Schluessels: Aendert sich die
        // bestaetigte Batterie bei gleichen Bindungen, entsteht ein neuer Job
        // statt eines stillen Replays mit veraltetem Speicher.
        battery: battery === null ? null : {
          componentId: battery.componentId,
          revision: battery.revision,
        },
        bindings: {
          workspaceId: bindings.workspaceId,
          projectId: bindings.projectId,
          siteId: bindings.siteId,
          addressRevision: bindings.addressRevision,
          pinConfirmedAddressRevision: bindings.addressRevision,
          profileId: bindings.profileId,
          profileRevision: bindings.profileRevision,
          confirmedProfileRevision: bindings.profileRevision,
          confirmedAddressRevision: bindings.addressRevision,
          requirementId: bindings.requirementId,
          requirementRevision: bindings.requirementRevision,
          sourceSnapshotId: bindings.sourceSnapshotId,
        },
        providerRecipeVersion: CALCULATION_V2_PROVIDER_RECIPE_VERSION,
        contractVersion: CALCULATION_V2_CONTRACT_VERSION,
        modelId: CALCULATION_V2_MODEL_ID,
        modelVersion: CALCULATION_V2_MODEL_VERSION,
        sourceRevision: CALCULATION_V2_SOURCE_REVISION,
        defaultsVersion: CALCULATION_V2_DEFAULTS_VERSION,
      }),
      "utf8",
    )
    .digest();
}
