import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type QueryResult } from "pg";
import { expect, it } from "vitest";
import { startEmbeddedPostgres } from "../setup/embedded-postgres";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

type GraphIds = {
  workspaceId: string;
  actorId: string;
  contactId: string;
  siteId: string;
  projectId: string;
  receiptId: string;
  snapshotId: string;
  requirementId: string;
};

type ForeignKeyRow = {
  table_name: string;
  constraint_name: string;
  referenced_table: string;
  local_columns: string[];
  referenced_columns: string[];
};

const M1_06_LAST_MIGRATION_INDEX = 23;
const M1_07_MIGRATION_INDEX = 24;
const M1_06_HISTORY_SHA256 =
  "17f3b5e371b7c2b552b727563335ebc9b8cab4ddc2320d9a4817b1eefbb22ffe";
const NOW_ISO = "2026-08-29T12:00:00.000Z";
const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const HASH_C = "33".repeat(32);

const ENERGY_TABLES = [
  "project_calculation_job",
  "project_calculation_revision",
  "site_energy_profile",
] as const;

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function requireM107Migration(): { idx: number; tag: string; [key: string]: unknown } {
  const entry = migrationJournal().entries.find(
    (candidate) => candidate.idx === M1_07_MIGRATION_INDEX,
  );
  expect(
    entry,
    "M1-07 braucht eine neue additive 0024 nach 0023_loving_justin_hammer.",
  ).toBeDefined();
  expect(entry?.tag).toMatch(/^0024_[a-z0-9_]+$/);
  return entry!;
}

