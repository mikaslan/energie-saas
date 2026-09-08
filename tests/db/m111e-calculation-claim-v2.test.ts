import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import {
  PLANNING_CALCULATION_CONTRACT_VERSION,
  type PlanningCalculationRequestV1,
} from "@/lib/integrations/calculation/contract";
import {
  buildProjectCalculationPreparation,
  hashProjectCalculationPreparation,
  type ProjectCalculationPreparationV1,
} from "@/lib/integrations/calculation/preparation";
import {
  buildProjectCalculationPreparationV2,
  hashProjectCalculationPreparationV2,
  type ProjectCalculationPreparationV2,
} from "@/lib/integrations/calculation/preparation-v2";
import {
  PLANNING_DEFAULTS_VERSION,
  PLANNING_MODEL_ID,
  PLANNING_MODEL_SOURCE_REVISION,
  PLANNING_MODEL_VERSION,
  PLANNING_PROVIDER_RECIPE_VERSION,
} from "@/lib/integrations/calculation/versions";
import {
  CALCULATION_V2_AXIS_VERSION,
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_DEFAULTS_VERSION,
  CALCULATION_V2_MODEL_ID,
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
} from "@/lib/integrations/calculation/versions-v2";
import {
  claimProjectCalculationJob,
  type ProjectCalculationClaim,
} from "@/modules/energy/calculation-service";
import { testPool } from "../setup/test-db";

// F4.1 v2-Claim-Sicht (calculation-service claimResult): v2-Zeilen liefern
// die hash-gepruefte Reservierungs-Provenienz als preparationV2 plus die
// daraus abgeleitete Provider-Anfrage; v1-Zeilen liefern dort
// grundsaetzlich null (Versionsreinheit, keine stillen Defaults).

const NOW = new Date("2026-08-29T12:00:00.000Z");

const GOLDEN_REQUEST = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/planning-calculation.v1.new.request.json"),
  "utf8",
)) as PlanningCalculationRequestV1;

const REQUIREMENTS = {
  schemaVersion: "project-requirements.rechner.v1",
  source: "wmee-rechner-v3",
  branch: "new_installation",
  requestedProducts: {
    targetStorageKwh: 8,
    wallbox: false,
    bidirectionalCharging: false,
    backupPower: false,
  },
};

const SOURCE_SNAPSHOT = {
  schemaVersion: "wmee-solar-snapshot.v1",
  branch: "new_installation",
  inputs: {},
};

const NO_STORAGE = {
  capacityKwh: 0,
  socMinKwh: 0,
  socMaxKwh: 0,
  chargeKw: 0,
  dischargeKw: 0,
  etaCharge: 1,
  etaDischarge: 1,
};

function sha256Bytes(value: unknown): Buffer {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest();
}

type FixtureIds = {
  workspaceId: string;
  actorId: string;
  contactId: string;
  siteId: string;
  projectId: string;
  siteIdV1: string;
  projectIdV1: string;
  receiptId: string;
  snapshotId: string;
  receiptIdV1: string;
  snapshotIdV1: string;
  requirementId: string;
  requirementIdV1: string;
  profileId: string;
  profileIdV1: string;
  jobV1Id: string;
  jobV2Id: string;
  preparationV2: ProjectCalculationPreparationV2;
  preparationV1: ProjectCalculationPreparationV1;
};

