import { randomUUID } from "node:crypto";
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

const M1_05_LAST_MIGRATION_INDEX = 22;

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function requireM106Migration(): void {
  const entries = migrationJournal().entries;
  expect(
    entries.some((entry) => entry.idx > M1_05_LAST_MIGRATION_INDEX),
    "M1-06 braucht eine neue forward-only Migration nach 0022_familiar_mojo.",
  ).toBe(true);
}

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-m1-06-upgrade-"));
  mkdirSync(join(target, "meta"), { recursive: true });

  const journal = migrationJournal();
  const entries = journal.entries.filter((entry) => entry.idx <= maxIndex);
  if (entries.length !== maxIndex + 1 || entries.at(-1)?.idx !== maxIndex) {
    rmSync(target, { recursive: true, force: true });
    throw new Error(`Migrationspräfix 0..${maxIndex} ist nicht lückenlos.`);
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

async function tenantQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
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

async function insertM105Graph(pool: Pool, workspaceId: string): Promise<{
  regionalSiteId: string;
  selectedSiteId: string;
  legacySiteId: string;
  projectId: string;
  receiptId: string;
  snapshotId: string;
  requirementId: string;
  columnId: string;
}> {
  const regionalContactId = randomUUID();
  const selectedContactId = randomUUID();
  const legacyContactId = randomUUID();
  const regionalSiteId = randomUUID();
  const selectedSiteId = randomUUID();
  const legacySiteId = randomUUID();
  const projectId = randomUUID();
  const receiptId = randomUUID();
  const snapshotId = randomUUID();
  const requirementId = randomUUID();

  await tenantQuery(pool, workspaceId,
    "insert into workspace (id, name) values ($1::uuid, $2)",
    [workspaceId, "M1-05 Upgradebestand"],
  );
  const lane = await tenantQuery<{
    board_id: string;
    column_id: string;
    [key: string]: unknown;
  }>(pool, workspaceId, `
    select board.id as board_id, column_row.id as column_id
    from kanban_board board
    join kanban_column column_row
      on column_row.workspace_id = board.workspace_id
     and column_row.board_id = board.id
    where board.workspace_id = $1::uuid
      and board.scope = 'residential'
      and board.is_default = true
      and column_row.is_intake = true
  `, [workspaceId]);
  const { board_id: boardId, column_id: columnId } = lane.rows[0];

  await tenantQuery(pool, workspaceId, `
    insert into contact (
      id, workspace_id, display_name, email_primary, email_normalized
    ) values
      ($1::uuid, $4::uuid, 'Regionaler Bestand', 'regional@example.test', 'regional@example.test'),
      ($2::uuid, $4::uuid, 'Exakter Bestand', 'exact@example.test', 'exact@example.test'),
      ($3::uuid, $4::uuid, 'Unsicherer Legacy-Bestand', 'legacy@example.test', 'legacy@example.test')
  `, [regionalContactId, selectedContactId, legacyContactId, workspaceId]);

  await tenantQuery(pool, workspaceId, `
    insert into site (
      id, workspace_id, contact_id, label, formatted_address,
      address_fingerprint, address_fingerprint_version, address_mode,
      street, house_number, postal_code, city, country, lat, lng,
      geocode_source, geocode_precision, address_follow_up_required,
      pin_confirmed
    ) values
      ($1::uuid, $4::uuid, $5::uuid, 'Regional', 'Region Rhein-Neckar',
       null, null, 'regional_estimate', null, null, null, null, 'DE', 49.4, 8.7,
       'regional_default', 'region', true, false),
      ($2::uuid, $4::uuid, $6::uuid, 'Exakt', 'Mühlstraße 8, 69234 Dielheim',
       decode(repeat('ab', 32), 'hex'), 1, 'selected', 'Mühlstraße', '8',
       '69234', 'Dielheim', 'DE', 49.28463, 8.73821,
       'photon', 'house', false, true),
      ($3::uuid, $4::uuid, $7::uuid, 'Unsicherer Legacy-Pin', null,
       null, null, 'legacy', null, null, null, null, 'DE', null, null,
       null, null, false, true)
  `, [
    regionalSiteId,
    selectedSiteId,
    legacySiteId,
    workspaceId,
    regionalContactId,
    selectedContactId,
    legacyContactId,
  ]);

  await tenantQuery(pool, workspaceId, `
    insert into project (
      id, workspace_id, contact_id, site_id, kanban_board_id,
      kanban_column_id, name, phase, outcome, source_key,
      catalog_resolution_status
    ) values (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
      $6::uuid, 'Regionale Bestandsanfrage', 'request', 'open',
      'wmee-rechner-v3', 'pending'
    )
  `, [projectId, workspaceId, regionalContactId, regionalSiteId, boardId, columnId]);

  await tenantQuery(pool, workspaceId, `
    insert into inbound_receipt (
      id, workspace_id, source_key, submission_id, contract_version,
      body_sha256, auth_key_id, signed_at, submitted_at, received_at,
      producer_application, producer_git_revision, producer_environment,
      calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
      privacy_notice_version, privacy_notice_url, contact_resolution,
      contact_id, site_id, project_id
    ) values (
      $1::uuid, $2::uuid, 'wmee-rechner-v3', $3::uuid, 'rechner-intake.v1',
      decode(repeat('00', 32), 'hex'), 'm106-upgrade', now(), now(), now(),
      'wmee-rechner-v3', $4, 'development', 'wmee-solar.v1', '{}'::jsonb,
      'offer_request', 'art_6_1_b_precontractual', 'upgrade-fixture',
      'https://example.test/privacy', 'created', $5::uuid, $6::uuid, $7::uuid
    )
  `, [
    receiptId,
    workspaceId,
    randomUUID(),
    "0".repeat(40),
    regionalContactId,
    regionalSiteId,
    projectId,
  ]);

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
  await tenantQuery(pool, workspaceId, `
    insert into calculator_snapshot (
      id, workspace_id, receipt_id, project_id, schema_version,
      calculator_engine, result_integrity, investment_source, calculated_at,
      snapshot
    ) values (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'wmee-solar-snapshot.v1',
      'wmee-solar.v1', 'client_reported_unverified', 'market_estimate', now(),
      $5::jsonb
    )
  `, [snapshotId, workspaceId, receiptId, projectId, JSON.stringify(snapshot)]);

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
  await tenantQuery(pool, workspaceId, `
    insert into project_requirement (
      id, workspace_id, project_id, revision, schema_version,
      source_snapshot_id, requirements
    ) values (
      $1::uuid, $2::uuid, $3::uuid, 1,
      'project-requirements.rechner.v1', $4::uuid, $5::jsonb
    )
  `, [requirementId, workspaceId, projectId, snapshotId, JSON.stringify(requirements)]);

  return {
    regionalSiteId,
    selectedSiteId,
    legacySiteId,
    projectId,
    receiptId,
    snapshotId,
    requirementId,
    columnId,
  };
}

const NOW_ISO = "2026-08-29T12:00:00.000Z";

it("migriert einen befuellten M1-05-Bestand verlustfrei auf revisionsgebundene Pins", async () => {
  const embedded = await startEmbeddedPostgres();
  const pool = new Pool({ connectionString: embedded.url, max: 2 });
  let prefix: string | undefined;
  const workspaceId = randomUUID();

  try {
    prefix = migrationPrefixThrough(M1_05_LAST_MIGRATION_INDEX);
    await migrate(drizzle(pool), { migrationsFolder: prefix });
    const graph = await insertM105Graph(pool, workspaceId);

    requireM106Migration();
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

    const sites = await tenantQuery<{
      id: string;
      address_mode: string;
      address_revision: number;
      pin_confirmed: boolean;
      pin_confirmed_address_revision: number | null;
      pin_adjusted: boolean;
      geocode_place_id: string | null;
      [key: string]: unknown;
    }>(pool, workspaceId, `
      select id, address_mode, address_revision, pin_confirmed,
             pin_confirmed_address_revision, pin_adjusted, geocode_place_id
      from site
      where id in ($1::uuid, $2::uuid, $3::uuid)
      order by address_mode
    `, [graph.regionalSiteId, graph.selectedSiteId, graph.legacySiteId]);
    expect(sites.rows).toEqual([
      {
        id: graph.legacySiteId,
        address_mode: "legacy",
        address_revision: 1,
        pin_confirmed: false,
        pin_confirmed_address_revision: null,
        pin_adjusted: false,
        geocode_place_id: null,
      },
      {
        id: graph.regionalSiteId,
        address_mode: "regional_estimate",
        address_revision: 1,
        pin_confirmed: false,
        pin_confirmed_address_revision: null,
        pin_adjusted: false,
        geocode_place_id: null,
      },
      {
        id: graph.selectedSiteId,
        address_mode: "selected",
        address_revision: 1,
        pin_confirmed: true,
        pin_confirmed_address_revision: 1,
        pin_adjusted: false,
        geocode_place_id: null,
      },
    ]);

    const preserved = await tenantQuery<{
      project_id: string;
      receipt_id: string;
      receipt_site_id: string;
      snapshot_id: string;
      requirement_id: string;
      phase: string;
      outcome: string;
      column_id: string;
      [key: string]: unknown;
    }>(pool, workspaceId, `
      select project_row.id as project_id, receipt.id as receipt_id,
             receipt.site_id as receipt_site_id, snapshot.id as snapshot_id,
             requirement.id as requirement_id, project_row.phase,
             project_row.outcome, project_row.kanban_column_id as column_id
      from project project_row
      join inbound_receipt receipt
        on receipt.workspace_id = project_row.workspace_id
       and receipt.project_id = project_row.id
      join calculator_snapshot snapshot
        on snapshot.workspace_id = project_row.workspace_id
       and snapshot.project_id = project_row.id
      join project_requirement requirement
        on requirement.workspace_id = project_row.workspace_id
       and requirement.project_id = project_row.id
      where project_row.id = $1::uuid
    `, [graph.projectId]);
    expect(preserved.rows).toEqual([{
      project_id: graph.projectId,
      receipt_id: graph.receiptId,
      receipt_site_id: graph.regionalSiteId,
      snapshot_id: graph.snapshotId,
      requirement_id: graph.requirementId,
      phase: "request",
      outcome: "open",
      column_id: graph.columnId,
    }]);
  } finally {
    await pool.end().catch(() => undefined);
    await embedded.stop().catch(() => undefined);
    if (prefix) rmSync(prefix, { recursive: true, force: true });
  }
}, 120_000);

it("installiert das M1-06-Schema frisch mit sicheren Defaults und Constraints", async () => {
  requireM106Migration();
  const embedded = await startEmbeddedPostgres();
  const pool = new Pool({ connectionString: embedded.url, max: 2 });
  const workspaceId = randomUUID();
  const contactId = randomUUID();
  const regionalSiteId = randomUUID();

  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

    const columns = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      [key: string]: unknown;
    }>(`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'site'
        and column_name in (
          'address_revision',
          'pin_confirmed_address_revision',
          'pin_adjusted',
          'geocode_place_id'
        )
      order by column_name
    `);
    expect(columns.rows).toEqual([
      { column_name: "address_revision", data_type: "integer", is_nullable: "NO" },
      { column_name: "geocode_place_id", data_type: "text", is_nullable: "YES" },
      { column_name: "pin_adjusted", data_type: "boolean", is_nullable: "NO" },
      {
        column_name: "pin_confirmed_address_revision",
        data_type: "integer",
        is_nullable: "YES",
      },
    ]);

    await tenantQuery(pool, workspaceId,
      "insert into workspace (id, name) values ($1::uuid, 'Fresh M1-06')",
      [workspaceId],
    );
    await tenantQuery(pool, workspaceId, `
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values ($1::uuid, $2::uuid, 'Fresh Contact', 'Fresh', 'Contact', 'fresh@example.test', 'fresh@example.test')
    `, [contactId, workspaceId]);
    await tenantQuery(pool, workspaceId, `
      insert into site (
        id, workspace_id, contact_id, formatted_address, address_mode,
        country, lat, lng, geocode_source, geocode_precision,
        address_follow_up_required, pin_confirmed
      ) values (
        $1::uuid, $2::uuid, $3::uuid, 'Region Rhein-Neckar',
        'regional_estimate', 'DE', 49.4, 8.7, 'regional_default',
        'region', true, false
      )
    `, [regionalSiteId, workspaceId, contactId]);
    const defaults = await tenantQuery<{
      address_revision: number;
      pin_confirmed: boolean;
      pin_confirmed_address_revision: number | null;
      pin_adjusted: boolean;
      [key: string]: unknown;
    }>(pool, workspaceId, `
      select address_revision, pin_confirmed, pin_confirmed_address_revision,
             pin_adjusted
      from site where id = $1::uuid
    `, [regionalSiteId]);
    expect(defaults.rows).toEqual([{
      address_revision: 1,
      pin_confirmed: false,
      pin_confirmed_address_revision: null,
      pin_adjusted: false,
    }]);

    await expect(tenantQuery(pool, workspaceId, `
      update site set address_revision = 0 where id = $1::uuid
    `, [regionalSiteId])).rejects.toThrow();

    await expect(tenantQuery(pool, workspaceId, `
      update site
      set pin_confirmed = true,
          pin_confirmed_address_revision = address_revision
      where id = $1::uuid
    `, [regionalSiteId])).rejects.toThrow();

    const rls = await pool.query<{ forced: boolean; [key: string]: unknown }>(`
      select relforcerowsecurity as forced
      from pg_catalog.pg_class
      where oid = 'public.site'::regclass
    `);
    expect(rls.rows).toEqual([{ forced: true }]);
  } finally {
    await pool.end().catch(() => undefined);
    await embedded.stop().catch(() => undefined);
  }
}, 120_000);
