import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import * as databaseSchema from "@/lib/db/schema";
import { withTenantOn } from "@/lib/db/tenant";
import { beforeAll, describe, expect, it } from "vitest";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

const CONTRACT_VERSION = "planning-calculation.v1";
const PROFILE_SCHEMA_VERSION = "site-energy-profile.v1";
const DEFAULTS_VERSION = "wmee-planning-defaults.v1";
const MODEL_ID = "wmee-solar";
const MODEL_VERSION = "1.0.0";
const SOURCE_REVISION = "a".repeat(40);
const PROVIDER_RECIPE_VERSION = "pvgis-5.3-sarah3-2020.v1";
const NOW_ISO = "2026-08-29T12:00:00.000Z";

const NEW_TABLES = [
  "site_energy_profile",
  "project_calculation_job",
  "project_calculation_revision",
] as const;

type NewTable = (typeof NEW_TABLES)[number];

type ProjectGraph = {
  workspaceId: string;
  actorId: string;
  contactId: string;
  siteId: string;
  projectId: string;
  receiptId: string;
  snapshotId: string;
  requirementId: string;
};

type ProfileRow = {
  id: string;
  profile: ReturnType<typeof energyProfile>;
  profileSha256Hex: string;
};

type JobRow = {
  id: string;
  reservationKeyHex: string;
};

type RevisionRow = {
  id: string;
  resultSha256Hex: string;
};

type ColumnRow = {
  column_name: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
};

type ForeignKeyRow = {
  constraint_name: string;
  source_table: string;
  target_table: string;
  source_columns: string[];
  target_columns: string[];
  validated: boolean;
};

type IndexRow = {
  table_name: string;
  index_name: string;
  is_unique: boolean;
  columns: string[];
  predicate: string | null;
};

function unknownField() {
  return { status: "unknown" as const, value: null, source: "not_collected" as const };
}

function energyProfile() {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    inputMode: "consumption" as const,
    building: {
      type: unknownField(),
      year: unknownField(),
      heatedAreaM2: unknownField(),
    },
    roofs: [
      {
        id: "dach-1",
        areaM2: 52,
        azimuthDeg: 5,
        tiltDeg: 35,
        type: "pitched" as const,
        shading: unknownField(),
        source: "user_drawn" as const,
      },
    ],
    consumption: {
      householdKwhPerYear: {
        status: "known" as const,
        value: 4_200,
        source: "customer_metered" as const,
      },
      electricityPriceCentsPerKwh: {
        status: "known" as const,
        value: 36,
        source: "customer_input" as const,
      },
      annualPriceIncreasePercent: unknownField(),
      loadProfile: unknownField(),
      evKmPerYear: unknownField(),
      evChargingPattern: unknownField(),
      heatPumpKwhPerYear: unknownField(),
      coolingKwhPerYear: unknownField(),
      heatingAcKwhPerYear: unknownField(),
      hotWaterKwhPerYear: unknownField(),
    },
    existingAssets: {
      pv: { status: "known_absent" as const, source: "rechner_branch" as const },
      storage: { status: "unknown" as const, source: "not_collected" as const },
      wallbox: { status: "unknown" as const, source: "not_collected" as const },
      ev: { status: "unknown" as const, source: "not_collected" as const },
    },
    provenance: {
      source: "rechner_snapshot" as const,
      sourceSchemaVersion: "wmee-solar-snapshot.v1" as const,
      sourceEngine: "wmee-solar.v1" as const,
      roof: "user_drawn" as const,
      consumption: "metered_kwh" as const,
      electricityPrice: "customer" as const,
      annualPriceIncrease: "default" as const,
    },
  };
}

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeSql(value: string | null): string {
  return (value ?? "").replace(/\s+/g, "").replaceAll('"', "").toLowerCase();
}

async function expectPgRejection(
  operation: Promise<unknown>,
  pattern: RegExp = /constraint|row-level security|mutation|immutable|unveraenderlich/i,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught, "Das unzulässige Statement hätte scheitern müssen.").toBeInstanceOf(Error);
  const cause = (caught as { cause?: unknown }).cause;
  expect(`${String(caught)}\n${String(cause)}`).toMatch(pattern);
}

async function createProjectGraph(label: string): Promise<ProjectGraph> {
  const graph: ProjectGraph = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
  };
  const email = `${graph.actorId}@m107.test`;
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

  await withTenantOn(testPool, graph.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${graph.workspaceId}::uuid, ${label})
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${graph.actorId}::uuid, ${email})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role)
      values (${graph.workspaceId}::uuid, ${graph.actorId}::uuid, 'editor')
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, email_primary, email_normalized
      ) values (
        ${graph.contactId}::uuid, ${graph.workspaceId}::uuid, ${label},
        ${`${graph.contactId}@m107.test`}, ${`${graph.contactId}@m107.test`}
      )
    `);
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address,
        address_fingerprint, address_fingerprint_version, address_mode,
        street, house_number, postal_code, city, country, lat, lng,
        geocode_source, geocode_precision, address_follow_up_required,
        address_revision, pin_confirmed, pin_confirmed_address_revision,
        pin_adjusted
      ) values (
        ${graph.siteId}::uuid, ${graph.workspaceId}::uuid, ${graph.contactId}::uuid,
        ${label}, 'Mühlstraße 8, 69234 Dielheim',
        decode(repeat('ab', 32), 'hex'), 1, 'selected',
        'Mühlstraße', '8', '69234', 'Dielheim', 'DE', 49.28463, 8.73821,
        'photon', 'house', false, 1, true, 1, false
      )
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${graph.projectId}::uuid, ${graph.workspaceId}::uuid,
             ${graph.contactId}::uuid, ${graph.siteId}::uuid,
             board.id, intake_column.id, ${label}, 'wmee-rechner-v3'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
       and intake_column.board_id = board.id
       and intake_column.is_intake = true
       and intake_column.archived_at is null
      where board.workspace_id = ${graph.workspaceId}::uuid
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
        ${graph.receiptId}::uuid, ${graph.workspaceId}::uuid,
        'wmee-rechner-v3', ${randomUUID()}::uuid, 'rechner-intake.v1',
        decode(repeat('00', 32), 'hex'), 'm107-schema-red', now(), now(), now(),
        'wmee-rechner-v3', ${"0".repeat(40)}, 'development', 'wmee-solar.v1',
        '{}'::jsonb, 'offer_request', 'art_6_1_b_precontractual', 'm107',
        'https://example.test/privacy', 'created', ${graph.contactId}::uuid,
        ${graph.siteId}::uuid, ${graph.projectId}::uuid
      )
    `);
    await tx.execute(sql`
      insert into calculator_snapshot (
        id, workspace_id, receipt_id, project_id, schema_version,
        calculator_engine, result_integrity, investment_source,
        calculated_at, snapshot
      ) values (
        ${graph.snapshotId}::uuid, ${graph.workspaceId}::uuid,
        ${graph.receiptId}::uuid, ${graph.projectId}::uuid,
        'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate', now(),
        ${JSON.stringify(snapshot)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into project_requirement (
        id, workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${graph.requirementId}::uuid, ${graph.workspaceId}::uuid,
        ${graph.projectId}::uuid, 1, 'project-requirements.rechner.v1',
        ${graph.snapshotId}::uuid, ${JSON.stringify(requirements)}::jsonb
      )
    `);
  });

  return graph;
}