async function createFixture(): Promise<FixtureIds> {
  const ids = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    siteIdV1: randomUUID(),
    projectIdV1: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    receiptIdV1: randomUUID(),
    snapshotIdV1: randomUUID(),
    requirementId: randomUUID(),
    requirementIdV1: randomUUID(),
    profileId: randomUUID(),
    profileIdV1: randomUUID(),
    jobV1Id: randomUUID(),
    jobV2Id: randomUUID(),
  };
  const profile = GOLDEN_REQUEST.energyProfile;
  const surfaces = profile.roofs.map((roof) => ({
    tiltDeg: roof.tiltDeg,
    azimuthDeg: roof.azimuthDeg,
  }));
  const preparationV2 = buildProjectCalculationPreparationV2({
    schemaVersion: "project-calculation-preparation.v2",
    latitude: 52.52,
    longitude: 13.41,
    axis: {
      slots: 35_040,
      resolution: "quarter_hour",
      version: CALCULATION_V2_AXIS_VERSION,
    },
    providerRecipe: CALCULATION_V2_PROVIDER_RECIPE_VERSION,
    geometry: { surfaces },
    profile,
    requirements: REQUIREMENTS,
    sourceSnapshot: SOURCE_SNAPSHOT,
    storage: NO_STORAGE,
  });
  const preparationV1 = buildProjectCalculationPreparation({
    latitude: 52.52,
    longitude: 13.41,
    profile,
    requirements: REQUIREMENTS,
    sourceSnapshot: SOURCE_SNAPSHOT,
  });

  await withTenantOn(testPool, ids.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${ids.workspaceId}::uuid, ${`M1-11e v2-claim ${ids.jobV2Id}`})
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${ids.actorId}::uuid, ${`${ids.actorId}@calculation-v2-claim.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (${ids.workspaceId}::uuid, ${ids.actorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values (
        ${ids.contactId}::uuid, ${ids.workspaceId}::uuid, 'V2 Claim', 'Fixture', 'Contact',
        'v2.claim@example.test', 'v2.claim@example.test'
      )
    `);
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address,
        address_fingerprint, address_fingerprint_version, address_mode,
        street, house_number, postal_code, city, country, lat, lng,
        geocode_source, geocode_precision, address_follow_up_required,
        address_revision, pin_confirmed, pin_confirmed_address_revision
      ) values (
        ${ids.siteId}::uuid, ${ids.workspaceId}::uuid, ${ids.contactId}::uuid,
        'V2 Claim Site', 'V2-Weg 1, 10115 Berlin',
        decode(repeat('75', 32), 'hex'), 1, 'selected', 'V2-Weg', '1',
        '10115', 'Berlin', 'DE', 52.52, 13.41, 'photon', 'house', false, 1, true, 1
      )
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${ids.projectId}::uuid, ${ids.workspaceId}::uuid,
             ${ids.contactId}::uuid, ${ids.siteId}::uuid,
             board.id, intake_column.id, 'V2 Claim', 'fixture'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
       and intake_column.board_id = board.id
       and intake_column.is_intake = true
       and intake_column.archived_at is null
      where board.workspace_id = ${ids.workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null
    `);
    await tx.execute(sql`
      insert into inbound_receipt (
        id, workspace_id, source_key, submission_id, contract_version,
        body_sha256, auth_key_id, signed_at, submitted_at, received_at,
        producer_application, producer_git_revision, producer_environment,
        calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
        privacy_notice_version, privacy_notice_url, contact_resolution,
        contact_id, site_id, project_id
      ) values (
        ${ids.receiptId}::uuid, ${ids.workspaceId}::uuid, 'wmee-rechner-v3',
        ${randomUUID()}::uuid, 'rechner-intake.v1',
        decode(repeat('76', 32), 'hex'), 'v2-claim-key', ${NOW}, ${NOW}, ${NOW},
        'wmee-rechner-v3', ${CALCULATION_V2_SOURCE_REVISION}, 'development', 'wmee-solar.v1',
        '{}'::jsonb, 'offer_request', 'art_6_1_b_precontractual', 'fixture',
        'https://example.test/privacy', 'created', ${ids.contactId}::uuid,
        ${ids.siteId}::uuid, ${ids.projectId}::uuid
      )
    `);
    await tx.execute(sql`
      insert into calculator_snapshot (
        id, workspace_id, receipt_id, project_id, schema_version,
        calculator_engine, result_integrity, investment_source,
        calculated_at, snapshot
      ) values (
        ${ids.snapshotId}::uuid, ${ids.workspaceId}::uuid, ${ids.receiptId}::uuid,
        ${ids.projectId}::uuid, 'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate', ${NOW},
        ${JSON.stringify({
          schemaVersion: "wmee-solar-snapshot.v1",
          calculatedAt: NOW.toISOString(),
          branch: "new_installation",
          questionnaireVariant: "short",
          resultIntegrity: "client_reported_unverified",
          inputs: {},
          provenance: { investment: "market_estimate" },
          result: { mode: "new_installation" },
        })}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into project_requirement (
        id, workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${ids.requirementId}::uuid, ${ids.workspaceId}::uuid,
        ${ids.projectId}::uuid, 1, 'project-requirements.rechner.v1',
        ${ids.snapshotId}::uuid,
        ${JSON.stringify(REQUIREMENTS)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into site_energy_profile (
        id, workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256, confirmed_profile_revision,
        confirmed_address_revision, confirmed_by, confirmed_at
      ) values (
        ${ids.profileId}::uuid, ${ids.workspaceId}::uuid, ${ids.siteId}::uuid, 1,
        'site-energy-profile.v1', 'consumption', 'rechner_snapshot',
        ${ids.snapshotId}::uuid, ${ids.projectId}::uuid, 1,
        ${JSON.stringify(profile)}::jsonb,
        ${sha256Bytes(profile)}, 1, 1,
        ${ids.actorId}::uuid, ${NOW}
      )
    `);
    // Zweiter Projekt-Strang fuer die v1-Zeile: project_calculation_job
    // erlaubt nur einen aktiven Job je (workspace, project).
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address,
        address_fingerprint, address_fingerprint_version, address_mode,
        street, house_number, postal_code, city, country, lat, lng,
        geocode_source, geocode_precision, address_follow_up_required,
        address_revision, pin_confirmed, pin_confirmed_address_revision
      ) values (
        ${ids.siteIdV1}::uuid, ${ids.workspaceId}::uuid, ${ids.contactId}::uuid,
        'V1 Claim Site', 'V1-Weg 2, 10115 Berlin',
        decode(repeat('77', 32), 'hex'), 1, 'selected', 'V1-Weg', '2',
        '10115', 'Berlin', 'DE', 52.52, 13.41, 'photon', 'house', false, 1, true, 1
      )
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${ids.projectIdV1}::uuid, ${ids.workspaceId}::uuid,
             ${ids.contactId}::uuid, ${ids.siteIdV1}::uuid,
             board.id, intake_column.id, 'V1 Claim', 'fixture'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
       and intake_column.board_id = board.id
       and intake_column.is_intake = true
       and intake_column.archived_at is null
      where board.workspace_id = ${ids.workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null
    `);
    await tx.execute(sql`
      insert into inbound_receipt (
        id, workspace_id, source_key, submission_id, contract_version,
        body_sha256, auth_key_id, signed_at, submitted_at, received_at,
        producer_application, producer_git_revision, producer_environment,
        calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
        privacy_notice_version, privacy_notice_url, contact_resolution,
        contact_id, site_id, project_id
      ) values (
        ${ids.receiptIdV1}::uuid, ${ids.workspaceId}::uuid, 'wmee-rechner-v3',
        ${randomUUID()}::uuid, 'rechner-intake.v1',
        decode(repeat('78', 32), 'hex'), 'v1-claim-key', ${NOW}, ${NOW}, ${NOW},
        'wmee-rechner-v3', ${PLANNING_MODEL_SOURCE_REVISION}, 'development', 'wmee-solar.v1',
        '{}'::jsonb, 'offer_request', 'art_6_1_b_precontractual', 'fixture',
        'https://example.test/privacy', 'created', ${ids.contactId}::uuid,
        ${ids.siteIdV1}::uuid, ${ids.projectIdV1}::uuid
      )
    `);
    await tx.execute(sql`
      insert into calculator_snapshot (
        id, workspace_id, receipt_id, project_id, schema_version,
        calculator_engine, result_integrity, investment_source,
        calculated_at, snapshot
      ) values (
        ${ids.snapshotIdV1}::uuid, ${ids.workspaceId}::uuid, ${ids.receiptIdV1}::uuid,
        ${ids.projectIdV1}::uuid, 'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate', ${NOW},
        ${JSON.stringify({
          schemaVersion: "wmee-solar-snapshot.v1",
          calculatedAt: NOW.toISOString(),
          branch: "new_installation",
          questionnaireVariant: "short",
          resultIntegrity: "client_reported_unverified",
          inputs: {},
          provenance: { investment: "market_estimate" },
          result: { mode: "new_installation" },
        })}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into project_requirement (
        id, workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${ids.requirementIdV1}::uuid, ${ids.workspaceId}::uuid,
        ${ids.projectIdV1}::uuid, 1, 'project-requirements.rechner.v1',
        ${ids.snapshotIdV1}::uuid,
        ${JSON.stringify(REQUIREMENTS)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into site_energy_profile (
        id, workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256, confirmed_profile_revision,
        confirmed_address_revision, confirmed_by, confirmed_at
      ) values (
        ${ids.profileIdV1}::uuid, ${ids.workspaceId}::uuid, ${ids.siteIdV1}::uuid, 1,
        'site-energy-profile.v1', 'consumption', 'rechner_snapshot',
        ${ids.snapshotIdV1}::uuid, ${ids.projectIdV1}::uuid, 1,
        ${JSON.stringify(profile)}::jsonb,
        ${sha256Bytes(profile)}, 1, 1,
        ${ids.actorId}::uuid, ${NOW}
      )
    `);
    const preparationV2Sha = Buffer.from(
      hashProjectCalculationPreparationV2(preparationV2),
      "hex",
    );
    await tx.execute(sql`
      insert into project_calculation_job (
        id, workspace_id, project_id, site_id, address_revision,
        pin_confirmed_address_revision, profile_id, profile_revision,
        confirmed_profile_revision, confirmed_address_revision,
        requirement_id, requirement_revision, source_snapshot_id,
        reservation_key, provider_recipe_version, contract_version,
        model_id, model_version, source_revision, defaults_version,
        preparation_snapshot, preparation_sha256, state, attempt_count,
        next_attempt_at, created_by
      ) values (
        ${ids.jobV2Id}::uuid, ${ids.workspaceId}::uuid, ${ids.projectId}::uuid,
        ${ids.siteId}::uuid, 1, 1, ${ids.profileId}::uuid, 1, 1, 1,
        ${ids.requirementId}::uuid, 1, ${ids.snapshotId}::uuid,
        ${sha256Bytes({ reservation: ids.jobV2Id })}, ${CALCULATION_V2_PROVIDER_RECIPE_VERSION},
        'planning-calculation.v2', ${CALCULATION_V2_MODEL_ID}, ${CALCULATION_V2_MODEL_VERSION},
        ${CALCULATION_V2_SOURCE_REVISION}, ${CALCULATION_V2_DEFAULTS_VERSION},
        ${JSON.stringify(preparationV2)}::jsonb,
        ${preparationV2Sha}, 'queued', 0, ${NOW},
        ${ids.actorId}::uuid
      )
    `);
    const preparationV1Sha = Buffer.from(
      hashProjectCalculationPreparation(preparationV1),
      "hex",
    );
    await tx.execute(sql`
      insert into project_calculation_job (
        id, workspace_id, project_id, site_id, address_revision,
        pin_confirmed_address_revision, profile_id, profile_revision,
        confirmed_profile_revision, confirmed_address_revision,
        requirement_id, requirement_revision, source_snapshot_id,
        reservation_key, provider_recipe_version, contract_version,
        model_id, model_version, source_revision, defaults_version,
        preparation_snapshot, preparation_sha256, state, attempt_count,
        next_attempt_at, created_by
      ) values (
        ${ids.jobV1Id}::uuid, ${ids.workspaceId}::uuid, ${ids.projectIdV1}::uuid,
        ${ids.siteIdV1}::uuid, 1, 1, ${ids.profileIdV1}::uuid, 1, 1, 1,
        ${ids.requirementIdV1}::uuid, 1, ${ids.snapshotIdV1}::uuid,
        ${sha256Bytes({ reservation: ids.jobV1Id })}, ${PLANNING_PROVIDER_RECIPE_VERSION},
        'planning-calculation.v1', ${PLANNING_MODEL_ID}, ${PLANNING_MODEL_VERSION},
        ${PLANNING_MODEL_SOURCE_REVISION}, ${PLANNING_DEFAULTS_VERSION},
        ${JSON.stringify(preparationV1)}::jsonb,
        ${preparationV1Sha}, 'queued', 0, ${NOW},
        ${ids.actorId}::uuid
      )
    `);
  });

  return { ...ids, preparationV2, preparationV1 };
}

