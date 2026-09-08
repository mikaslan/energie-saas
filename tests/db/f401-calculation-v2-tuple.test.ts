import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_DEFAULTS_VERSION,
  CALCULATION_V2_MODEL_ID,
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
  CALCULATION_V2_VALIDATION_STATUS,
} from "@/lib/integrations/calculation/versions-v2";
import { withTenantOn } from "@/lib/db/tenant";
import { testPool } from "../setup/test-db";

// F4.1/0078 RED: Der v2-Vertragstupel wird atomar akzeptiert, gemischte oder
// unbekannte Tupel fail-closed abgewiesen. Ohne Migration 0078 ist der
// v2-Fall rot.

const V1 = {
  contractVersion: "planning-calculation.v1",
  providerRecipeVersion: "pvgis-5.3-sarah3-2020.v1",
  modelId: "wmee-solar",
  modelVersion: "1.0.0",
  sourceRevision: "a".repeat(40),
  defaultsVersion: "wmee-planning-defaults.v1",
};

const V2 = {
  contractVersion: CALCULATION_V2_CONTRACT_VERSION,
  providerRecipeVersion: CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  modelId: CALCULATION_V2_MODEL_ID,
  modelVersion: CALCULATION_V2_MODEL_VERSION,
  sourceRevision: CALCULATION_V2_SOURCE_REVISION,
  defaultsVersion: CALCULATION_V2_DEFAULTS_VERSION,
};

const NOW_ISO = "2026-08-29T12:00:00.000Z";

type Graph = {
  workspaceId: string;
  actorId: string;
  contactId: string;
  siteId: string;
  projectId: string;
  receiptId: string;
  snapshotId: string;
  requirementId: string;
  profileId: string;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seedGraph(): Promise<Graph> {
  const graph: Graph = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
  };
  const email = `${graph.actorId}@f401.test`;
  const snapshot = {
    schemaVersion: "wmee-solar-snapshot.v1",
    calculatedAt: NOW_ISO,
    branch: "new_installation",
    questionnaireVariant: "short",
    resultIntegrity: "client_reported_unverified",
    inputs: {},
    provenance: { investment: "market_estimate" },
    result: { mode: "new_installation" },
  };
  const requirements = {
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
  const profile = {
    schemaVersion: "site-energy-profile.v1",
    inputMode: "consumption",
    building: {},
    roofs: [{ id: "dach-1" }],
    consumption: {},
    existingAssets: {},
    provenance: {},
  };
  await withTenantOn(testPool, graph.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name) values (${graph.workspaceId}::uuid, 'F401-0078')`);
    await tx.execute(sql`
      insert into user_identity (id, email) values (${graph.actorId}::uuid, ${email})`);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role)
      values (${graph.workspaceId}::uuid, ${graph.actorId}::uuid, 'editor')`);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${graph.contactId}::uuid, ${graph.workspaceId}::uuid, 'F401', 'Fixture', 'Contact',
        ${`${graph.contactId}@f401.test`}, ${`${graph.contactId}@f401.test`})`);
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address, address_fingerprint,
        address_fingerprint_version, address_mode, street, house_number, postal_code,
        city, country, lat, lng, geocode_source, geocode_precision,
        address_follow_up_required, address_revision, pin_confirmed,
        pin_confirmed_address_revision, pin_adjusted
      ) values (
        ${graph.siteId}::uuid, ${graph.workspaceId}::uuid, ${graph.contactId}::uuid,
        'F401', 'Testweg 1, 10115 Berlin', decode(repeat('ab', 32), 'hex'), 1, 'selected',
        'Testweg', '1', '10115', 'Berlin', 'DE', 52.52, 13.41, 'photon', 'house',
        false, 1, true, 1, false)`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${graph.projectId}::uuid, ${graph.workspaceId}::uuid, ${graph.contactId}::uuid,
             ${graph.siteId}::uuid, board.id, intake_column.id, 'F401', 'wmee-rechner-v3'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
       and intake_column.board_id = board.id
       and intake_column.is_intake = true
       and intake_column.archived_at is null
      where board.workspace_id = ${graph.workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null`);
    await tx.execute(sql`
      insert into inbound_receipt (
        id, workspace_id, source_key, submission_id, contract_version, body_sha256,
        auth_key_id, signed_at, submitted_at, received_at, producer_application,
        producer_git_revision, producer_environment, calculator_engine, acquisition,
        privacy_purpose, privacy_legal_basis, privacy_notice_version, privacy_notice_url,
        contact_resolution, contact_id, site_id, project_id
      ) values (
        ${graph.receiptId}::uuid, ${graph.workspaceId}::uuid, 'wmee-rechner-v3',
        ${randomUUID()}::uuid, 'rechner-intake.v1', decode(repeat('00', 32), 'hex'),
        'f401-red', now(), now(), now(), 'wmee-rechner-v3', ${"0".repeat(40)},
        'development', 'wmee-solar.v1', '{}'::jsonb, 'offer_request',
        'art_6_1_b_precontractual', 'f401', 'https://example.test/privacy', 'created',
        ${graph.contactId}::uuid, ${graph.siteId}::uuid, ${graph.projectId}::uuid)`);
    await tx.execute(sql`
      insert into calculator_snapshot (
        id, workspace_id, receipt_id, project_id, schema_version, calculator_engine,
        result_integrity, investment_source, calculated_at, snapshot
      ) values (
        ${graph.snapshotId}::uuid, ${graph.workspaceId}::uuid, ${graph.receiptId}::uuid,
        ${graph.projectId}::uuid, 'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate', now(), ${JSON.stringify(snapshot)}::jsonb)`);
    await tx.execute(sql`
      insert into project_requirement (id, workspace_id, project_id, revision, schema_version, source_snapshot_id, requirements)
      values (${graph.requirementId}::uuid, ${graph.workspaceId}::uuid, ${graph.projectId}::uuid,
        1, 'project-requirements.rechner.v1', ${graph.snapshotId}::uuid, ${JSON.stringify(requirements)}::jsonb)`);
    await tx.execute(sql`
      insert into site_energy_profile (
        id, workspace_id, site_id, revision, schema_version, input_mode, source_kind,
        source_snapshot_id, source_project_id, address_revision, profile, profile_sha256,
        confirmed_profile_revision, confirmed_address_revision, confirmed_by, confirmed_at
      ) values (
        ${graph.profileId}::uuid, ${graph.workspaceId}::uuid, ${graph.siteId}::uuid,
        1, 'site-energy-profile.v1', 'consumption', 'rechner_snapshot',
        ${graph.snapshotId}::uuid, ${graph.projectId}::uuid, 1, ${JSON.stringify(profile)}::jsonb,
        decode(${sha256Hex(JSON.stringify(profile))}, 'hex'), 1, 1, ${graph.actorId}::uuid, ${NOW_ISO}::timestamptz)`);
  });
  return graph;
}

async function insertJob(graph: Graph, versions: typeof V1): Promise<unknown> {
  return withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
    insert into project_calculation_job (
      id, workspace_id, project_id, site_id, address_revision,
      pin_confirmed_address_revision, profile_id, profile_revision,
      confirmed_profile_revision, confirmed_address_revision, requirement_id,
      requirement_revision, source_snapshot_id, reservation_key,
      provider_recipe_version, contract_version, model_id, model_version,
      source_revision, defaults_version, state, attempt_count, next_attempt_at,
      created_by
    ) values (
      ${randomUUID()}::uuid, ${graph.workspaceId}::uuid, ${graph.projectId}::uuid,
      ${graph.siteId}::uuid, 1, 1, ${graph.profileId}::uuid, 1, 1, 1,
      ${graph.requirementId}::uuid, 1, ${graph.snapshotId}::uuid,
      decode(${sha256Hex(randomUUID())}, 'hex'), ${versions.providerRecipeVersion},
      ${versions.contractVersion}, ${versions.modelId}, ${versions.modelVersion},
      ${versions.sourceRevision}, ${versions.defaultsVersion}, 'queued', 0,
      ${NOW_ISO}::timestamptz, ${graph.actorId}::uuid
    )`).then(
      () => "inserted",
      (error: unknown) => error,
    ));
}

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