async function insertProfile(
  graph: ProjectGraph,
  options: {
    confirmed?: boolean;
    sourceKind?: "rechner_snapshot" | "manual";
    id?: string;
    revision?: number;
    addressRevision?: number;
    profileSha256Hex?: string;
  } = {},
): Promise<ProfileRow> {
  const id = options.id ?? randomUUID();
  const profile = energyProfile();
  const profileSha256Hex = options.profileSha256Hex ?? sha256Hex(profile);
  const confirmed = options.confirmed ?? false;
  const sourceKind = options.sourceKind ?? "rechner_snapshot";
  const revision = options.revision ?? 1;
  const addressRevision = options.addressRevision ?? 1;
  const sourceSnapshotId = sourceKind === "rechner_snapshot" ? graph.snapshotId : null;
  const sourceProjectId = sourceKind === "rechner_snapshot" ? graph.projectId : null;

  await withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
    insert into site_energy_profile (
      id, workspace_id, site_id, revision, schema_version, input_mode,
      source_kind, source_snapshot_id, source_project_id, address_revision,
      profile, profile_sha256, confirmed_profile_revision,
      confirmed_address_revision, confirmed_by, confirmed_at
    ) values (
      ${id}::uuid, ${graph.workspaceId}::uuid, ${graph.siteId}::uuid,
      ${revision}, ${PROFILE_SCHEMA_VERSION}, 'consumption', ${sourceKind},
      ${sourceSnapshotId}::uuid, ${sourceProjectId}::uuid, ${addressRevision},
      ${JSON.stringify(profile)}::jsonb, decode(${profileSha256Hex}, 'hex'),
      ${confirmed ? revision : null}, ${confirmed ? addressRevision : null},
      ${confirmed ? graph.actorId : null}::uuid,
      ${confirmed ? NOW_ISO : null}::timestamptz
    )
  `));

  return { id, profile, profileSha256Hex };
}

async function confirmProfile(graph: ProjectGraph, profileId: string): Promise<void> {
  await withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
    update site_energy_profile
       set confirmed_profile_revision = revision,
           confirmed_address_revision = address_revision,
           confirmed_by = ${graph.actorId}::uuid,
           confirmed_at = ${NOW_ISO}::timestamptz
     where workspace_id = ${graph.workspaceId}::uuid
       and id = ${profileId}::uuid
  `));
}

async function insertJob(
  graph: ProjectGraph,
  profileId: string,
  options: { id?: string; reservationKeyHex?: string } = {},
): Promise<JobRow> {
  const id = options.id ?? randomUUID();
  const reservationKeyHex = options.reservationKeyHex ?? sha256Hex(randomUUID());

  await withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
    insert into project_calculation_job (
      id, workspace_id, project_id, site_id,
      address_revision, pin_confirmed_address_revision,
      profile_id, profile_revision, confirmed_profile_revision,
      confirmed_address_revision, requirement_id, requirement_revision,
      source_snapshot_id, reservation_key, provider_recipe_version,
      contract_version, model_id, model_version, source_revision,
      defaults_version, state, attempt_count, next_attempt_at, created_by
    ) values (
      ${id}::uuid, ${graph.workspaceId}::uuid, ${graph.projectId}::uuid,
      ${graph.siteId}::uuid, 1, 1, ${profileId}::uuid, 1, 1, 1,
      ${graph.requirementId}::uuid, 1, ${graph.snapshotId}::uuid,
      decode(${reservationKeyHex}, 'hex'), ${PROVIDER_RECIPE_VERSION},
      ${CONTRACT_VERSION}, ${MODEL_ID}, ${MODEL_VERSION}, ${SOURCE_REVISION},
      ${DEFAULTS_VERSION}, 'queued', 0, ${NOW_ISO}::timestamptz,
      ${graph.actorId}::uuid
    )
  `));

  return { id, reservationKeyHex };
}

async function claimAndSetInput(
  graph: ProjectGraph,
  jobId: string,
  inputSha256Hex = sha256Hex("planning-input"),
): Promise<string> {
  const leaseToken = randomUUID();
  const inputSnapshot = {
    contractVersion: CONTRACT_VERSION,
    canonicalizationVersion: "planning-jcs.v1",
    bindings: {
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      siteId: graph.siteId,
    },
  };
  const providerSnapshot = {
    provider: "PVGIS",
    apiVersion: "5.3",
    recipeVersion: PROVIDER_RECIPE_VERSION,
  };

  await withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
    update project_calculation_job
       set state = 'running',
           attempt_count = attempt_count + 1,
           started_at = coalesce(started_at, ${NOW_ISO}::timestamptz),
           lease_token = ${leaseToken}::uuid,
           lease_expires_at = (${NOW_ISO}::timestamptz + interval '5 minutes')
     where workspace_id = ${graph.workspaceId}::uuid
       and id = ${jobId}::uuid
  `));
  await withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
    update project_calculation_job
       set input_sha256 = decode(${inputSha256Hex}, 'hex'),
           input_snapshot = ${JSON.stringify(inputSnapshot)}::jsonb,
           provider_snapshot = ${JSON.stringify(providerSnapshot)}::jsonb
     where workspace_id = ${graph.workspaceId}::uuid
       and id = ${jobId}::uuid
  `));

  return inputSha256Hex;
}

async function insertRevision(
  graph: ProjectGraph,
  profileId: string,
  jobId: string,
  inputSha256Hex: string,
  options: { id?: string; revision?: number; validationStatus?: string } = {},
): Promise<RevisionRow> {
  const id = options.id ?? randomUUID();
  const revision = options.revision ?? 1;
  const validationStatus = options.validationStatus ?? "not_f4_reference_validated";
  const result = {
    contractVersion: CONTRACT_VERSION,
    canonicalizationVersion: "planning-jcs.v1",
    model: { id: MODEL_ID, version: MODEL_VERSION, sourceRevision: SOURCE_REVISION },
    inputSha256: inputSha256Hex,
    quality: "server_reproduced_estimate",
    validationStatus,
    temporalResolution: "hourly_8760",
    roundingVersion: "wmee-energy-rounding.v1",
    warnings: [
      { code: "not_f4_reference_validated", severity: "warning" },
    ],
    branch: "new_installation",
    calculation: {
      systemPeakPowerKwp: 10,
      plannedStorageCapacityKwh: 8,
      annual: {
        generationKwh: 10_000,
        consumptionKwh: 4_200,
        directConsumptionKwh: 2_000,
        fromStorageKwh: 1_000,
        selfConsumptionKwh: 3_000,
        feedInKwh: 7_000,
        gridImportKwh: 1_200,
        storageLossKwh: 100,
        selfConsumptionRate: 0.3,
        autonomyRate: 3_000 / 4_200,
        storageFullCycles: 120,
        fromVehicleKwh: 0,
      },
      monthly: Array.from({ length: 12 }, (_, month) => ({
        month: month + 1,
        generationKwh: 10_000 / 12,
        selfConsumptionKwh: 250,
        gridImportKwh: 100,
        feedInKwh: 7_000 / 12,
      })),
    },
  };
  const resultSha256Hex = sha256Hex(result);
  const resultWithHash = { ...result, resultSha256: resultSha256Hex };
  const inputSnapshot = {
    contractVersion: CONTRACT_VERSION,
    canonicalizationVersion: "planning-jcs.v1",
    bindings: {
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      siteId: graph.siteId,
    },
  };
  const providerSnapshot = {
    provider: "PVGIS",
    apiVersion: "5.3",
    recipeVersion: PROVIDER_RECIPE_VERSION,
  };

  await withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
    insert into project_calculation_revision (
      id, workspace_id, project_id, site_id, revision, job_id,
      address_revision, pin_confirmed_address_revision,
      profile_id, profile_revision, confirmed_profile_revision,
      confirmed_address_revision, requirement_id, requirement_revision,
      source_snapshot_id, contract_version, model_id, model_version,
      source_revision, defaults_version, quality, validation_status,
      input_sha256, result_sha256, input_snapshot, provider_snapshot,
      result, created_by
    ) values (
      ${id}::uuid, ${graph.workspaceId}::uuid, ${graph.projectId}::uuid,
      ${graph.siteId}::uuid, ${revision}, ${jobId}::uuid, 1, 1,
      ${profileId}::uuid, 1, 1, 1, ${graph.requirementId}::uuid, 1,
      ${graph.snapshotId}::uuid, ${CONTRACT_VERSION}, ${MODEL_ID},
      ${MODEL_VERSION}, ${SOURCE_REVISION}, ${DEFAULTS_VERSION},
      'server_reproduced_estimate', ${validationStatus},
      decode(${inputSha256Hex}, 'hex'), decode(${resultSha256Hex}, 'hex'),
      ${JSON.stringify(inputSnapshot)}::jsonb,
      ${JSON.stringify(providerSnapshot)}::jsonb,
      ${JSON.stringify(resultWithHash)}::jsonb, ${graph.actorId}::uuid
    )
  `));

  return { id, resultSha256Hex };
}