function m106HistorySha256(): string {
  const entries = migrationJournal().entries.filter(
    (entry) => entry.idx <= M1_06_LAST_MIGRATION_INDEX,
  );
  const material = entries
    .map(
      (entry) =>
        `${entry.idx}\0${entry.tag}\0${readFileSync(resolve("drizzle", `${entry.tag}.sql`), "utf8")}`,
    )
    .join("\0");
  return createHash("sha256").update(material).digest("hex");
}

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-m1-07-upgrade-"));
  mkdirSync(join(target, "meta"), { recursive: true });

  const journal = migrationJournal();
  const entries = journal.entries.filter((entry) => entry.idx <= maxIndex);
  if (entries.length !== maxIndex + 1 || entries.at(-1)?.idx !== maxIndex) {
    rmSync(target, { recursive: true, force: true });
    throw new Error(`Migrationspraefix 0..${maxIndex} ist nicht lueckenlos.`);
  }

  for (const entry of entries) {
    cpSync(join(source, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(target, "meta", "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return target;
}

async function tenantQuery<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(
  pool: Pool,
  workspaceId: string,
  query: string,
  values: unknown[] = [],
): Promise<QueryResult<Row>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_catalog.set_config('app.workspace_id', $1, true)",
      [workspaceId],
    );
    const result = await client.query<Row>(query, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function known<T>(value: T, source = "rechner_input") {
  return { status: "known", value, source };
}

function unknown() {
  return { status: "unknown", value: null, source: "not_collected" };
}

function energyProfile(annualConsumptionKwh = 4_200) {
  return {
    schemaVersion: "site-energy-profile.v1",
    inputMode: "consumption",
    building: {
      type: known("single_family"),
      year: known(1998),
      heatedAreaM2: known(145),
    },
    roofs: [
      {
        id: "dach-sued",
        areaM2: 52,
        azimuthDeg: 5,
        tiltDeg: 35,
        type: "pitched",
        shading: known("light"),
        source: "user_drawn",
      },
    ],
    consumption: {
      householdKwhPerYear: known(annualConsumptionKwh, "customer_metered"),
      electricityPriceCentsPerKwh: known(36, "customer_input"),
      annualPriceIncreasePercent: unknown(),
      loadProfile: unknown(),
      evKmPerYear: unknown(),
      evChargingPattern: unknown(),
      heatPumpKwhPerYear: known(0, "customer_input"),
      coolingKwhPerYear: known(0, "customer_input"),
      heatingAcKwhPerYear: known(0, "customer_input"),
      hotWaterKwhPerYear: unknown(),
    },
    existingAssets: {
      pv: { status: "known_absent", source: "rechner_branch" },
      storage: { status: "known_absent", source: "rechner_input" },
      wallbox: { status: "unknown", source: "not_collected" },
      ev: { status: "unknown", source: "not_collected" },
    },
    provenance: {
      source: "rechner_snapshot",
      sourceSchemaVersion: "wmee-solar-snapshot.v1",
      sourceEngine: "wmee-solar.v1",
      roof: "user_drawn",
      consumption: "metered_kwh",
      electricityPrice: "customer",
      annualPriceIncrease: "default",
    },
  };
}

async function insertM106Graph(pool: Pool): Promise<GraphIds> {
  const ids: GraphIds = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
  };

  await tenantQuery(
    pool,
    ids.workspaceId,
    "insert into workspace (id, name) values ($1::uuid, 'M1-07 Migrationstest')",
    [ids.workspaceId],
  );
  await tenantQuery(
    pool,
    ids.workspaceId,
    "insert into user_identity (id, email) values ($1::uuid, $2)",
    [ids.actorId, `m107-${ids.actorId}@example.test`],
  );
  await tenantQuery(
    pool,
    ids.workspaceId,
    `insert into membership (workspace_id, user_id, role)
     values ($1::uuid, $2::uuid, 'editor')`,
    [ids.workspaceId, ids.actorId],
  );
  const contactName = await pool.query<{ available: boolean }>(`
    select exists (
      select 1
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'contact'
         and column_name = 'first_name'
    ) as available
  `);
  const supportsContactName = contactName.rows[0]?.available === true;
  await tenantQuery(
    pool,
    ids.workspaceId,
    supportsContactName
      ? `insert into contact (
           id, workspace_id, display_name, first_name, last_name,
           email_primary, email_normalized
         ) values ($1::uuid, $2::uuid, 'M1-07 Bestand', 'M1-07', 'Bestand', $3, $3)`
      : `insert into contact (
           id, workspace_id, display_name, email_primary, email_normalized
         ) values ($1::uuid, $2::uuid, 'M1-07 Bestand', $3, $3)`,
    [ids.contactId, ids.workspaceId, `lead-${ids.contactId}@example.test`],
  );
  await tenantQuery(
    pool,
    ids.workspaceId,
    `insert into site (
       id, workspace_id, contact_id, label, formatted_address,
       address_fingerprint, address_fingerprint_version, address_mode,
       street, house_number, postal_code, city, country, lat, lng,
       geocode_source, geocode_precision, address_follow_up_required,
       address_revision, pin_confirmed, pin_confirmed_address_revision,
       pin_adjusted
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 'Hausgenauer Standort',
       'Muehlstrasse 8, 69234 Dielheim', decode(repeat('ab', 32), 'hex'),
       1, 'selected', 'Muehlstrasse', '8', '69234', 'Dielheim', 'DE',
       49.28463, 8.73821, 'photon', 'house', false, 1, true, 1, false
     )`,
    [ids.siteId, ids.workspaceId, ids.contactId],
  );

  const lane = await tenantQuery<{
    board_id: string;
    column_id: string;
    [key: string]: unknown;
  }>(
    pool,
    ids.workspaceId,
    `select board.id as board_id, column_row.id as column_id
       from kanban_board board
       join kanban_column column_row
         on column_row.workspace_id = board.workspace_id
        and column_row.board_id = board.id
      where board.workspace_id = $1::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and column_row.is_intake = true`,
    [ids.workspaceId],
  );
  const boardId = lane.rows[0]?.board_id;
  const columnId = lane.rows[0]?.column_id;
  if (!boardId || !columnId) throw new Error("Default-Anfrageboard fehlt.");

  await tenantQuery(
    pool,
    ids.workspaceId,
    `insert into project (
       id, workspace_id, contact_id, site_id, kanban_board_id,
       kanban_column_id, name, phase, outcome, source_key,
       catalog_resolution_status
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
       'M1-07 Bestandsprojekt', 'request', 'open', 'wmee-rechner-v3', 'pending'
     )`,
    [
      ids.projectId,
      ids.workspaceId,
      ids.contactId,
      ids.siteId,
      boardId,
      columnId,
    ],
  );
  await tenantQuery(
    pool,
    ids.workspaceId,
    `insert into inbound_receipt (
       id, workspace_id, source_key, submission_id, contract_version,
       body_sha256, auth_key_id, signed_at, submitted_at, received_at,
       producer_application, producer_git_revision, producer_environment,
       calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
       privacy_notice_version, privacy_notice_url, contact_resolution,
       contact_id, site_id, project_id
     ) values (
       $1::uuid, $2::uuid, 'wmee-rechner-v3', $3::uuid, 'rechner-intake.v1',
       decode(repeat('00', 32), 'hex'), 'm107-migration', now(), now(), now(),
       'wmee-rechner-v3', $4, 'development', 'wmee-solar.v1', '{}'::jsonb,
       'offer_request', 'art_6_1_b_precontractual', 'm107-fixture',
       'https://example.test/privacy', 'created', $5::uuid, $6::uuid, $7::uuid
     )`,
    [
      ids.receiptId,
      ids.workspaceId,
      randomUUID(),
      "0".repeat(40),
      ids.contactId,
      ids.siteId,
      ids.projectId,
    ],
  );

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
  await tenantQuery(
    pool,
    ids.workspaceId,
    `insert into calculator_snapshot (
       id, workspace_id, receipt_id, project_id, schema_version,
       calculator_engine, result_integrity, investment_source, calculated_at,
       snapshot
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'wmee-solar-snapshot.v1',
       'wmee-solar.v1', 'client_reported_unverified', 'market_estimate', now(),
       $5::jsonb
     )`,
    [
      ids.snapshotId,
      ids.workspaceId,
      ids.receiptId,
      ids.projectId,
      JSON.stringify(snapshot),
    ],
  );

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
  await tenantQuery(
    pool,
    ids.workspaceId,
    `insert into project_requirement (
       id, workspace_id, project_id, revision, schema_version,
       source_snapshot_id, requirements
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 1,
       'project-requirements.rechner.v1', $4::uuid, $5::jsonb
     )`,
    [
      ids.requirementId,
      ids.workspaceId,
      ids.projectId,
      ids.snapshotId,
      JSON.stringify(requirements),
    ],
  );

  return ids;
}

function expectedEnergyColumns(): Array<{
  table_name: string;
  column_name: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
}> {
  const table = (
    tableName: string,
    columns: Array<[string, string, "YES" | "NO"]>,
  ) =>
    columns.map(([column_name, udt_name, is_nullable]) => ({
      table_name: tableName,
      column_name,
      udt_name,
      is_nullable,
    }));

  return [
    ...table("project_calculation_job", [
      ["id", "uuid", "NO"],
      ["workspace_id", "uuid", "NO"],
      ["project_id", "uuid", "NO"],
      ["site_id", "uuid", "NO"],
      ["address_revision", "int4", "NO"],
      ["pin_confirmed_address_revision", "int4", "NO"],
      ["profile_id", "uuid", "NO"],
      ["profile_revision", "int4", "NO"],
      ["confirmed_profile_revision", "int4", "NO"],
      ["confirmed_address_revision", "int4", "NO"],
      ["requirement_id", "uuid", "NO"],
      ["requirement_revision", "int4", "NO"],
      ["source_snapshot_id", "uuid", "YES"],
      ["reservation_key", "bytea", "NO"],
      ["provider_recipe_version", "text", "NO"],
      ["contract_version", "text", "NO"],
      ["model_id", "text", "NO"],
      ["model_version", "text", "NO"],
      ["source_revision", "text", "NO"],
      ["defaults_version", "text", "NO"],
      ["state", "text", "NO"],
      ["attempt_count", "int4", "NO"],
      ["next_attempt_at", "timestamptz", "NO"],
      ["lease_token", "uuid", "YES"],
      ["lease_expires_at", "timestamptz", "YES"],
      ["input_sha256", "bytea", "YES"],
      ["input_snapshot", "jsonb", "YES"],
      ["provider_snapshot", "jsonb", "YES"],
      ["error_code", "text", "YES"],
      ["error_retryable", "bool", "YES"],
      ["created_by", "uuid", "NO"],
      ["created_at", "timestamptz", "NO"],
      ["started_at", "timestamptz", "YES"],
      ["finished_at", "timestamptz", "YES"],
      ["result_revision_id", "uuid", "YES"],
      ["preparation_snapshot", "jsonb", "YES"],
      ["preparation_sha256", "bytea", "YES"],
    ]),
    ...table("project_calculation_revision", [
      ["id", "uuid", "NO"],
      ["workspace_id", "uuid", "NO"],
      ["project_id", "uuid", "NO"],
      ["site_id", "uuid", "NO"],
      ["revision", "int4", "NO"],
      ["job_id", "uuid", "NO"],
      ["address_revision", "int4", "NO"],
      ["pin_confirmed_address_revision", "int4", "NO"],
      ["profile_id", "uuid", "NO"],
      ["profile_revision", "int4", "NO"],
      ["confirmed_profile_revision", "int4", "NO"],
      ["confirmed_address_revision", "int4", "NO"],
      ["requirement_id", "uuid", "NO"],
      ["requirement_revision", "int4", "NO"],
      ["source_snapshot_id", "uuid", "YES"],
      ["contract_version", "text", "NO"],
      ["model_id", "text", "NO"],
      ["model_version", "text", "NO"],
      ["source_revision", "text", "NO"],
      ["defaults_version", "text", "NO"],
      ["quality", "text", "NO"],
      ["validation_status", "text", "NO"],
      ["input_sha256", "bytea", "NO"],
      ["result_sha256", "bytea", "NO"],
      ["input_snapshot", "jsonb", "NO"],
      ["provider_snapshot", "jsonb", "NO"],
      ["result", "jsonb", "NO"],
      ["created_by", "uuid", "NO"],
      ["created_at", "timestamptz", "NO"],
    ]),
    ...table("site_energy_profile", [
      ["id", "uuid", "NO"],
      ["workspace_id", "uuid", "NO"],
      ["site_id", "uuid", "NO"],
      ["revision", "int4", "NO"],
      ["schema_version", "text", "NO"],
      ["input_mode", "text", "NO"],
      ["source_kind", "text", "NO"],
      ["source_snapshot_id", "uuid", "YES"],
      ["source_project_id", "uuid", "YES"],
      ["address_revision", "int4", "NO"],
      ["profile", "jsonb", "NO"],
      ["profile_sha256", "bytea", "NO"],
      ["confirmed_profile_revision", "int4", "YES"],
      ["confirmed_address_revision", "int4", "YES"],
      ["confirmed_by", "uuid", "YES"],
      ["confirmed_at", "timestamptz", "YES"],
      ["created_at", "timestamptz", "NO"],
      ["updated_at", "timestamptz", "NO"],
    ]),
  ];
}

async function foreignKeys(pool: Pool): Promise<ForeignKeyRow[]> {
  const result = await pool.query<ForeignKeyRow>(`
    select source.relname as table_name,
           constraint_row.conname as constraint_name,
           target.relname as referenced_table,
           array_agg(source_column.attname order by source_key.ordinality)::text[]
             as local_columns,
           array_agg(target_column.attname order by source_key.ordinality)::text[]
             as referenced_columns
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_class source on source.oid = constraint_row.conrelid
      join pg_catalog.pg_class target on target.oid = constraint_row.confrelid
      join unnest(constraint_row.conkey) with ordinality
        as source_key(attnum, ordinality) on true
      join unnest(constraint_row.confkey) with ordinality
        as target_key(attnum, ordinality)
        on target_key.ordinality = source_key.ordinality
      join pg_catalog.pg_attribute source_column
        on source_column.attrelid = source.oid
       and source_column.attnum = source_key.attnum
      join pg_catalog.pg_attribute target_column
        on target_column.attrelid = target.oid
       and target_column.attnum = target_key.attnum
     where constraint_row.contype = 'f'
       and source.relnamespace = 'public'::regnamespace
       and source.relname = any($1::text[])
     group by source.relname, constraint_row.conname, target.relname
     order by source.relname, constraint_row.conname
  `, [ENERGY_TABLES]);
  return result.rows;
}

function fkSignature(row: ForeignKeyRow): string {
  return `${row.table_name}(${row.local_columns.join(",")})` +
    `->${row.referenced_table}(${row.referenced_columns.join(",")})`;
}

it("deklariert M1-07 als additive 0024 und laesst 0000 bis 0023 bytegenau unveraendert", () => {
  const journal = migrationJournal();
  expect(
    journal.entries
      .filter((entry) => entry.idx <= M1_06_LAST_MIGRATION_INDEX)
      .map((entry) => entry.idx),
  ).toEqual(Array.from({ length: 24 }, (_, index) => index));
  expect(m106HistorySha256()).toBe(M1_06_HISTORY_SHA256);

  const m107 = requireM107Migration();
  expect(() => readFileSync(resolve("drizzle", `${m107.tag}.sql`), "utf8")).not.toThrow();
}, 10_000);

it("migriert einen befuellten M1-06-Bestand additiv und ohne erfundene Profile oder Laeufe", async () => {
  requireM107Migration();
  const embedded = await startEmbeddedPostgres();
  const pool = new Pool({ connectionString: embedded.url, max: 2 });
  let prefix: string | undefined;

  try {
    prefix = migrationPrefixThrough(M1_06_LAST_MIGRATION_INDEX);
    await migrate(drizzle(pool), { migrationsFolder: prefix });
    const ids = await insertM106Graph(pool);

    const before = await tenantQuery<{
      project_id: string;
      site_id: string;
      address_revision: number;
      pin_confirmed_address_revision: number;
      requirement_id: string;
      snapshot_id: string;
      [key: string]: unknown;
    }>(pool, ids.workspaceId, `
      select project_row.id as project_id, project_row.site_id,
             site_row.address_revision, site_row.pin_confirmed_address_revision,
             requirement.id as requirement_id, snapshot.id as snapshot_id
        from project project_row
        join site site_row
          on site_row.workspace_id = project_row.workspace_id
         and site_row.id = project_row.site_id
        join project_requirement requirement
          on requirement.workspace_id = project_row.workspace_id
         and requirement.project_id = project_row.id
        join calculator_snapshot snapshot
          on snapshot.workspace_id = project_row.workspace_id
         and snapshot.project_id = project_row.id
       where project_row.id = $1::uuid
    `, [ids.projectId]);

    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

    const after = await tenantQuery(pool, ids.workspaceId, `
      select project_row.id as project_id, project_row.site_id,
             site_row.address_revision, site_row.pin_confirmed_address_revision,
             requirement.id as requirement_id, snapshot.id as snapshot_id
        from project project_row
        join site site_row
          on site_row.workspace_id = project_row.workspace_id
         and site_row.id = project_row.site_id
        join project_requirement requirement
          on requirement.workspace_id = project_row.workspace_id
         and requirement.project_id = project_row.id
        join calculator_snapshot snapshot
          on snapshot.workspace_id = project_row.workspace_id
         and snapshot.project_id = project_row.id
       where project_row.id = $1::uuid
    `, [ids.projectId]);
    expect(after.rows).toEqual(before.rows);

    const emptyM107State = await tenantQuery<{
      profiles: number;
      jobs: number;
      revisions: number;
      [key: string]: unknown;
    }>(pool, ids.workspaceId, `
      select (select count(*)::int from site_energy_profile) as profiles,
             (select count(*)::int from project_calculation_job) as jobs,
             (select count(*)::int from project_calculation_revision) as revisions
    `);
    expect(emptyM107State.rows).toEqual([{ profiles: 0, jobs: 0, revisions: 0 }]);

    const additiveIndexes = await pool.query<{ indexname: string }>(`
      select indexname
        from pg_catalog.pg_indexes
       where schemaname = 'public'
         and indexname in (
           'project_ws_id_site_uq',
           'project_requirement_ws_id_project_revision_uq'
         )
       order by indexname
    `);
    expect(additiveIndexes.rows.map((row) => row.indexname)).toEqual([
      "project_requirement_ws_id_project_revision_uq",
      "project_ws_id_site_uq",
    ]);
  } finally {
    await pool.end().catch(() => undefined);
    await embedded.stop().catch(() => undefined);
    if (prefix) rmSync(prefix, { recursive: true, force: true });
  }
}, 120_000);

it("installiert Fresh-Schema, Tenantgraph, Queuewaechter und immutable Erfolgsrevision", async () => {
  requireM107Migration();
  const embedded = await startEmbeddedPostgres();
  const pool = new Pool({ connectionString: embedded.url, max: 2 });

  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

    const columns = await pool.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
      is_nullable: "YES" | "NO";
    }>(`
      select table_name, column_name, udt_name, is_nullable
        from information_schema.columns
       where table_schema = 'public'
         and table_name = any($1::text[])
       order by table_name, ordinal_position
    `, [ENERGY_TABLES]);
    expect(columns.rows).toEqual(expectedEnergyColumns());

    const rls = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select relation.relname, relation.relrowsecurity,
             relation.relforcerowsecurity
        from pg_catalog.pg_class relation
       where relation.relnamespace = 'public'::regnamespace
         and relation.relname = any($1::text[])
       order by relation.relname
    `, [ENERGY_TABLES]);
    expect(rls.rows).toEqual(ENERGY_TABLES.map((relname) => ({
      relname,
      relrowsecurity: true,
      relforcerowsecurity: true,
    })));

    const policies = await pool.query<{
      tablename: string;
      policyname: string;
      permissive: string;
      roles: string[];
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(`
      select tablename, policyname, permissive, roles::text[] as roles,
             cmd, qual, with_check
        from pg_catalog.pg_policies
       where schemaname = 'public'
         and tablename = any($1::text[])
       order by tablename, policyname
    `, [ENERGY_TABLES]);
    expect(policies.rows).toHaveLength(ENERGY_TABLES.length);
    for (const policy of policies.rows) {
      expect(policy.policyname, policy.tablename).toBe("tenant_isolation");
      expect(policy.permissive, policy.tablename).toBe("PERMISSIVE");
      expect(policy.roles, policy.tablename).toEqual(["public"]);
      expect(policy.cmd, policy.tablename).toBe("ALL");
      expect(policy.qual, policy.tablename).not.toBeNull();
      expect(policy.with_check, policy.tablename).toBe(policy.qual);
      expect(policy.qual, policy.tablename).toContain("workspace_id");
      expect(policy.qual, policy.tablename).toContain("current_setting");
      expect(policy.qual, policy.tablename).toContain("app.workspace_id");
      expect(policy.qual?.toLowerCase(), policy.tablename).not.toContain(" or ");
    }

    const publicTableAcl = await pool.query<{
      table_name: string;
      privilege_type: string;
    }>(`
      select table_name, privilege_type
        from information_schema.table_privileges
       where table_schema = 'public'
         and table_name = any($1::text[])
         and grantee = 'PUBLIC'
       order by table_name, privilege_type
    `, [ENERGY_TABLES]);
    expect(publicTableAcl.rows).toEqual([]);

    const indexes = await pool.query<{ indexname: string; indexdef: string }>(`
      select indexname, indexdef
        from pg_catalog.pg_indexes
       where schemaname = 'public'
         and indexname in (
           'project_ws_id_site_uq',
           'project_requirement_ws_id_project_revision_uq',
           'site_energy_profile_ws_id_uq',
           'site_energy_profile_ws_id_site_uq',
           'site_energy_profile_ws_site_uq',
           'project_calculation_job_ws_id_uq',
           'project_calculation_job_ws_id_project_site_uq',
           'project_calculation_job_ws_project_reservation_uq',
           'project_calculation_job_ws_project_active_uq',
           'project_calculation_job_due_idx',
           'project_calculation_revision_ws_id_uq',
           'project_calculation_revision_ws_id_project_site_uq',
           'project_calculation_revision_ws_project_revision_uq',
           'project_calculation_revision_ws_job_uq',
           'project_calculation_revision_ws_project_input_engine_uq'
         )
       order by indexname
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "project_calculation_job_due_idx",
      "project_calculation_job_ws_id_project_site_uq",
      "project_calculation_job_ws_id_uq",
      "project_calculation_job_ws_project_active_uq",
      "project_calculation_job_ws_project_reservation_uq",
      "project_calculation_revision_ws_id_project_site_uq",
      "project_calculation_revision_ws_id_uq",
      "project_calculation_revision_ws_job_uq",
      "project_calculation_revision_ws_project_input_engine_uq",
      "project_calculation_revision_ws_project_revision_uq",
      "project_requirement_ws_id_project_revision_uq",
      "project_ws_id_site_uq",
      "site_energy_profile_ws_id_site_uq",
      "site_energy_profile_ws_id_uq",
      "site_energy_profile_ws_site_uq",
    ]);
    const activeIndex = indexes.rows.find(
      (row) => row.indexname === "project_calculation_job_ws_project_active_uq",
    )?.indexdef.toLowerCase();
    expect(activeIndex).toContain("unique");
    for (const state of ["queued", "running", "retry_wait"]) {
      expect(activeIndex).toContain(state);
    }
    expect(activeIndex).not.toContain("succeeded");
    expect(activeIndex).not.toContain("failed_final");
    const dueIndex = indexes.rows.find(
      (row) => row.indexname === "project_calculation_job_due_idx",
    )?.indexdef.replaceAll('"', "").toLowerCase();
    expect(dueIndex).toContain(
      "(workspace_id, state, next_attempt_at, created_at, id)",
    );

    const fks = await foreignKeys(pool);
    for (const fk of fks) {
      if (fk.referenced_table === "workspace") {
        expect(fk.local_columns, fk.constraint_name).toEqual(["workspace_id"]);
        expect(fk.referenced_columns, fk.constraint_name).toEqual(["id"]);
        continue;
      }
      expect(fk.local_columns[0], fk.constraint_name).toBe("workspace_id");
      expect(fk.referenced_columns[0], fk.constraint_name).toBe("workspace_id");
    }
    expect(fks.map(fkSignature)).toEqual(expect.arrayContaining([
      "site_energy_profile(workspace_id,site_id)->site(workspace_id,id)",
      "site_energy_profile(workspace_id,source_project_id,site_id)->project(workspace_id,id,site_id)",
      "site_energy_profile(workspace_id,source_snapshot_id,source_project_id)->calculator_snapshot(workspace_id,id,project_id)",
      "site_energy_profile(workspace_id,confirmed_by)->membership(workspace_id,user_id)",
      "project_calculation_job(workspace_id,project_id,site_id)->project(workspace_id,id,site_id)",
      "project_calculation_job(workspace_id,profile_id,site_id)->site_energy_profile(workspace_id,id,site_id)",
      "project_calculation_job(workspace_id,requirement_id,project_id,requirement_revision)->project_requirement(workspace_id,id,project_id,revision)",
      "project_calculation_job(workspace_id,source_snapshot_id,project_id)->calculator_snapshot(workspace_id,id,project_id)",
      "project_calculation_job(workspace_id,created_by)->membership(workspace_id,user_id)",
      "project_calculation_job(workspace_id,result_revision_id,project_id,site_id)->project_calculation_revision(workspace_id,id,project_id,site_id)",
      "project_calculation_revision(workspace_id,project_id,site_id)->project(workspace_id,id,site_id)",
      "project_calculation_revision(workspace_id,job_id,project_id,site_id)->project_calculation_job(workspace_id,id,project_id,site_id)",
      "project_calculation_revision(workspace_id,profile_id,site_id)->site_energy_profile(workspace_id,id,site_id)",
      "project_calculation_revision(workspace_id,requirement_id,project_id,requirement_revision)->project_requirement(workspace_id,id,project_id,revision)",
      "project_calculation_revision(workspace_id,source_snapshot_id,project_id)->calculator_snapshot(workspace_id,id,project_id)",
      "project_calculation_revision(workspace_id,created_by)->membership(workspace_id,user_id)",
    ]));

    const triggers = await pool.query<{
      table_name: string;
      trigger_name: string;
      public_execute: boolean;
    }>(`
      select relation.relname as table_name, trigger_row.tgname as trigger_name,
             exists (
               select 1
                 from pg_catalog.aclexplode(
                   coalesce(
                     function_row.proacl,
                     pg_catalog.acldefault('f', function_row.proowner)
                   )
                 ) acl
                where acl.grantee = 0
                  and acl.privilege_type = 'EXECUTE'
             ) as public_execute
        from pg_catalog.pg_trigger trigger_row
        join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
        join pg_catalog.pg_proc function_row on function_row.oid = trigger_row.tgfoid
       where not trigger_row.tgisinternal
         and relation.relnamespace = 'public'::regnamespace
         and relation.relname = any($1::text[])
       order by relation.relname, trigger_row.tgname
    `, [ENERGY_TABLES]);
    expect(triggers.rows).toEqual([
      {
        table_name: "project_calculation_job",
        trigger_name: "project_calculation_job_mutation_guard",
        public_execute: false,
      },
      {
        table_name: "project_calculation_job",
        trigger_name: "project_calculation_job_no_truncate",
        public_execute: false,
      },
      {
        table_name: "project_calculation_revision",
        trigger_name: "project_calculation_revision_catalog_stale",
        public_execute: false,
      },
      {
        table_name: "project_calculation_revision",
        trigger_name: "project_calculation_revision_immutable",
        public_execute: false,
      },
      {
        table_name: "project_calculation_revision",
        trigger_name: "project_calculation_revision_no_truncate",
        public_execute: false,
      },
      {
        table_name: "site_energy_profile",
        trigger_name: "site_energy_profile_mutation_guard",
        public_execute: false,
      },
      {
        table_name: "site_energy_profile",
        trigger_name: "site_energy_profile_no_truncate",
        public_execute: false,
      },
    ]);

    const ids = await insertM106Graph(pool);
    const profileId = randomUUID();
    const jobId = randomUUID();
    const resultRevisionId = randomUUID();
    const leaseToken = randomUUID();

    await expect(tenantQuery(pool, ids.workspaceId, `
      insert into site_energy_profile (
        id, workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256, confirmed_profile_revision,
        confirmed_address_revision, confirmed_by, confirmed_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, 1, 'site-energy-profile.v1',
        'consumption', 'manual', $4::uuid, $5::uuid, 1, $6::jsonb,
        decode($7, 'hex'), null, null, null, null
      )
    `, [
      profileId,
      ids.workspaceId,
      ids.siteId,
      ids.snapshotId,
      ids.projectId,
      JSON.stringify(energyProfile()),
      HASH_A,
    ])).rejects.toThrow();

    await tenantQuery(pool, ids.workspaceId, `
      insert into site_energy_profile (
        id, workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256, confirmed_profile_revision,
        confirmed_address_revision, confirmed_by, confirmed_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, 1, 'site-energy-profile.v1',
        'consumption', 'rechner_snapshot', $4::uuid, $5::uuid, 1,
        $6::jsonb, decode($7, 'hex'), null, null, null, null
      )
    `, [
      profileId,
      ids.workspaceId,
      ids.siteId,
      ids.snapshotId,
      ids.projectId,
      JSON.stringify(energyProfile()),
      HASH_A,
    ]);

    await tenantQuery(pool, ids.workspaceId, `
      update site_energy_profile
         set confirmed_profile_revision = revision,
             confirmed_address_revision = address_revision,
             confirmed_by = $2::uuid,
             confirmed_at = now(),
             updated_at = now()
       where id = $1::uuid
    `, [profileId, ids.actorId]);

    await expect(tenantQuery(pool, ids.workspaceId, `
      update site_energy_profile
         set profile = $2::jsonb,
             profile_sha256 = decode($3, 'hex'),
             updated_at = now()
       where id = $1::uuid
    `, [profileId, JSON.stringify(energyProfile(4_300)), HASH_B])).rejects.toThrow();

    await expect(tenantQuery(pool, ids.workspaceId, `
      update site_energy_profile
         set revision = revision + 1,
             profile = $2::jsonb,
             profile_sha256 = decode($3, 'hex'),
             updated_at = now()
       where id = $1::uuid
    `, [profileId, JSON.stringify(energyProfile(4_300)), HASH_B])).rejects.toThrow();

    await tenantQuery(pool, ids.workspaceId, `
      update site_energy_profile
         set revision = revision + 1,
             profile = $2::jsonb,
             profile_sha256 = decode($3, 'hex'),
             confirmed_profile_revision = null,
             confirmed_address_revision = null,
             confirmed_by = null,
             confirmed_at = null,
             updated_at = now()
       where id = $1::uuid
    `, [profileId, JSON.stringify(energyProfile(4_300)), HASH_B]);
    await tenantQuery(pool, ids.workspaceId, `
      update site_energy_profile
         set confirmed_profile_revision = revision,
             confirmed_address_revision = address_revision,
             confirmed_by = $2::uuid,
             confirmed_at = now(),
             updated_at = now()
       where id = $1::uuid
    `, [profileId, ids.actorId]);

    await expect(tenantQuery(
      pool,
      ids.workspaceId,
      "delete from site_energy_profile where id = $1::uuid",
      [profileId],
    )).rejects.toThrow();
    await expect(tenantQuery(
      pool,
      ids.workspaceId,
      "truncate table site_energy_profile",
    )).rejects.toThrow();

    await expect(tenantQuery(pool, ids.workspaceId, `
      insert into project_calculation_job (
        id, workspace_id, project_id, site_id, address_revision,
        pin_confirmed_address_revision, profile_id, profile_revision,
        confirmed_profile_revision, confirmed_address_revision,
        requirement_id, requirement_revision, source_snapshot_id,
        reservation_key, provider_recipe_version, contract_version,
        model_id, model_version, source_revision, defaults_version, state,
        attempt_count, next_attempt_at, created_by
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, $5::uuid, 2, 2, 1,
        $6::uuid, 1, $7::uuid, decode(repeat('44', 31), 'hex'),
        'pvgis-5.3-sarah3.v1', 'planning-calculation.v1', 'wmee-solar',
        '3.0.0', $8, 'wmee-planning-defaults.v1', 'queued', 0, now(), $9::uuid
      )
    `, [
      randomUUID(),
      ids.workspaceId,
      ids.projectId,
      ids.siteId,
      profileId,
      ids.requirementId,
      ids.snapshotId,
      "a".repeat(40),
      ids.actorId,
    ])).rejects.toThrow();

    await tenantQuery(pool, ids.workspaceId, `
      insert into project_calculation_job (
        id, workspace_id, project_id, site_id, address_revision,
        pin_confirmed_address_revision, profile_id, profile_revision,
        confirmed_profile_revision, confirmed_address_revision,
        requirement_id, requirement_revision, source_snapshot_id,
        reservation_key, provider_recipe_version, contract_version,
        model_id, model_version, source_revision, defaults_version, state,
        attempt_count, next_attempt_at, created_by
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, $5::uuid, 2, 2, 1,
        $6::uuid, 1, $7::uuid, decode($8, 'hex'),
        'pvgis-5.3-sarah3.v1', 'planning-calculation.v1', 'wmee-solar',
        '3.0.0', $9, 'wmee-planning-defaults.v1', 'queued', 0, now(), $10::uuid
      )
    `, [
      jobId,
      ids.workspaceId,
      ids.projectId,
      ids.siteId,
      profileId,
      ids.requirementId,
      ids.snapshotId,
      HASH_A,
      "a".repeat(40),
      ids.actorId,
    ]);

    await expect(tenantQuery(pool, ids.workspaceId, `
      insert into project_calculation_job (
        workspace_id, project_id, site_id, address_revision,
        pin_confirmed_address_revision, profile_id, profile_revision,
        confirmed_profile_revision, confirmed_address_revision,
        requirement_id, requirement_revision, source_snapshot_id,
        reservation_key, provider_recipe_version, contract_version,
        model_id, model_version, source_revision, defaults_version, state,
        attempt_count, next_attempt_at, created_by
      ) values (
        $1::uuid, $2::uuid, $3::uuid, 1, 1, $4::uuid, 2, 2, 1,
        $5::uuid, 1, $6::uuid, decode($7, 'hex'),
        'pvgis-5.3-sarah3.v1', 'planning-calculation.v1', 'wmee-solar',
        '3.0.0', $8, 'wmee-planning-defaults.v1', 'queued', 0, now(), $9::uuid
      )
    `, [
      ids.workspaceId,
      ids.projectId,
      ids.siteId,
      profileId,
      ids.requirementId,
      ids.snapshotId,
      HASH_B,
      "a".repeat(40),
      ids.actorId,
    ])).rejects.toThrow();

    await expect(tenantQuery(pool, ids.workspaceId, `
      update project_calculation_job
         set profile_revision = 99
       where id = $1::uuid
    `, [jobId])).rejects.toThrow();
    await expect(tenantQuery(pool, ids.workspaceId, `
      update project_calculation_job
         set state = 'running', attempt_count = 1, started_at = now()
       where id = $1::uuid
    `, [jobId])).rejects.toThrow();

    await tenantQuery(pool, ids.workspaceId, `
      update project_calculation_job
         set state = 'running', attempt_count = 1, started_at = now(),
             lease_token = $2::uuid,
             lease_expires_at = now() + interval '5 minutes'
       where id = $1::uuid
    `, [jobId, leaseToken]);

    const inputSnapshot = {
      contractVersion: "planning-calculation.v1",
      canonicalizationVersion: "planning-jcs.v1",
      bindings: {
        workspaceId: ids.workspaceId,
        projectId: ids.projectId,
        siteId: ids.siteId,
      },
    };
    const providerSnapshot = {
      provider: "pvgis",
      apiVersion: "5_3",
      radiationDatabase: "PVGIS-SARAH3",
    };
    await tenantQuery(pool, ids.workspaceId, `
      update project_calculation_job
         set input_sha256 = decode($2, 'hex'),
             input_snapshot = $3::jsonb,
             provider_snapshot = $4::jsonb
       where id = $1::uuid
    `, [
      jobId,
      HASH_B,
      JSON.stringify(inputSnapshot),
      JSON.stringify(providerSnapshot),
    ]);
    await expect(tenantQuery(pool, ids.workspaceId, `
      update project_calculation_job
         set input_sha256 = decode($2, 'hex'),
             input_snapshot = $3::jsonb,
             provider_snapshot = $4::jsonb
       where id = $1::uuid
    `, [
      jobId,
      HASH_C,
      JSON.stringify({ ...inputSnapshot, changed: true }),
      JSON.stringify(providerSnapshot),
    ])).rejects.toThrow();

    // Zu diesem Zeitpunkt referenziert noch keine Resultrevision den Job. Die
    // Ablehnung beweist deshalb den Job-Guard und nicht nur einen FK-Effekt.
    await expect(tenantQuery(
      pool,
      ids.workspaceId,
      "delete from project_calculation_job where id = $1::uuid",
      [jobId],
    )).rejects.toThrow();
    await expect(tenantQuery(
      pool,
      ids.workspaceId,
      "truncate table project_calculation_job",
    )).rejects.toThrow();

    const result = {
      contractVersion: "planning-calculation.v1",
      inputSha256: HASH_B,
      resultSha256: HASH_C,
      quality: "server_reproduced_estimate",
      validationStatus: "not_f4_reference_validated",
    };
    await expect(tenantQuery(pool, ids.workspaceId, `
      insert into project_calculation_revision (
        id, workspace_id, project_id, site_id, revision, job_id,
        address_revision, pin_confirmed_address_revision, profile_id,
        profile_revision, confirmed_profile_revision,
        confirmed_address_revision, requirement_id, requirement_revision,
        source_snapshot_id, contract_version, model_id, model_version,
        source_revision, defaults_version, quality, validation_status,
        input_sha256, result_sha256, input_snapshot, provider_snapshot,
        result, created_by
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::uuid, 1, 1,
        $6::uuid, 2, 2, 1, $7::uuid, 1, $8::uuid,
        'planning-calculation.v1', 'wmee-solar', '3.0.0', $9,
        'wmee-planning-defaults.v1', 'server_reproduced_estimate', 'passed',
        decode($10, 'hex'), decode($11, 'hex'), $12::jsonb, $13::jsonb,
        $14::jsonb, $15::uuid
      )
    `, [
      resultRevisionId,
      ids.workspaceId,
      ids.projectId,
      ids.siteId,
      jobId,
      profileId,
      ids.requirementId,
      ids.snapshotId,
      "a".repeat(40),
      HASH_B,
      HASH_C,
      JSON.stringify(inputSnapshot),
      JSON.stringify(providerSnapshot),
      JSON.stringify(result),
      ids.actorId,
    ])).rejects.toThrow();

    await tenantQuery(pool, ids.workspaceId, `
      insert into project_calculation_revision (
        id, workspace_id, project_id, site_id, revision, job_id,
        address_revision, pin_confirmed_address_revision, profile_id,
        profile_revision, confirmed_profile_revision,
        confirmed_address_revision, requirement_id, requirement_revision,
        source_snapshot_id, contract_version, model_id, model_version,
        source_revision, defaults_version, quality, validation_status,
        input_sha256, result_sha256, input_snapshot, provider_snapshot,
        result, created_by
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::uuid, 1, 1,
        $6::uuid, 2, 2, 1, $7::uuid, 1, $8::uuid,
        'planning-calculation.v1', 'wmee-solar', '3.0.0', $9,
        'wmee-planning-defaults.v1', 'server_reproduced_estimate',
        'not_f4_reference_validated', decode($10, 'hex'), decode($11, 'hex'),
        $12::jsonb, $13::jsonb, $14::jsonb, $15::uuid
      )
    `, [
      resultRevisionId,
      ids.workspaceId,
      ids.projectId,
      ids.siteId,
      jobId,
      profileId,
      ids.requirementId,
      ids.snapshotId,
      "a".repeat(40),
      HASH_B,
      HASH_C,
      JSON.stringify(inputSnapshot),
      JSON.stringify(providerSnapshot),
      JSON.stringify(result),
      ids.actorId,
    ]);

    await tenantQuery(pool, ids.workspaceId, `
      update project_calculation_job
         set state = 'succeeded', result_revision_id = $2::uuid,
             finished_at = now(), lease_token = null, lease_expires_at = null
       where id = $1::uuid
    `, [jobId, resultRevisionId]);

    // Ein terminaler Lauf gibt den partiellen Active-Slot frei. Der stabile
    // Reservation-Key des alten Laufs bleibt dagegen dauerhaft belegt.
    const nextJobId = randomUUID();
    await tenantQuery(pool, ids.workspaceId, `
      insert into project_calculation_job (
        id, workspace_id, project_id, site_id, address_revision,
        pin_confirmed_address_revision, profile_id, profile_revision,
        confirmed_profile_revision, confirmed_address_revision,
        requirement_id, requirement_revision, source_snapshot_id,
        reservation_key, provider_recipe_version, contract_version,
        model_id, model_version, source_revision, defaults_version, state,
        attempt_count, next_attempt_at, created_by
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, $5::uuid, 2, 2, 1,
        $6::uuid, 1, $7::uuid, decode($8, 'hex'),
        'pvgis-5.3-sarah3.v1', 'planning-calculation.v1', 'wmee-solar',
        '3.0.0', $9, 'wmee-planning-defaults.v1', 'queued', 0, now(), $10::uuid
      )
    `, [
      nextJobId,
      ids.workspaceId,
      ids.projectId,
      ids.siteId,
      profileId,
      ids.requirementId,
      ids.snapshotId,
      HASH_C,
      "a".repeat(40),
      ids.actorId,
    ]);
    await expect(tenantQuery(pool, ids.workspaceId, `
      update project_calculation_revision
         set result = jsonb_set(result, '{changed}', 'true'::jsonb)
       where id = $1::uuid
    `, [resultRevisionId])).rejects.toThrow();
    await expect(tenantQuery(
      pool,
      ids.workspaceId,
      "delete from project_calculation_revision where id = $1::uuid",
      [resultRevisionId],
    )).rejects.toThrow();
    await expect(tenantQuery(
      pool,
      ids.workspaceId,
      "truncate table project_calculation_revision",
    )).rejects.toThrow();
    const foreignTenant = await tenantQuery<{
      profiles: number;
      jobs: number;
      revisions: number;
      [key: string]: unknown;
    }>(pool, randomUUID(), `
      select (select count(*)::int from site_energy_profile) as profiles,
             (select count(*)::int from project_calculation_job) as jobs,
             (select count(*)::int from project_calculation_revision) as revisions
    `);
    expect(foreignTenant.rows).toEqual([{ profiles: 0, jobs: 0, revisions: 0 }]);
  } finally {
    await pool.end().catch(() => undefined);
    await embedded.stop().catch(() => undefined);
  }
}, 120_000);