describe("F4.1 Migration 0078: v2-Vertragstupel", () => {
  it("akzeptiert v1-Tupel weiter (Baseline)", async () => {
    const graph = await seedGraph();
    expect(await insertJob(graph, V1)).toBe("inserted");
  });

  it("akzeptiert das exakte v2-Tupel", async () => {
    const graph = await seedGraph();
    expect(await insertJob(graph, V2)).toBe("inserted");
  });

  it("weist gemischte Tupel ab (v2-Vertrag mit v1-Modellkette)", async () => {
    const graph = await seedGraph();
    const mixed = { ...V2, modelVersion: V1.modelVersion, defaultsVersion: V1.defaultsVersion };
    expect(pgCode(await insertJob(graph, mixed))).toBe("23514");
  });

  it("weist unbekannte Vertraege ab", async () => {
    const graph = await seedGraph();
    const unknown = { ...V1, contractVersion: "planning-calculation.v9" };
    expect(pgCode(await insertJob(graph, unknown))).toBe("23514");
  });

  it("pinnt den v2-Quellfreeze in beiden Tupel-Checks (Migration<->Code)", async () => {
    const rows = await withTenantOn(testPool, randomUUID(), (tx) => tx.execute<{
      name: string;
      definition: string;
    }>(sql`
      select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conname in (
         'project_calculation_job_versions_ck',
         'project_calculation_revision_versions_ck')
    `).then((result) => result.rows));
    expect(rows).toHaveLength(2);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row.definition]));
    const job = String(byName["project_calculation_job_versions_ck"] ?? "");
    const revision = String(byName["project_calculation_revision_versions_ck"] ?? "");
    expect(job).toContain(CALCULATION_V2_SOURCE_REVISION);
    expect(revision).toContain(CALCULATION_V2_SOURCE_REVISION);
    // Quality-/Validation-Paar lebt nur auf der Revision.
    expect(revision).toContain(CALCULATION_V2_VALIDATION_STATUS);
    expect(revision).toContain("server_reproduced_public_reference");
  });
});