async function finishJob(
  graph: ProjectGraph,
  jobId: string,
  revisionId: string,
): Promise<void> {
  await withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
    update project_calculation_job
       set state = 'succeeded',
           result_revision_id = ${revisionId}::uuid,
           finished_at = ${NOW_ISO}::timestamptz,
           lease_token = null,
           lease_expires_at = null
     where workspace_id = ${graph.workspaceId}::uuid
       and id = ${jobId}::uuid
  `));
}

async function columnsOf(table: NewTable): Promise<Map<string, ColumnRow>> {
  const { rows } = await testPool.query<ColumnRow>(`
    select column_name, udt_name, is_nullable
      from information_schema.columns
     where table_schema = 'public' and table_name = $1
     order by ordinal_position
  `, [table]);
  return new Map(rows.map((row) => [row.column_name, row]));
}

async function foreignKeys(): Promise<ForeignKeyRow[]> {
  const { rows } = await testPool.query<ForeignKeyRow>(`
    select con.conname as constraint_name,
           src.relname as source_table,
           target.relname as target_table,
           array_agg(src_att.attname::text order by src_col.ordinality) as source_columns,
           array_agg(target_att.attname::text order by src_col.ordinality) as target_columns,
           con.convalidated as validated
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class src on src.oid = con.conrelid
      join pg_catalog.pg_namespace src_ns on src_ns.oid = src.relnamespace
      join pg_catalog.pg_class target on target.oid = con.confrelid
      join pg_catalog.pg_namespace target_ns on target_ns.oid = target.relnamespace
      join lateral unnest(con.conkey) with ordinality src_col(attnum, ordinality) on true
      join lateral unnest(con.confkey) with ordinality target_col(attnum, ordinality)
        on target_col.ordinality = src_col.ordinality
      join pg_catalog.pg_attribute src_att
        on src_att.attrelid = src.oid and src_att.attnum = src_col.attnum
      join pg_catalog.pg_attribute target_att
        on target_att.attrelid = target.oid and target_att.attnum = target_col.attnum
     where con.contype = 'f'
       and src_ns.nspname = 'public'
       and target_ns.nspname = 'public'
       and src.relname = any($1::text[])
     group by con.conname, src.relname, target.relname, con.convalidated
     order by src.relname, con.conname
  `, [NEW_TABLES]);
  return rows;
}

async function indexes(): Promise<IndexRow[]> {
  const { rows } = await testPool.query<IndexRow>(`
    select table_row.relname as table_name,
           index_row.relname as index_name,
           index_meta.indisunique as is_unique,
           array_agg(attribute_row.attname::text order by key_row.ordinality)
             filter (where key_row.ordinality <= index_meta.indnkeyatts) as columns,
           pg_catalog.pg_get_expr(index_meta.indpred, index_meta.indrelid) as predicate
      from pg_catalog.pg_index index_meta
      join pg_catalog.pg_class table_row on table_row.oid = index_meta.indrelid
      join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
      join pg_catalog.pg_class index_row on index_row.oid = index_meta.indexrelid
      join lateral unnest(index_meta.indkey::int2[]) with ordinality key_row(attnum, ordinality)
        on true
      join pg_catalog.pg_attribute attribute_row
        on attribute_row.attrelid = table_row.oid
       and attribute_row.attnum = key_row.attnum
     where namespace_row.nspname = 'public'
       and table_row.relname = any($1::text[])
       and index_meta.indisvalid
       and index_meta.indisready
     group by table_row.relname, index_row.relname, index_meta.indisunique,
              index_meta.indpred, index_meta.indrelid
     order by table_row.relname, index_row.relname
  `, [[
    ...NEW_TABLES,
    "project",
    "project_requirement",
  ]]);
  return rows;
}

function expectIndex(
  rows: IndexRow[],
  table: string,
  name: string,
  columns: string[],
  unique: boolean,
): IndexRow {
  const row = rows.find((entry) => entry.table_name === table && entry.index_name === name);
  expect(row, `${table}.${name} fehlt.`).toBeDefined();
  expect(row?.columns, `${table}.${name}: falsche Schlüsselreihenfolge.`).toEqual(columns);
  expect(row?.is_unique, `${table}.${name}: falsche Unique-Semantik.`).toBe(unique);
  return row!;
}

function expectForeignKey(
  rows: ForeignKeyRow[],
  sourceTable: NewTable,
  sourceColumns: string[],
  targetTable: string,
  targetColumns: string[],
): void {
  const row = rows.find((entry) =>
    entry.source_table === sourceTable
    && entry.target_table === targetTable
    && JSON.stringify(entry.source_columns) === JSON.stringify(sourceColumns)
    && JSON.stringify(entry.target_columns) === JSON.stringify(targetColumns));
  expect(
    row,
    `${sourceTable} (${sourceColumns.join(",")}) -> ${targetTable} (${targetColumns.join(",")}) fehlt.`,
  ).toBeDefined();
  expect(row?.validated, `${row?.constraint_name ?? sourceTable}: FK ist NOT VALID.`).toBe(true);
}

beforeAll(async () => {
  // Die Testdatei bleibt absichtlich RED, bis Schema UND Migration existieren.
  // Keine Zukunftstabelle wird hier improvisiert oder per Test-DDL angelegt.
  await testPool.query("select 1");
});

describe.sequential("M1-07: additive Drizzle-/PostgreSQL-Schnittstelle", () => {
  it("exportiert alle drei Tabellen aus dem Domänen-Barrel", () => {
    const missing = [
      "siteEnergyProfile",
      "projectCalculationJob",
      "projectCalculationRevision",
    ].filter((name) => !(name in databaseSchema));
    expect(missing, `Fehlende Drizzle-Exporte: ${missing.join(", ")}`).toEqual([]);
  });

  it("migriert Profil, technische Queue und immutable Ergebnisrevision als echte Tabellen", async () => {
    const { rows } = await testPool.query<{ table_name: string }>(`
      select table_name
        from information_schema.tables
       where table_schema = 'public'
         and table_type = 'BASE TABLE'
         and table_name = any($1::text[])
       order by table_name
    `, [NEW_TABLES]);
    expect(rows.map((row) => row.table_name)).toEqual([...NEW_TABLES].sort());
  });

  it("trägt jede neue Tenant-Tabelle in Fixture- und Rollenmanifest ein", () => {
    const missingFixtures = NEW_TABLES.filter((table) => !(table in tenantFixtures));
    expect(
      missingFixtures,
      `Tenant-Fixture fehlt für: ${missingFixtures.join(", ")}`,
    ).toEqual([]);

    const roleContract = readFileSync(resolve("scripts/db-role-contract.mts"), "utf8");
    const missingAclEntries = NEW_TABLES.filter(
      (table) => !roleContract.includes(`public.${table}`),
    );
    expect(
      missingAclEntries,
      `ACL-Manifest kennt diese Tabellen nicht: ${missingAclEntries.join(", ")}`,
    ).toEqual([]);
  });

  it("pinnt die notwendigen Spalten, Typen und Nullable-Grenzen", async () => {
    const expected: Record<NewTable, Record<string, [string, "YES" | "NO"]>> = {
      site_energy_profile: {
        id: ["uuid", "NO"],
        workspace_id: ["uuid", "NO"],
        site_id: ["uuid", "NO"],
        revision: ["int4", "NO"],
        schema_version: ["text", "NO"],
        input_mode: ["text", "NO"],
        source_kind: ["text", "NO"],
        source_snapshot_id: ["uuid", "YES"],
        source_project_id: ["uuid", "YES"],
        address_revision: ["int4", "NO"],
        profile: ["jsonb", "NO"],
        profile_sha256: ["bytea", "NO"],
        confirmed_profile_revision: ["int4", "YES"],
        confirmed_address_revision: ["int4", "YES"],
        confirmed_by: ["uuid", "YES"],
        confirmed_at: ["timestamptz", "YES"],
        created_at: ["timestamptz", "NO"],
        updated_at: ["timestamptz", "NO"],
      },
      project_calculation_job: {
        id: ["uuid", "NO"],
        workspace_id: ["uuid", "NO"],
        project_id: ["uuid", "NO"],
        site_id: ["uuid", "NO"],
        address_revision: ["int4", "NO"],
        pin_confirmed_address_revision: ["int4", "NO"],
        profile_id: ["uuid", "NO"],
        profile_revision: ["int4", "NO"],
        confirmed_profile_revision: ["int4", "NO"],
        confirmed_address_revision: ["int4", "NO"],
        requirement_id: ["uuid", "NO"],
        requirement_revision: ["int4", "NO"],
        source_snapshot_id: ["uuid", "YES"],
        reservation_key: ["bytea", "NO"],
        provider_recipe_version: ["text", "NO"],
        contract_version: ["text", "NO"],
        model_id: ["text", "NO"],
        model_version: ["text", "NO"],
        source_revision: ["text", "NO"],
        defaults_version: ["text", "NO"],
        preparation_snapshot: ["jsonb", "YES"],
        preparation_sha256: ["bytea", "YES"],
        state: ["text", "NO"],
        attempt_count: ["int4", "NO"],
        next_attempt_at: ["timestamptz", "NO"],
        lease_token: ["uuid", "YES"],
        lease_expires_at: ["timestamptz", "YES"],
        input_sha256: ["bytea", "YES"],
        input_snapshot: ["jsonb", "YES"],
        provider_snapshot: ["jsonb", "YES"],
        error_code: ["text", "YES"],
        error_retryable: ["bool", "YES"],
        created_by: ["uuid", "NO"],
        created_at: ["timestamptz", "NO"],
        started_at: ["timestamptz", "YES"],
        finished_at: ["timestamptz", "YES"],
        result_revision_id: ["uuid", "YES"],
      },
      project_calculation_revision: {
        id: ["uuid", "NO"],
        workspace_id: ["uuid", "NO"],
        project_id: ["uuid", "NO"],
        site_id: ["uuid", "NO"],
        revision: ["int4", "NO"],
        job_id: ["uuid", "NO"],
        address_revision: ["int4", "NO"],
        pin_confirmed_address_revision: ["int4", "NO"],
        profile_id: ["uuid", "NO"],
        profile_revision: ["int4", "NO"],
        confirmed_profile_revision: ["int4", "NO"],
        confirmed_address_revision: ["int4", "NO"],
        requirement_id: ["uuid", "NO"],
        requirement_revision: ["int4", "NO"],
        source_snapshot_id: ["uuid", "YES"],
        contract_version: ["text", "NO"],
        model_id: ["text", "NO"],
        model_version: ["text", "NO"],
        source_revision: ["text", "NO"],
        defaults_version: ["text", "NO"],
        quality: ["text", "NO"],
        validation_status: ["text", "NO"],
        input_sha256: ["bytea", "NO"],
        result_sha256: ["bytea", "NO"],
        input_snapshot: ["jsonb", "NO"],
        provider_snapshot: ["jsonb", "NO"],
        result: ["jsonb", "NO"],
        created_by: ["uuid", "NO"],
        created_at: ["timestamptz", "NO"],
      },
    };

    for (const table of NEW_TABLES) {
      const columns = await columnsOf(table);
      for (const [name, [type, nullable]] of Object.entries(expected[table])) {
        const column = columns.get(name);
        expect(column, `${table}.${name} fehlt.`).toBeDefined();
        expect(column?.udt_name, `${table}.${name}: falscher PostgreSQL-Typ.`).toBe(type);
        expect(column?.is_nullable, `${table}.${name}: falsche NULL-Grenze.`).toBe(nullable);
      }
    }
  });

  it("erzwingt den vollständigen tenantgebundenen Fachgraph per validierten Composite-FKs", async () => {
    const rows = await foreignKeys();

    expectForeignKey(rows, "site_energy_profile", ["workspace_id"], "workspace", ["id"]);
    expectForeignKey(rows, "site_energy_profile", ["workspace_id", "site_id"], "site", ["workspace_id", "id"]);
    expectForeignKey(
      rows,
      "site_energy_profile",
      ["workspace_id", "source_project_id", "site_id"],
      "project",
      ["workspace_id", "id", "site_id"],
    );
    expectForeignKey(
      rows,
      "site_energy_profile",
      ["workspace_id", "source_snapshot_id", "source_project_id"],
      "calculator_snapshot",
      ["workspace_id", "id", "project_id"],
    );
    expectForeignKey(
      rows,
      "site_energy_profile",
      ["workspace_id", "confirmed_by"],
      "membership",
      ["workspace_id", "user_id"],
    );

    for (const table of ["project_calculation_job", "project_calculation_revision"] as const) {
      expectForeignKey(rows, table, ["workspace_id"], "workspace", ["id"]);
      expectForeignKey(
        rows,
        table,
        ["workspace_id", "project_id", "site_id"],
        "project",
        ["workspace_id", "id", "site_id"],
      );
      expectForeignKey(
        rows,
        table,
        ["workspace_id", "profile_id", "site_id"],
        "site_energy_profile",
        ["workspace_id", "id", "site_id"],
      );
      expectForeignKey(
        rows,
        table,
        ["workspace_id", "requirement_id", "project_id", "requirement_revision"],
        "project_requirement",
        ["workspace_id", "id", "project_id", "revision"],
      );
      expectForeignKey(
        rows,
        table,
        ["workspace_id", "source_snapshot_id", "project_id"],
        "calculator_snapshot",
        ["workspace_id", "id", "project_id"],
      );
      expectForeignKey(
        rows,
        table,
        ["workspace_id", "created_by"],
        "membership",
        ["workspace_id", "user_id"],
      );
    }

    expectForeignKey(
      rows,
      "project_calculation_revision",
      ["workspace_id", "job_id", "project_id", "site_id"],
      "project_calculation_job",
      ["workspace_id", "id", "project_id", "site_id"],
    );
    expectForeignKey(
      rows,
      "project_calculation_job",
      ["workspace_id", "result_revision_id", "project_id", "site_id"],
      "project_calculation_revision",
      ["workspace_id", "id", "project_id", "site_id"],
    );
  });

  it("legt die 1:1-, Idempotenz-, aktive-Job- und Claim-Indizes an", async () => {
    const rows = await indexes();

    expectIndex(rows, "project", "project_ws_id_site_uq", ["workspace_id", "id", "site_id"], true);
    expectIndex(
      rows,
      "project_requirement",
      "project_requirement_ws_id_project_revision_uq",
      ["workspace_id", "id", "project_id", "revision"],
      true,
    );
    expectIndex(rows, "site_energy_profile", "site_energy_profile_ws_id_uq", ["workspace_id", "id"], true);
    expectIndex(rows, "site_energy_profile", "site_energy_profile_ws_site_uq", ["workspace_id", "site_id"], true);
    expectIndex(
      rows,
      "site_energy_profile",
      "site_energy_profile_ws_id_site_uq",
      ["workspace_id", "id", "site_id"],
      true,
    );
    expectIndex(rows, "project_calculation_job", "project_calculation_job_ws_id_uq", ["workspace_id", "id"], true);
    expectIndex(
      rows,
      "project_calculation_job",
      "project_calculation_job_ws_id_project_site_uq",
      ["workspace_id", "id", "project_id", "site_id"],
      true,
    );
    expectIndex(
      rows,
      "project_calculation_job",
      "project_calculation_job_ws_project_reservation_uq",
      ["workspace_id", "project_id", "reservation_key"],
      true,
    );
    const active = expectIndex(
      rows,
      "project_calculation_job",
      "project_calculation_job_ws_project_active_uq",
      ["workspace_id", "project_id"],
      true,
    );
    const activePredicate = normalizeSql(active.predicate);
    for (const state of ["queued", "running", "retry_wait"]) {
      expect(activePredicate, `Aktivindex erfasst ${state} nicht.`).toContain(`'${state}'`);
    }
    for (const terminal of ["succeeded", "failed_final"]) {
      expect(activePredicate, `Aktivindex erfasst terminalen Zustand ${terminal}.`).not.toContain(`'${terminal}'`);
    }
    expectIndex(
      rows,
      "project_calculation_job",
      "project_calculation_job_due_idx",
      ["workspace_id", "state", "next_attempt_at", "created_at", "id"],
      false,
    );
    expectIndex(
      rows,
      "project_calculation_revision",
      "project_calculation_revision_ws_id_uq",
      ["workspace_id", "id"],
      true,
    );
    expectIndex(
      rows,
      "project_calculation_revision",
      "project_calculation_revision_ws_id_project_site_uq",
      ["workspace_id", "id", "project_id", "site_id"],
      true,
    );
    expectIndex(
      rows,
      "project_calculation_revision",
      "project_calculation_revision_ws_project_revision_uq",
      ["workspace_id", "project_id", "revision"],
      true,
    );
    expectIndex(
      rows,
      "project_calculation_revision",
      "project_calculation_revision_ws_job_uq",
      ["workspace_id", "job_id"],
      true,
    );
    expectIndex(
      rows,
      "project_calculation_revision",
      "project_calculation_revision_ws_project_input_engine_uq",
      [
        "workspace_id",
        "project_id",
        "input_sha256",
        "model_id",
        "model_version",
        "source_revision",
        "defaults_version",
      ],
      true,
    );
  });

  it("aktiviert und erzwingt RLS mit genau einer kanonischen Tenant-Policy", async () => {
    const { rows } = await testPool.query<{
      table_name: string;
      rls: boolean;
      force_rls: boolean;
      policy_name: string | null;
      command: string | null;
      permissive: string | null;
      roles: string[] | null;
      using_expression: string | null;
      check_expression: string | null;
    }>(`
      select table_row.relname as table_name,
             table_row.relrowsecurity as rls,
             table_row.relforcerowsecurity as force_rls,
             policy.policyname as policy_name,
             policy.cmd as command,
             policy.permissive,
             policy.roles::text[] as roles,
             policy.qual as using_expression,
             policy.with_check as check_expression
        from pg_catalog.pg_class table_row
        join pg_catalog.pg_namespace namespace_row
          on namespace_row.oid = table_row.relnamespace
        left join pg_catalog.pg_policies policy
          on policy.schemaname = namespace_row.nspname
         and policy.tablename = table_row.relname
       where namespace_row.nspname = 'public'
         and table_row.relname = any($1::text[])
       order by table_row.relname, policy.policyname
    `, [NEW_TABLES]);

    expect(rows).toHaveLength(NEW_TABLES.length);
    for (const table of NEW_TABLES) {
      const row = rows.find((entry) => entry.table_name === table);
      expect(row, `${table}: Katalogzeile fehlt.`).toBeDefined();
      expect(row?.rls, `${table}: RLS nicht aktiviert.`).toBe(true);
      expect(row?.force_rls, `${table}: FORCE RLS fehlt.`).toBe(true);
      expect(row?.policy_name, `${table}: falsche Policy.`).toBe("tenant_isolation");
      expect(row?.command, `${table}: Policy gilt nicht für ALL.`).toBe("ALL");
      expect(row?.permissive, `${table}: Policy ist nicht permissive.`).toBe("PERMISSIVE");
      expect(row?.roles, `${table}: Policy gilt nicht für PUBLIC.`).toEqual(["public"]);
      const tenantPredicate = "workspace_id=(nullif(current_setting('app.workspace_id'::text,true),''::text))::uuid";
      expect(normalizeSql(row?.using_expression ?? null)).toBe(`(${tenantPredicate})`);
      expect(normalizeSql(row?.check_expression ?? null)).toBe(`(${tenantPredicate})`);
    }
  });

  it("erteilt PUBLIC keinerlei Rechte auf den neuen Fachrelationen", async () => {
    const { rows } = await testPool.query<{
      table_name: string;
      privileges: string[] | null;
    }>(`
      select table_row.relname as table_name,
             array_agg(acl.privilege_type order by acl.privilege_type)
               filter (where acl.grantee = 0) as privileges
        from pg_catalog.pg_class table_row
        join pg_catalog.pg_namespace namespace_row
          on namespace_row.oid = table_row.relnamespace
        left join lateral pg_catalog.aclexplode(
          coalesce(table_row.relacl, pg_catalog.acldefault('r', table_row.relowner))
        ) acl on true
       where namespace_row.nspname = 'public'
         and table_row.relname = any($1::text[])
       group by table_row.relname
       order by table_row.relname
    `, [NEW_TABLES]);
    expect(rows).toHaveLength(NEW_TABLES.length);
    for (const row of rows) {
      expect(row.privileges ?? [], `${row.table_name}: PUBLIC besitzt Tabellenrechte.`).toEqual([]);
    }
  });
});

describe.sequential("site_energy_profile: operative, revisionsgebundene Site-Wahrheit", () => {
  it("erzwingt Version, Modus, positive Revision, 32-Byte-Hash und Quell-/Confirmationform", async () => {
    const graph = await createProjectGraph("M107 Profilchecks");
    const profile = energyProfile();
    const hash = sha256Hex(profile);

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      insert into site_energy_profile (
        workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256
      ) values (
        ${graph.workspaceId}::uuid, ${graph.siteId}::uuid, 0,
        ${PROFILE_SCHEMA_VERSION}, 'consumption', 'rechner_snapshot',
        ${graph.snapshotId}::uuid, ${graph.projectId}::uuid, 1,
        ${JSON.stringify(profile)}::jsonb, decode(${hash}, 'hex')
      )
    `)), /check constraint|revision/i);

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      insert into site_energy_profile (
        workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256
      ) values (
        ${graph.workspaceId}::uuid, ${graph.siteId}::uuid, 1,
        ${PROFILE_SCHEMA_VERSION}, 'manual', 'rechner_snapshot',
        ${graph.snapshotId}::uuid, ${graph.projectId}::uuid, 1,
        ${JSON.stringify(profile)}::jsonb, decode(${hash}, 'hex')
      )
    `)), /check constraint|input_mode/i);

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      insert into site_energy_profile (
        workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256
      ) values (
        ${graph.workspaceId}::uuid, ${graph.siteId}::uuid, 1,
        ${PROFILE_SCHEMA_VERSION}, 'consumption', 'manual',
        ${graph.snapshotId}::uuid, ${graph.projectId}::uuid, 1,
        ${JSON.stringify(profile)}::jsonb, decode(${hash}, 'hex')
      )
    `)), /check constraint|source/i);

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      insert into site_energy_profile (
        workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256
      ) values (
        ${graph.workspaceId}::uuid, ${graph.siteId}::uuid, 1,
        ${PROFILE_SCHEMA_VERSION}, 'consumption', 'rechner_snapshot',
        null, null, 1, ${JSON.stringify(profile)}::jsonb,
        decode(${hash}, 'hex')
      )
    `)), /check constraint|source/i);

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      insert into site_energy_profile (
        workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256
      ) values (
        ${graph.workspaceId}::uuid, ${graph.siteId}::uuid, 1,
        ${PROFILE_SCHEMA_VERSION}, 'consumption', 'rechner_snapshot',
        ${graph.snapshotId}::uuid, ${graph.projectId}::uuid, 1,
        ${JSON.stringify(profile)}::jsonb, decode(repeat('ab', 31), 'hex')
      )
    `)), /check constraint|hash/i);

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      insert into site_energy_profile (
        workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256, confirmed_profile_revision
      ) values (
        ${graph.workspaceId}::uuid, ${graph.siteId}::uuid, 1,
        ${PROFILE_SCHEMA_VERSION}, 'consumption', 'rechner_snapshot',
        ${graph.snapshotId}::uuid, ${graph.projectId}::uuid, 1,
        ${JSON.stringify(profile)}::jsonb, decode(${hash}, 'hex'), 1
      )
    `)), /check constraint|confirmation|confirmed/i);

    const inserted = await insertProfile(graph);
    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("hält genau eine operative Zeile je Site", async () => {
    const graph = await createProjectGraph("M107 Profil 1zu1");
    await insertProfile(graph);
    await expectPgRejection(insertProfile(graph), /site_energy_profile_ws_site_uq|unique/i);
  });

  it("erlaubt nur Confirm oder Save-N+1 und setzt Confirmation beim Save vollständig zurück", async () => {
    const graph = await createProjectGraph("M107 Profilzustand");
    const row = await insertProfile(graph);
    await confirmProfile(graph, row.id);

    const confirmed = await withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute<{
      revision: number;
      confirmed_profile_revision: number | null;
      confirmed_address_revision: number | null;
      confirmed_by: string | null;
      profile_sha256: Buffer;
      [key: string]: unknown;
    }>(sql`
      select revision, confirmed_profile_revision, confirmed_address_revision,
             confirmed_by, profile_sha256
        from site_energy_profile
       where id = ${row.id}::uuid
    `));
    expect(confirmed.rows[0]).toMatchObject({
      revision: 1,
      confirmed_profile_revision: 1,
      confirmed_address_revision: 1,
      confirmed_by: graph.actorId,
    });
    expect(Buffer.from(confirmed.rows[0].profile_sha256).toString("hex")).toBe(row.profileSha256Hex);

    const changed = structuredClone(row.profile);
    changed.roofs[0].areaM2 = 60;
    const changedHash = sha256Hex(changed);
    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      update site_energy_profile
         set profile = ${JSON.stringify(changed)}::jsonb,
             profile_sha256 = decode(${changedHash}, 'hex')
       where id = ${row.id}::uuid
    `)), /mutation|revision|unveraenderlich|constraint/i);

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      update site_energy_profile
         set revision = revision + 1,
             profile = ${JSON.stringify(changed)}::jsonb,
             profile_sha256 = decode(${changedHash}, 'hex')
       where id = ${row.id}::uuid
    `)), /confirmation|mutation|revision|constraint/i);

    await withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      update site_energy_profile
         set revision = revision + 1,
             profile = ${JSON.stringify(changed)}::jsonb,
             profile_sha256 = decode(${changedHash}, 'hex'),
             confirmed_profile_revision = null,
             confirmed_address_revision = null,
             confirmed_by = null,
             confirmed_at = null,
             updated_at = now()
       where id = ${row.id}::uuid
    `));

    const saved = await withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute<{
      revision: number;
      confirmed_profile_revision: number | null;
      confirmed_address_revision: number | null;
      confirmed_by: string | null;
      confirmed_at: Date | null;
      [key: string]: unknown;
    }>(sql`
      select revision, confirmed_profile_revision, confirmed_address_revision,
             confirmed_by, confirmed_at
        from site_energy_profile
       where id = ${row.id}::uuid
    `));
    expect(saved.rows[0]).toEqual({
      revision: 2,
      confirmed_profile_revision: null,
      confirmed_address_revision: null,
      confirmed_by: null,
      confirmed_at: null,
    });
  });

  it("sperrt DELETE und TRUNCATE unabhängig von RLS", async () => {
    const graph = await createProjectGraph("M107 Profilschutz");
    const row = await insertProfile(graph);
    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      delete from site_energy_profile where id = ${row.id}::uuid
    `)), /mutation|delete|unveraenderlich|forbid/i);

    const { rows } = await testPool.query<{ tgname: string }>(`
      select tgname
        from pg_catalog.pg_trigger
       where tgrelid = 'site_energy_profile'::regclass
         and not tgisinternal
       order by tgname
    `);
    expect(rows.map((entry) => entry.tgname)).toEqual(expect.arrayContaining([
      "site_energy_profile_mutation_guard",
      "site_energy_profile_no_truncate",
    ]));
  });
});

describe.sequential("project_calculation_job: Reservation, Lease und einmaliger Input", () => {
  it("bindet Reservation und höchstens einen aktiven Job je Project", async () => {
    const graph = await createProjectGraph("M107 Job-Unique");
    const profile = await insertProfile(graph);
    await confirmProfile(graph, profile.id);
    const first = await insertJob(graph, profile.id);

    await expectPgRejection(
      insertJob(graph, profile.id),
      /project_calculation_job_ws_project_active_uq|unique/i,
    );

    await claimAndSetInput(graph, first.id);
    await withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      update project_calculation_job
         set state = 'failed_final',
             error_code = 'provider_invalid',
             error_retryable = false,
             finished_at = ${NOW_ISO}::timestamptz,
             lease_token = null,
             lease_expires_at = null
       where id = ${first.id}::uuid
    `));

    await expectPgRejection(
      insertJob(graph, profile.id, { reservationKeyHex: first.reservationKeyHex }),
      /project_calculation_job_ws_project_reservation_uq|unique/i,
    );
    await expect(insertJob(graph, profile.id)).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it("sperrt Bindungen und lässt Input-/Provider-Snapshot nur einmalig oder identisch setzen", async () => {
    const graph = await createProjectGraph("M107 Job-Mutation");
    const profile = await insertProfile(graph);
    await confirmProfile(graph, profile.id);
    const job = await insertJob(graph, profile.id);

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      update project_calculation_job
         set defaults_version = 'manipuliert.v2'
       where id = ${job.id}::uuid
    `)), /mutation|binding|unveraenderlich|immutable/i);

    const inputHash = await claimAndSetInput(graph, job.id);
    const inputSnapshot = {
      contractVersion: CONTRACT_VERSION,
      canonicalizationVersion: "planning-jcs.v1",
      bindings: {
        workspaceId: graph.workspaceId,
        projectId: graph.projectId,
        siteId: graph.siteId,
      },
    };
    const providerSnapshot = {
      provider: "PVGIS",
      apiVersion: "5.3",
      recipeVersion: PROVIDER_RECIPE_VERSION,
    };

    await expect(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      update project_calculation_job
         set input_sha256 = decode(${inputHash}, 'hex'),
             input_snapshot = ${JSON.stringify(inputSnapshot)}::jsonb,
             provider_snapshot = ${JSON.stringify(providerSnapshot)}::jsonb
       where id = ${job.id}::uuid
    `))).resolves.toBeDefined();

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      update project_calculation_job
         set input_sha256 = decode(${sha256Hex("anderer-input")}, 'hex'),
             input_snapshot = '{"contractVersion":"manipuliert"}'::jsonb
       where id = ${job.id}::uuid
    `)), /input|snapshot|mutation|unveraenderlich|immutable/i);

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      delete from project_calculation_job where id = ${job.id}::uuid
    `)), /mutation|delete|unveraenderlich|forbid/i);
  });

  it("erlaubt nur die definierte Zustandsmaschine und konsistente Bindungsrevisionen", async () => {
    const graph = await createProjectGraph("M107 Job-State");
    const profile = await insertProfile(graph);
    await confirmProfile(graph, profile.id);
    const job = await insertJob(graph, profile.id);

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      update project_calculation_job
         set state = 'succeeded', finished_at = now()
       where id = ${job.id}::uuid
    `)), /state|zustand|transition|constraint|result/i);

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      insert into project_calculation_job (
        workspace_id, project_id, site_id,
        address_revision, pin_confirmed_address_revision,
        profile_id, profile_revision, confirmed_profile_revision,
        confirmed_address_revision, requirement_id, requirement_revision,
        source_snapshot_id, reservation_key, provider_recipe_version,
        contract_version, model_id, model_version, source_revision,
        defaults_version, state, attempt_count, next_attempt_at, created_by
      ) values (
        ${graph.workspaceId}::uuid, ${graph.projectId}::uuid, ${graph.siteId}::uuid,
        1, 1, ${profile.id}::uuid, 1, 2, 1,
        ${graph.requirementId}::uuid, 1, ${graph.snapshotId}::uuid,
        decode(${sha256Hex("mismatch")}, 'hex'), ${PROVIDER_RECIPE_VERSION},
        ${CONTRACT_VERSION}, ${MODEL_ID}, ${MODEL_VERSION}, ${SOURCE_REVISION},
        ${DEFAULTS_VERSION}, 'queued', 0, ${NOW_ISO}::timestamptz,
        ${graph.actorId}::uuid
      )
    `)), /check constraint|revision|confirmation/i);
  });

  it("installiert Mutation- und TRUNCATE-Guards", async () => {
    const { rows } = await testPool.query<{ tgname: string }>(`
      select tgname
        from pg_catalog.pg_trigger
       where tgrelid = 'project_calculation_job'::regclass
         and not tgisinternal
       order by tgname
    `);
    expect(rows.map((entry) => entry.tgname)).toEqual(expect.arrayContaining([
      "project_calculation_job_mutation_guard",
      "project_calculation_job_no_truncate",
    ]));
  });
});