async function claim(
  tx: TenantTx,
  workspaceId: string,
  jobId: string,
): Promise<ProjectCalculationClaim> {
  const claimed = await claimProjectCalculationJob(tx, {
    workspaceId,
    jobId,
    leaseToken: randomUUID(),
  });
  if (claimed === null) throw new Error("claim returned null");
  return claimed;
}

describe("F4.1 v2 claim mapping", () => {
  it("liefert v2-Provenienz und Provider-Anfrage auf v2-Zeilen", async () => {
    const fixture = await createFixture();
    const claimed = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      claim(tx, fixture.workspaceId, fixture.jobV2Id));
    expect(claimed.contractVersion).toBe(CALCULATION_V2_CONTRACT_VERSION);
    expect(claimed.preparationV2).toEqual(fixture.preparationV2);
    expect(claimed.providerRequestV2).toEqual({ latitude: 52.52, longitude: 13.41 });
    expect(claimed.preparation).toBeNull();
    expect(claimed.providerRequest).toBeNull();
    expect(claimed.input).toBeNull();
  });

  it("liefert keine v2-Sicht auf v1-Zeilen", async () => {
    const fixture = await createFixture();
    const claimed = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      claim(tx, fixture.workspaceId, fixture.jobV1Id));
    expect(claimed.contractVersion).toBe(PLANNING_CALCULATION_CONTRACT_VERSION);
    expect(claimed.preparationV2).toBeNull();
    expect(claimed.providerRequestV2).toBeNull();
    expect(claimed.preparation).toEqual(fixture.preparationV1);
    expect(claimed.providerRequest).not.toBeNull();
  });
});