describe.sequential("project_calculation_revision: ausschließlich validierte immutable Resultate", () => {
  it("persistiert nur das ehrliche Qualitäts-/Validierungslabel und 32-Byte-Hashes", async () => {
    const graph = await createProjectGraph("M107 Result-Vertrag");
    const profile = await insertProfile(graph);
    await confirmProfile(graph, profile.id);
    const job = await insertJob(graph, profile.id);
    const inputHash = await claimAndSetInput(graph, job.id);

    await expectPgRejection(
      insertRevision(graph, profile.id, job.id, inputHash, {
        validationStatus: "passed",
      }),
      /check constraint|validation_status|not_f4_reference_validated/i,
    );

    const revision = await insertRevision(graph, profile.id, job.id, inputHash);
    await finishJob(graph, job.id, revision.id);
    const { rows } = await withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute<{
      quality: string;
      validation_status: string;
      input_bytes: number;
      result_bytes: number;
      [key: string]: unknown;
    }>(sql`
      select quality, validation_status,
             octet_length(input_sha256)::int as input_bytes,
             octet_length(result_sha256)::int as result_bytes
        from project_calculation_revision
       where id = ${revision.id}::uuid
    `));
    expect(rows[0]).toEqual({
      quality: "server_reproduced_estimate",
      validation_status: "not_f4_reference_validated",
      input_bytes: 32,
      result_bytes: 32,
    });
  });

  it("ist nach INSERT vollständig append-only und gegen DELETE/TRUNCATE geschützt", async () => {
    const graph = await createProjectGraph("M107 Result Immutable");
    const profile = await insertProfile(graph);
    await confirmProfile(graph, profile.id);
    const job = await insertJob(graph, profile.id);
    const inputHash = await claimAndSetInput(graph, job.id);
    const revision = await insertRevision(graph, profile.id, job.id, inputHash);
    await finishJob(graph, job.id, revision.id);

    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      update project_calculation_revision
         set result = jsonb_set(result, '{quality}', '"reference_validated"'::jsonb)
       where id = ${revision.id}::uuid
    `)), /immutable|mutation|update|unveraenderlich|forbid/i);
    await expectPgRejection(withTenantOn(testPool, graph.workspaceId, (tx) => tx.execute(sql`
      delete from project_calculation_revision where id = ${revision.id}::uuid
    `)), /immutable|mutation|delete|unveraenderlich|forbid/i);

    const { rows } = await testPool.query<{ tgname: string }>(`
      select tgname
        from pg_catalog.pg_trigger
       where tgrelid = 'project_calculation_revision'::regclass
         and not tgisinternal
       order by tgname
    `);
    expect(rows.map((entry) => entry.tgname)).toEqual(expect.arrayContaining([
      "project_calculation_revision_immutable",
      "project_calculation_revision_no_truncate",
    ]));
  });
});

describe.sequential("M1-07: reale Tenant-Isolation der neuen Daten", () => {
  it("blendet Profil, Job und Result eines fremden Workspace vollständig aus", async () => {
    const own = await createProjectGraph("M107 Tenant A");
    const foreign = await createProjectGraph("M107 Tenant B");
    const ownProfile = await insertProfile(own);
    await confirmProfile(own, ownProfile.id);
    const foreignProfile = await insertProfile(foreign);
    await confirmProfile(foreign, foreignProfile.id);
    const foreignJob = await insertJob(foreign, foreignProfile.id);
    const foreignInputHash = await claimAndSetInput(foreign, foreignJob.id);
    const foreignRevision = await insertRevision(
      foreign,
      foreignProfile.id,
      foreignJob.id,
      foreignInputHash,
    );
    await finishJob(foreign, foreignJob.id, foreignRevision.id);

    for (const [table, id] of [
      ["site_energy_profile", foreignProfile.id],
      ["project_calculation_job", foreignJob.id],
      ["project_calculation_revision", foreignRevision.id],
    ] as const) {
      const result = await withTenantOn(testPool, own.workspaceId, (tx) => tx.execute<{
        n: number;
        [key: string]: unknown;
      }>(sql.raw(`select count(*)::int as n from ${table} where id = '${id}'::uuid`)));
      expect(result.rows[0].n, `${table}: fremde Zeile war sichtbar.`).toBe(0);
    }
  });

  it("verhindert einen Cross-Tenant-Insert an der RLS-with-check-Grenze", async () => {
    const own = await createProjectGraph("M107 Cross Tenant A");
    const foreign = await createProjectGraph("M107 Cross Tenant B");
    const profile = energyProfile();
    const hash = sha256Hex(profile);

    await expectPgRejection(withTenantOn(testPool, own.workspaceId, (tx) => tx.execute(sql`
      insert into site_energy_profile (
        workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256
      ) values (
        ${foreign.workspaceId}::uuid, ${foreign.siteId}::uuid, 1,
        ${PROFILE_SCHEMA_VERSION}, 'consumption', 'rechner_snapshot',
        ${foreign.snapshotId}::uuid, ${foreign.projectId}::uuid, 1,
        ${JSON.stringify(profile)}::jsonb, decode(${hash}, 'hex')
      )
    `)), /row-level security|violates row-level security policy/i);
  });
});
