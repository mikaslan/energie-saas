import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  canonicalizeCatalogJson,
  sealCatalogComponentRevision,
} from "@/lib/integrations/catalog/contract";
import {
  parseCatalogCsvPreview,
  sealCatalogImportPrepareV1,
  sealCatalogImportRowCommand,
  type CatalogCsvColumnMappingV1,
  type CatalogImportPrepareV1,
} from "@/lib/integrations/catalog/import-contract";
import { bootstrapCalculationQueue } from "../../scripts/pgboss-bootstrap.mjs";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";
import { testPool } from "../setup/test-db";

type MigrationJournal = {
  entries: Array<{ idx: number; tag: string }>;
};

const PRE_M108B_HISTORY_SHA256 =
  "8bc641dfca0e909daab0cb1e8eb52d4a6fee0fb6192cb9a7762ee73707a91fad";
const MIGRATION_TAG = "0036_m1_08b_catalog_import";
const IMPORT_TABLES = [
  "catalog_import_dispatch_receipt",
  "catalog_import_job",
  "catalog_import_row",
  "catalog_import_row_result",
] as const;

const RUNTIME_GATEWAYS = [
  "cancel_catalog_import_v1",
  "prepare_catalog_import_v1",
  "read_catalog_import_rows_v1",
  "read_catalog_import_v1",
  "read_latest_catalog_import_id_v1",
  "start_catalog_import_v1",
] as const;

const WORKER_GATEWAYS = [
  "_m108b_catalog_import_dispatch_state",
  "apply_catalog_import_row_v1",
  "claim_catalog_import_v1",
  "cleanup_catalog_import_snapshots_v1",
  "complete_catalog_import_batch_v1",
  "finalize_catalog_import_failure_v1",
  "record_catalog_import_dispatch_failure_v1",
  "record_catalog_import_preclaim_failure_v1",
  "recover_catalog_imports_v1",
] as const;

const STRICT_MIGRATOR_PASSWORD = "m108b_strict_migrator";
const STRICT_RUNTIME_PASSWORD = "m108b_strict_runtime";
const STRICT_WORKER_PASSWORD = "m108b_strict_worker";

const STRICT_GATEWAYS = [
  ["public.cancel_catalog_import_v1(uuid,uuid)", "app_runtime"],
  ["public.prepare_catalog_import_v1(uuid,uuid,jsonb)", "app_runtime"],
  ["public.read_catalog_import_rows_v1(uuid,uuid,integer,integer)", "app_runtime"],
  ["public.read_catalog_import_v1(uuid,uuid)", "app_runtime"],
  ["public.read_latest_catalog_import_id_v1(uuid)", "app_runtime"],
  ["public.start_catalog_import_v1(uuid,uuid,text)", "app_runtime"],
  ["public._m108b_catalog_import_dispatch_state(uuid,uuid,text)", "app_worker"],
  ["public.apply_catalog_import_row_v1(uuid,uuid,integer,uuid,bigint)", "app_worker"],
  ["public.claim_catalog_import_v1(uuid,uuid,uuid,integer)", "app_worker"],
  ["public.cleanup_catalog_import_snapshots_v1(uuid,integer)", "app_worker"],
  ["public.complete_catalog_import_batch_v1(uuid,uuid,uuid,bigint)", "app_worker"],
  ["public.finalize_catalog_import_failure_v1(uuid,uuid,uuid,bigint,text)", "app_worker"],
  ["public.record_catalog_import_dispatch_failure_v1(uuid,uuid,uuid,text)", "app_worker"],
  ["public.record_catalog_import_preclaim_failure_v1(uuid,uuid,uuid,text)", "app_worker"],
  ["public.recover_catalog_imports_v1(uuid,integer)", "app_worker"],
] as const;

const STRICT_PGBOSS_GATEWAYS = [
  ["pgboss.enqueue_catalog_import_cleanup_v1(uuid,uuid,uuid)", true, "v", true],
  ["pgboss.enqueue_catalog_import_v1(uuid,uuid,uuid)", true, "v", true],
  [
    "pgboss.list_catalog_import_cleanup_locator_jobs_v1(uuid,integer)",
    false,
    "s",
    false,
  ],
  [
    "pgboss.list_catalog_import_recovery_locator_jobs_v1(uuid,integer)",
    false,
    "s",
    false,
  ],
  [
    "pgboss.quarantine_catalog_import_locator_job_v1(uuid)",
    false,
    "v",
    false,
  ],
] as const;

function strictServiceUrl(
  embedded: EmbeddedTestDatabase,
  role: "app_migrator" | "app_runtime" | "app_worker",
  password: string,
): string {
  const url = new URL(embedded.url);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function bootstrapStrictRoles(
  embedded: EmbeddedTestDatabase,
  admin: Pool,
): Promise<void> {
  await admin.query(`
    create role app_owner nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_migrator login password '${STRICT_MIGRATOR_PASSWORD}'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_runtime login password '${STRICT_RUNTIME_PASSWORD}'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_system login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_auth login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_worker login password '${STRICT_WORKER_PASSWORD}'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_erasure nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role identity_reconciler nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;

    grant app_owner to app_migrator
      with admin false, inherit false, set true;
    grant app_worker to app_migrator
      with admin false, inherit false, set true;
    grant app_membership_writer to app_owner
      with admin false, inherit false, set false;
    grant app_membership_writer to app_system
      with admin false, inherit false, set false;
    grant identity_reconciler to app_owner
      with admin true, inherit false, set false;

    alter database energie_saas_test owner to app_owner;
    revoke app_membership_writer from app_test;
    revoke all privileges on database energie_saas_test from app_test;
    grant connect on database energie_saas_test
      to app_migrator, app_runtime, app_worker;
    alter schema public owner to app_owner;
    revoke all on schema public from public, app_test;
    create schema pgboss authorization app_worker;
  `);
  await bootstrapCalculationQueue(strictServiceUrl(
    embedded,
    "app_worker",
    STRICT_WORKER_PASSWORD,
  ));
}

function journal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function historyHashThrough(index: number): string {
  const material = journal().entries
    .filter((entry) => entry.idx <= index)
    .map((entry) => `${entry.idx}\0${entry.tag}\0${readFileSync(
      resolve("drizzle", `${entry.tag}.sql`),
      "utf8",
    )}`)
    .join("\0");
  return createHash("sha256").update(material).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const purchaseProvenance = {
  sourceKind: "supplier_price_list",
  reference: "Eigene Testpreisliste",
  observedOn: "2026-08-31",
  rightsBasis: "supplier_authorized",
  sourceDocumentSha256: null,
} as const;

const salesProvenance = {
  sourceKind: "workspace_pricing",
  reference: "Eigene Kalkulation",
  observedOn: "2026-08-31",
  rightsBasis: "workspace_owned",
  sourceDocumentSha256: null,
} as const;

const technicalProvenance = {
  sourceKind: "manufacturer_datasheet",
  reference: "Datenblatt S440",
  observedOn: "2026-08-31",
  rightsBasis: "manufacturer_published",
  sourceDocumentSha256: null,
} as const;

const sourceCommand = {
  schemaVersion: "catalog-component-create-command.v1",
  internalSku: "PV-440-BLK",
  componentType: "module",
  presentation: {
    displayName: "440-Watt-Modul",
    manufacturer: "WMEE Testwerk",
    model: "S440",
    unit: "piece",
    keyPoints: ["synthetisch", "schwarz"],
    image: null,
    datasheet: null,
  },
  technicalData: {
    schemaVersion: "module.v1",
    nominalPowerWatts: 440,
  },
  commercial: {
    currency: "EUR",
    basis: "net",
    purchasePriceNetCents: 7_900,
    salesPriceNetCents: 12_900,
    purchaseProvenance,
    salesProvenance,
  },
  technicalProvenance,
} as const;

function validRowCommandFixture(): Record<string, unknown> {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const componentId = "00000000-0000-4000-8000-000000000002";
  const targetBody = {
    schemaVersion: "catalog-component-revision.v1",
    canonicalizationVersion: "catalog-jcs.v1",
    identity: {
      workspaceId,
      componentId,
      revision: 1,
      internalSku: sourceCommand.internalSku,
      componentType: sourceCommand.componentType,
    },
    presentation: sourceCommand.presentation,
    technicalData: sourceCommand.technicalData,
    commercial: sourceCommand.commercial,
    technicalProvenance: sourceCommand.technicalProvenance,
  };
  const targetBodyCanonical = canonicalizeCatalogJson(targetBody);
  const targetSha256 = sha256(targetBodyCanonical);
  const body = {
    schemaVersion: "catalog-import-row-command.v1",
    source: {
      fileSha256: "1".repeat(64),
      mappingSha256: "2".repeat(64),
      rowNumber: 2,
      rowSha256: "3".repeat(64),
      sourceCommandSha256: sha256(canonicalizeCatalogJson(sourceCommand)),
    },
    operation: "create",
    targetComponentId: componentId,
    expected: null,
    sourceCommand,
    sealedTarget: {
      snapshot: { ...targetBody, snapshotSha256: targetSha256 },
      bodyCanonicalBase64: Buffer.from(targetBodyCanonical, "utf8").toString("base64"),
      snapshotSha256: targetSha256,
    },
  };
  return { ...body, rowCommandSha256: sha256(canonicalizeCatalogJson(body)) };
}

function strictCatalogImportPrepare(workspaceId: string): CatalogImportPrepareV1 {
  const cells = [
    ["internalSku", "PV-440-QUEUE"],
    ["componentType", "module"],
    ["displayName", "440-Watt Queue-Modul"],
    ["manufacturer", "WMEE Testwerk"],
    ["model", "Q440"],
    ["unit", "piece"],
    ["technicalSourceKind", "manufacturer_datasheet"],
    ["technicalReference", "Datenblatt Q440"],
    ["technicalObservedOn", "2026-08-31"],
    ["technicalRightsBasis", "manufacturer_published"],
    ["purchasePriceNet", "79.00"],
    ["purchaseSourceKind", "supplier_price_list"],
    ["purchaseReference", "Eigene Testpreisliste"],
    ["purchaseObservedOn", "2026-08-31"],
    ["purchaseRightsBasis", "supplier_authorized"],
    ["salesPriceNet", "129.00"],
    ["salesSourceKind", "workspace_pricing"],
    ["salesReference", "Eigene Kalkulation"],
    ["salesObservedOn", "2026-08-31"],
    ["salesRightsBasis", "workspace_owned"],
    ["nominalPowerWatts", "440"],
  ] as const;
  const mapping: CatalogCsvColumnMappingV1 = {
    schemaVersion: "catalog-csv-column-mapping.v1",
    columns: cells.map(([field]) => ({ field, sourceHeader: field })),
  };
  const csv = `${cells.map(([field]) => field).join(";")}\n${
    cells.map(([, value]) => value).join(";")
  }`;
  const preview = parseCatalogCsvPreview({
    filename: "queue-fixture.csv",
    bytes: new TextEncoder().encode(csv),
    mapping,
  });
  const sourceRow = preview.rows[0];
  if (!sourceRow || sourceRow.status !== "valid") {
    throw new Error("Queue-Fixture erzeugte keine valide Preview-Zeile.");
  }
  const componentId = randomUUID();
  const target = sealCatalogComponentRevision({
    schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    identity: {
      workspaceId,
      componentId,
      revision: 1,
      internalSku: sourceRow.command.internalSku,
      componentType: sourceRow.command.componentType,
    },
    presentation: sourceRow.command.presentation,
    technicalData: sourceRow.command.technicalData,
    commercial: sourceRow.command.commercial,
    technicalProvenance: sourceRow.command.technicalProvenance,
  });
  const command = sealCatalogImportRowCommand({
    fileSha256: preview.file.sha256,
    mappingSha256: preview.mappingSha256,
    sourceRow,
    operation: "create",
    targetComponentId: componentId,
    expected: null,
    sealedTarget: target,
  });
  return sealCatalogImportPrepareV1({
    workspaceId,
    preview,
    rows: [{ status: "valid", command }],
  });
}

async function strictTenantTransaction<T>(
  pool: Pool,
  workspaceId: string,
  actorId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.workspace_id', $1, true), " +
        "set_config('app.actor_id', $2, true)",
      [workspaceId, actorId],
    );
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe("M1-08b catalog-import migration contract", () => {
  it("ist die additive 0036 und veraendert 0000 bis 0035 nicht", () => {
    const entries = journal().entries;
    expect(entries.slice(0, 37).map((entry) => entry.idx)).toEqual(
      Array.from({ length: 37 }, (_, index) => index),
    );
    expect(entries[36]?.tag).toBe(MIGRATION_TAG);
    expect(historyHashThrough(35)).toBe(PRE_M108B_HISTORY_SHA256);
  });

  it("materialisiert ausschließlich das eigene Clean-Room-Importschema", () => {
    const path = resolve("drizzle", `${MIGRATION_TAG}.sql`);
    expect(existsSync(path)).toBe(true);
    const migration = readFileSync(path, "utf8");
    for (const relation of IMPORT_TABLES) {
      expect(migration).toContain(`CREATE TABLE \"${relation}\"`);
    }
    expect(migration).not.toMatch(/\b(?:reonic|rionic)\b/iu);
  });

  it("erzwingt FORCE RLS und genau eine kanonische Tenant-Policy", async () => {
    const relations = await testPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select relname, relrowsecurity, relforcerowsecurity
        from pg_catalog.pg_class
       where relnamespace = 'public'::regnamespace
         and relname = any($1::text[])
       order by relname
    `, [IMPORT_TABLES]);
    expect(relations.rows).toEqual([...IMPORT_TABLES].sort().map((relname) => ({
      relname,
      relrowsecurity: true,
      relforcerowsecurity: true,
    })));

    const policies = await testPool.query<{
      tablename: string;
      policyname: string;
      permissive: string;
      roles: string;
      cmd: string;
      samePredicate: boolean;
    }>(`
      select tablename, policyname, permissive, roles::text as roles, cmd,
             qual = with_check as "samePredicate"
        from pg_catalog.pg_policies
       where schemaname = 'public'
         and tablename = any($1::text[])
       order by tablename, policyname
    `, [IMPORT_TABLES]);
    expect(policies.rows).toEqual([...IMPORT_TABLES].sort().map((tablename) => ({
      tablename,
      policyname: "tenant_isolation",
      permissive: "PERMISSIVE",
      roles: "{public}",
      cmd: "ALL",
      samePredicate: true,
    })));
  });

  it("gibt Runtime und Worker keinerlei direkten Importtabellenzugriff", async () => {
    const migration = readFileSync(resolve("drizzle", `${MIGRATION_TAG}.sql`), "utf8");
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*catalog_import_job[\s\S]*FROM PUBLIC/iu,
    );
    expect(migration).toMatch(/app_runtime[\s\S]*app_worker[\s\S]*REVOKE ALL PRIVILEGES/iu);

    const publicAcl = await testPool.query<{ tableName: string; revoked: boolean }>(`
      select relation.relname as "tableName",
             not exists (
               select 1
                 from pg_catalog.aclexplode(
                   coalesce(
                     relation.relacl,
                     pg_catalog.acldefault('r', relation.relowner)
                   )
                 ) as acl
                where acl.grantee = 0
                  and acl.privilege_type = any(ARRAY[
                    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'
                  ])
             ) as revoked
        from pg_catalog.pg_class as relation
       where relation.relnamespace = 'public'::regnamespace
         and relation.relname = any($1::text[])
       order by relation.relname
    `, [IMPORT_TABLES]);
    expect(publicAcl.rows).toEqual([...IMPORT_TABLES].sort().map((tableName) => ({
      tableName,
      revoked: true,
    })));

    const privileges = await testPool.query<{
      roleName: string;
      tableName: string;
      canSelect: boolean;
      canInsert: boolean;
      canUpdate: boolean;
      canDelete: boolean;
      canTruncate: boolean;
    }>(`
      with requested_role(role_name) as (
        values ('app_runtime'::text), ('app_worker'::text)
      )
      select requested_role.role_name as "roleName", table_name as "tableName",
             pg_catalog.has_table_privilege(requested_role.role_name, table_name, 'SELECT')
               as "canSelect",
             pg_catalog.has_table_privilege(requested_role.role_name, table_name, 'INSERT')
               as "canInsert",
             pg_catalog.has_table_privilege(requested_role.role_name, table_name, 'UPDATE')
               as "canUpdate",
             pg_catalog.has_table_privilege(requested_role.role_name, table_name, 'DELETE')
               as "canDelete",
             pg_catalog.has_table_privilege(requested_role.role_name, table_name, 'TRUNCATE')
               as "canTruncate"
        from requested_role
        join pg_catalog.pg_roles as role_row
          on role_row.rolname = requested_role.role_name
        cross join pg_catalog.unnest($1::text[]) as table_name
       order by requested_role.role_name, table_name
    `, [IMPORT_TABLES.map((table) => `public.${table}`)]);
    for (const privilege of privileges.rows) {
      expect(privilege).toMatchObject({
        canSelect: false,
        canInsert: false,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
      });
    }
  });

  it("installiert enge versionierte Runtime- und Worker-Gateways", async () => {
    const gatewayNames = [...RUNTIME_GATEWAYS, ...WORKER_GATEWAYS].sort();
    const principal = await testPool.query<{
      owner: string;
      runtimeRoleExists: boolean;
      workerRoleExists: boolean;
    }>(`
      select current_user as owner,
             pg_catalog.to_regrole('app_runtime') is not null
               as "runtimeRoleExists",
             pg_catalog.to_regrole('app_worker') is not null
               as "workerRoleExists"
    `);
    const expectedPrincipal = principal.rows[0];
    if (!expectedPrincipal) throw new Error("Migrationsprincipal fehlt.");
    const gateways = await testPool.query<{
      name: string;
      owner: string;
      securityDefiner: boolean;
      volatility: string;
      config: string[] | null;
      publicExecute: boolean;
      runtimeExecute: boolean;
      workerExecute: boolean;
    }>(`
      select routine.proname as name,
             owner.rolname as owner,
             routine.prosecdef as "securityDefiner",
             routine.provolatile as volatility,
             routine.proconfig as config,
             pg_catalog.has_function_privilege(
               'public', routine.oid, 'EXECUTE'
             ) as "publicExecute",
             case when pg_catalog.to_regrole('app_runtime') is null then false
               else pg_catalog.has_function_privilege(
                 pg_catalog.to_regrole('app_runtime'), routine.oid, 'EXECUTE'
               )
             end as "runtimeExecute",
             case when pg_catalog.to_regrole('app_worker') is null then false
               else pg_catalog.has_function_privilege(
                 pg_catalog.to_regrole('app_worker'), routine.oid, 'EXECUTE'
               )
             end as "workerExecute"
        from pg_catalog.pg_proc as routine
        join pg_catalog.pg_roles as owner on owner.oid = routine.proowner
       where routine.pronamespace = 'public'::regnamespace
         and routine.proname = any($1::text[])
       order by routine.proname
    `, [gatewayNames]);
    expect(gateways.rows.map((gateway) => gateway.name)).toEqual(gatewayNames);
    for (const gateway of gateways.rows) {
      expect(gateway).toMatchObject({
        owner: expectedPrincipal.owner,
        securityDefiner: true,
        volatility: "v",
        config: ["search_path=pg_catalog"],
        publicExecute: false,
        runtimeExecute: expectedPrincipal.runtimeRoleExists &&
          RUNTIME_GATEWAYS.includes(
            gateway.name as (typeof RUNTIME_GATEWAYS)[number],
          ),
        workerExecute: expectedPrincipal.workerRoleExists &&
          WORKER_GATEWAYS.includes(
            gateway.name as (typeof WORKER_GATEWAYS)[number],
          ),
      });
    }
  });

  it("installiert geschlossene WORM-, Redaction- und No-TRUNCATE-Trigger", async () => {
    const triggers = await testPool.query<{
      tableName: string;
      triggerName: string;
      functionName: string;
      deferred: boolean;
    }>(`
      select relation.relname as "tableName",
             trigger_row.tgname as "triggerName",
             routine.proname as "functionName",
             trigger_row.tgdeferrable as deferred
        from pg_catalog.pg_trigger as trigger_row
        join pg_catalog.pg_class as relation on relation.oid = trigger_row.tgrelid
        join pg_catalog.pg_proc as routine on routine.oid = trigger_row.tgfoid
       where not trigger_row.tgisinternal
         and relation.relnamespace = 'public'::regnamespace
         and relation.relname = any($1::text[])
       order by relation.relname, trigger_row.tgname
    `, [IMPORT_TABLES]);
    expect(triggers.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tableName: "catalog_import_job",
        triggerName: "catalog_import_job_guard",
        functionName: "_m108b_guard_catalog_import_job",
      }),
      expect.objectContaining({
        tableName: "catalog_import_job",
        triggerName: "catalog_import_job_validate_input",
        functionName: "_m108b_validate_catalog_import_job_input",
      }),
      expect.objectContaining({
        tableName: "catalog_import_job",
        triggerName: "catalog_import_job_redaction_complete",
        functionName: "_m108b_validate_catalog_import_redaction",
        deferred: true,
      }),
      expect.objectContaining({
        tableName: "catalog_import_row",
        triggerName: "catalog_import_row_derive_payload",
        functionName: "_m108b_derive_catalog_import_row_payload",
      }),
      expect.objectContaining({
        tableName: "catalog_import_row",
        triggerName: "catalog_import_row_guard",
        functionName: "_m108b_guard_catalog_import_row",
      }),
      expect.objectContaining({
        tableName: "catalog_import_row",
        triggerName: "catalog_import_row_validate_input",
        functionName: "_m108b_validate_catalog_import_row_input",
      }),
      expect.objectContaining({
        tableName: "catalog_import_row",
        triggerName: "catalog_import_row_redaction_complete",
        functionName: "_m108b_validate_catalog_import_redaction",
        deferred: true,
      }),
      expect.objectContaining({
        tableName: "catalog_import_row_result",
        triggerName: "catalog_import_row_result_immutable",
        functionName: "forbid_mutation",
      }),
      expect.objectContaining({
        tableName: "catalog_import_row_result",
        triggerName: "catalog_import_row_result_validate_input",
        functionName: "_m108b_validate_catalog_import_result_input",
      }),
    ]));
    for (const table of IMPORT_TABLES) {
      expect(triggers.rows).toContainEqual(expect.objectContaining({
        tableName: table,
        triggerName: `${table}_no_truncate`,
        functionName: "forbid_mutation",
      }));
    }
  });

  it("leitet Sensitivbytes DB-seitig ab und bindet das 30-MiB-Budget", async () => {
    const functions = await testPool.query<{ name: string; source: string }>(`
      select routine.proname as name, routine.prosrc as source
        from pg_catalog.pg_proc as routine
       where routine.pronamespace = 'public'::regnamespace
         and routine.proname = any($1::text[])
       order by routine.proname
    `, [[
      "_m108b_catalog_import_error_source_header_bytes",
      "_m108b_derive_catalog_import_row_payload",
      "_m108b_validate_catalog_import_redaction",
    ]]);
    expect(functions.rows.map((row) => row.name)).toEqual([
      "_m108b_catalog_import_error_source_header_bytes",
      "_m108b_derive_catalog_import_row_payload",
      "_m108b_validate_catalog_import_redaction",
    ]);
    const derive = functions.rows.find((row) => (
      row.name === "_m108b_derive_catalog_import_row_payload"
    ))?.source ?? "";
    expect(derive).toMatch(
      /command_snapshot::text[\s\S]*preview_row_body_canonical[\s\S]*source_header_bytes[\s\S]*sealed_target_snapshot::text[\s\S]*sensitive_payload_bytes/iu,
    );
    expect(derive).not.toMatch(/pg_column_size/iu);
    const deferred = functions.rows.find((row) => (
      row.name === "_m108b_validate_catalog_import_redaction"
    ))?.source ?? "";
    expect(deferred).toMatch(
      /mapping_snapshot::text[\s\S]*sum\([\s\S]*sensitive_payload_bytes[\s\S]*31457280/iu,
    );
    expect(deferred).not.toMatch(/pg_column_size\(job_record\.mapping_snapshot\)/iu);
  });

  it("validiert Mapping, Command, Expected, Target und Fehler strikt und fail-closed", async () => {
    const names = [
      "_m108b_jsonb_exact_keys",
      "_m108b_valid_catalog_import_error_array",
      "_m108b_valid_catalog_import_expected",
      "_m108b_valid_catalog_import_mapping",
      "_m108b_valid_catalog_import_row_command",
      "_m108b_valid_catalog_import_sealed_target",
      "_m108b_valid_catalog_import_source_command",
      "_m108b_validate_catalog_import_job_input",
      "_m108b_validate_catalog_import_row_input",
    ].sort();
    const functions = await testPool.query<{ name: string; source: string }>(`
      select routine.proname as name, routine.prosrc as source
        from pg_catalog.pg_proc as routine
       where routine.pronamespace = 'public'::regnamespace
         and routine.proname = any($1::text[])
       order by routine.proname
    `, [names]);
    expect(functions.rows.map((row) => row.name)).toEqual(names);
    const rowCommand = functions.rows.find((row) => (
      row.name === "_m108b_valid_catalog_import_row_command"
    ))?.source ?? "";
    expect(rowCommand).toMatch(
      /jsonb_exact_keys[\s\S]*valid_catalog_import_source_command[\s\S]*valid_catalog_import_expected[\s\S]*valid_catalog_import_sealed_target/iu,
    );
    const rowInput = functions.rows.find((row) => (
      row.name === "_m108b_validate_catalog_import_row_input"
    ))?.source ?? "";
    expect(rowInput).toMatch(
      /valid_catalog_import_row_command[\s\S]*file_sha256[\s\S]*mapping_sha256[\s\S]*valid_catalog_import_error_array/iu,
    );
  });

  it("berechnet catalog-jcs.v1 in PostgreSQL bytegleich ohne NFC-Normalisierung", async () => {
    const vectors = [
      { b: 2, aa: 1, a: 3, text: "Gru\u0308n" },
      { array: [0, true, null, "Zeile\nmit \"Zitat\""] },
      { nested: { z: 9_007_199_254_740_991, a: -0 } },
    ];
    for (const vector of vectors) {
      const result = await testPool.query<{ value: string }>(
        "select public.canonicalize_catalog_json_v1($1::jsonb) as value",
        [JSON.stringify(vector)],
      );
      expect(result.rows[0]?.value).toBe(canonicalizeCatalogJson(vector));
    }
    const acl = await testPool.query<{ publicExecute: boolean }>(`
      select pg_catalog.has_function_privilege(
               'public',
               'public.canonicalize_catalog_json_v1(jsonb)',
               'EXECUTE'
             ) as "publicExecute"
    `);
    expect(acl.rows[0]?.publicExecute).toBe(false);
  });

  it("akzeptiert echte Serverartefakte und lehnt strukturelle Manipulationen ab", async () => {
    const mapping = {
      schemaVersion: "catalog-csv-column-mapping.v1",
      columns: [
        { field: "internalSku", sourceHeader: "internalSku" },
        { field: "componentType", sourceHeader: "componentType" },
      ],
    };
    const command = validRowCommandFixture();
    const expected = {
      componentId: "00000000-0000-4000-8000-000000000002",
      revision: 1,
      status: "active",
      snapshotSha256: "4".repeat(64),
      internalSku: sourceCommand.internalSku,
      componentType: sourceCommand.componentType,
    };
    const errors = [{
      field: "internalSku",
      sourceHeader: "internalSku",
      code: "missing_value",
      message: "Ein benoetigter Wert fehlt.",
    }];
    const accepted = await testPool.query<{
      mapping: boolean;
      source: boolean;
      expected: boolean;
      target: boolean;
      command: boolean;
      errors: boolean;
    }>(`
      select public._m108b_valid_catalog_import_mapping($1::jsonb) as mapping,
             public._m108b_valid_catalog_import_source_command($2::jsonb) as source,
             public._m108b_valid_catalog_import_expected($3::jsonb) as expected,
             public._m108b_valid_catalog_import_sealed_target(
               $4::jsonb->'sealedTarget'
             ) as target,
             public._m108b_valid_catalog_import_row_command($4::jsonb) as command,
             public._m108b_valid_catalog_import_error_array($5::jsonb) as errors
    `, [mapping, sourceCommand, expected, command, JSON.stringify(errors)]);
    expect(accepted.rows[0]).toEqual({
      mapping: true,
      source: true,
      expected: true,
      target: true,
      command: true,
      errors: true,
    });

    const invalidCommand = structuredClone(command);
    invalidCommand.operation = "unchanged";
    const rejected = await testPool.query<{
      extraMappingKey: boolean;
      technicalMismatch: boolean;
      malformedUuid: boolean;
      uppercaseUuid: boolean;
      targetBodyDrift: boolean;
      operationIffDrift: boolean;
      freeMessage: boolean;
      nullObject: boolean;
      nullMappingVersion: boolean;
      nullSourceVersion: boolean;
      nullRevisionVersion: boolean;
      nullCanonicalizationVersion: boolean;
      nullRowVersion: boolean;
    }>(`
      select public._m108b_valid_catalog_import_mapping(
               ($1::jsonb || '{"extra":true}'::jsonb)
             ) as "extraMappingKey",
             public._m108b_valid_catalog_import_source_command(
               pg_catalog.jsonb_set($2::jsonb, '{componentType}', '"battery"'::jsonb)
             ) as "technicalMismatch",
             public._m108b_valid_catalog_import_expected(
               pg_catalog.jsonb_set($3::jsonb, '{componentId}', '"not-a-uuid"'::jsonb)
             ) as "malformedUuid",
             public._m108b_valid_catalog_import_expected(
               pg_catalog.jsonb_set(
                 $3::jsonb,
                 '{componentId}',
                 '"00000000-0000-4000-8000-0000000000AB"'::jsonb
               )
             ) as "uppercaseUuid",
             public._m108b_valid_catalog_import_sealed_target(
               pg_catalog.jsonb_set(
                 $4::jsonb->'sealedTarget',
                 '{bodyCanonicalBase64}',
                 '"AAAA"'::jsonb
               )
             ) as "targetBodyDrift",
             public._m108b_valid_catalog_import_row_command($6::jsonb)
               as "operationIffDrift",
             public._m108b_valid_catalog_import_error_array(
               pg_catalog.jsonb_set($5::jsonb, '{0,message}', '"freie Nachricht"'::jsonb)
             ) as "freeMessage",
             public._m108b_jsonb_exact_keys('null'::jsonb, ARRAY['a'])
               as "nullObject",
             public._m108b_valid_catalog_import_mapping(
               pg_catalog.jsonb_set($1::jsonb, '{schemaVersion}', 'null'::jsonb)
             ) as "nullMappingVersion",
             public._m108b_valid_catalog_import_source_command(
               pg_catalog.jsonb_set($2::jsonb, '{schemaVersion}', 'null'::jsonb)
             ) as "nullSourceVersion",
             public._m108b_valid_catalog_import_revision(
               pg_catalog.jsonb_set(
                 $4::jsonb#>'{sealedTarget,snapshot}',
                 '{schemaVersion}',
                 'null'::jsonb
               )
             ) as "nullRevisionVersion",
             public._m108b_valid_catalog_import_revision(
               pg_catalog.jsonb_set(
                 $4::jsonb#>'{sealedTarget,snapshot}',
                 '{canonicalizationVersion}',
                 'null'::jsonb
               )
             ) as "nullCanonicalizationVersion",
             public._m108b_valid_catalog_import_row_command(
               pg_catalog.jsonb_set($4::jsonb, '{schemaVersion}', 'null'::jsonb)
             ) as "nullRowVersion"
    `, [
      mapping,
      sourceCommand,
      expected,
      command,
      JSON.stringify(errors),
      invalidCommand,
    ]);
    expect(rejected.rows[0]).toEqual({
      extraMappingKey: false,
      technicalMismatch: false,
      malformedUuid: false,
      uppercaseUuid: false,
      targetBodyDrift: false,
      operationIffDrift: false,
      freeMessage: false,
      nullObject: false,
      nullMappingVersion: false,
      nullSourceVersion: false,
      nullRevisionVersion: false,
      nullCanonicalizationVersion: false,
      nullRowVersion: false,
    });
  });
});

describe.sequential("M1-08b strict gateway ACL", () => {
  let embedded: EmbeddedTestDatabase | undefined;
  let admin: Pool | undefined;
  let migrator: Pool | undefined;
  let runtime: Pool | undefined;
  let worker: Pool | undefined;

  beforeAll(async () => {
    embedded = await startEmbeddedPostgres();
    admin = new Pool({ connectionString: embedded.superuserUrl, max: 2 });
    await bootstrapStrictRoles(embedded, admin);
    migrator = new Pool({
      connectionString: strictServiceUrl(
        embedded,
        "app_migrator",
        STRICT_MIGRATOR_PASSWORD,
      ),
      options: "-c role=app_owner",
      max: 2,
    });
    await migrate(drizzle(migrator), { migrationsFolder: resolve("drizzle") });
    runtime = new Pool({
      connectionString: strictServiceUrl(
        embedded,
        "app_runtime",
        STRICT_RUNTIME_PASSWORD,
      ),
      max: 2,
    });
    worker = new Pool({
      connectionString: strictServiceUrl(
        embedded,
        "app_worker",
        STRICT_WORKER_PASSWORD,
      ),
      max: 2,
    });
  }, 180_000);

  afterAll(async () => {
    await runtime?.end().catch(() => undefined);
    await worker?.end().catch(() => undefined);
    await migrator?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await embedded?.stop();
  });

  it("pinnt Owner, Definer-Metadaten und die exakte Runtime-/Worker-Matrix", async () => {
    if (!admin) throw new Error("Strict-ACL-Adminpool fehlt.");
    const signatures = STRICT_GATEWAYS.map(([signature]) => signature);
    const metadata = await admin.query<{
      signature: string;
      owner: string | null;
      securityDefiner: boolean | null;
      volatility: string | null;
      config: string[] | null;
    }>(`
      select requested.signature,
             owner.rolname as owner,
             routine.prosecdef as "securityDefiner",
             routine.provolatile as volatility,
             routine.proconfig as config
        from pg_catalog.unnest($1::text[]) as requested(signature)
        left join pg_catalog.pg_proc as routine
          on routine.oid = pg_catalog.to_regprocedure(requested.signature)
        left join pg_catalog.pg_roles as owner on owner.oid = routine.proowner
       order by requested.signature
    `, [signatures]);
    expect(metadata.rows).toHaveLength(STRICT_GATEWAYS.length);
    for (const gateway of metadata.rows) {
      expect(gateway).toMatchObject({
        owner: "app_owner",
        securityDefiner: true,
        volatility: "v",
        config: ["search_path=pg_catalog"],
      });
    }

    const principals = [
      "public",
      "app_owner",
      "app_migrator",
      "app_runtime",
      "app_system",
      "app_auth",
      "app_worker",
      "app_erasure",
      "app_membership_writer",
      "identity_reconciler",
    ];
    const privileges = await admin.query<{
      signature: string;
      allowedRole: string;
      principal: string;
      execute: boolean;
      grantOption: boolean;
    }>(`
      with gateway(signature, allowed_role) as (
        select requested.signature,
               ($2::text[])[requested.ordinality]
          from pg_catalog.unnest($1::text[])
            with ordinality as requested(signature, ordinality)
      ), principal(name) as (
        select * from pg_catalog.unnest($3::text[])
      )
      select gateway.signature,
             gateway.allowed_role as "allowedRole",
             principal.name as principal,
             pg_catalog.has_function_privilege(
               principal.name,
               pg_catalog.to_regprocedure(gateway.signature),
               'EXECUTE'
             ) as execute,
             pg_catalog.has_function_privilege(
               principal.name,
               pg_catalog.to_regprocedure(gateway.signature),
               'EXECUTE WITH GRANT OPTION'
             ) as "grantOption"
        from gateway cross join principal
       order by gateway.signature, principal.name
    `, [
      signatures,
      STRICT_GATEWAYS.map(([, role]) => role),
      principals,
    ]);
    expect(privileges.rows).toHaveLength(STRICT_GATEWAYS.length * principals.length);
    for (const privilege of privileges.rows) {
      expect(privilege.execute).toBe(
        privilege.principal === "app_owner" ||
        privilege.principal === privilege.allowedRole,
      );
      expect(privilege.grantOption).toBe(privilege.principal === "app_owner");
    }
  });

  it("pinnt die fünf pg-boss-Naehte ohne Locator-Recht fuer Runtime", async () => {
    if (!admin) throw new Error("Strict-ACL-Adminpool fehlt.");
    const signatures = STRICT_PGBOSS_GATEWAYS.map(([signature]) => signature);
    const metadata = await admin.query<{
      signature: string;
      owner: string | null;
      securityDefiner: boolean | null;
      volatility: string | null;
      config: string[] | null;
      publicExecute: boolean | null;
      runtimeExecute: boolean | null;
      workerExecute: boolean | null;
      workerGrantOption: boolean | null;
      ownerExecute: boolean | null;
    }>(`
      select requested.signature,
             owner.rolname as owner,
             routine.prosecdef as "securityDefiner",
             routine.provolatile as volatility,
             routine.proconfig as config,
             pg_catalog.has_function_privilege(
               'public', routine.oid, 'EXECUTE'
             ) as "publicExecute",
             pg_catalog.has_function_privilege(
               'app_runtime', routine.oid, 'EXECUTE'
             ) as "runtimeExecute",
             pg_catalog.has_function_privilege(
               'app_worker', routine.oid, 'EXECUTE'
             ) as "workerExecute",
             pg_catalog.has_function_privilege(
               'app_worker', routine.oid, 'EXECUTE WITH GRANT OPTION'
             ) as "workerGrantOption",
             pg_catalog.has_function_privilege(
               'app_owner', routine.oid, 'EXECUTE'
             ) as "ownerExecute"
        from pg_catalog.unnest($1::text[]) as requested(signature)
        left join pg_catalog.pg_proc as routine
          on routine.oid = pg_catalog.to_regprocedure(requested.signature)
        left join pg_catalog.pg_roles as owner on owner.oid = routine.proowner
       order by requested.signature
    `, [signatures]);
    expect(metadata.rows).toHaveLength(STRICT_PGBOSS_GATEWAYS.length);
    for (const gateway of metadata.rows) {
      const expected = STRICT_PGBOSS_GATEWAYS.find(
        ([signature]) => signature === gateway.signature,
      );
      if (!expected) throw new Error("Unerwartete pg-boss-Signatur.");
      const [, securityDefiner, volatility, runtimeExecute] = expected;
      expect(gateway).toMatchObject({
        owner: "app_worker",
        securityDefiner,
        volatility,
        config: ["search_path=pg_catalog"],
        publicExecute: false,
        runtimeExecute,
        workerExecute: true,
        workerGrantOption: true,
        ownerExecute: false,
      });
    }
  });

  it("stellt Cleanup, Claim und Lease-Sentinel mit stabilen IDs atomar zu", async () => {
    if (!admin || !runtime || !worker) {
      throw new Error("Strict-Queue-Testpools fehlen.");
    }
    const workspaceId = randomUUID();
    const actorId = randomUUID();
    const intentId = randomUUID();
    const cleanupDispatchId = randomUUID();
    const importDispatchId = randomUUID();
    const sentinelDispatchId = randomUUID();
    await admin.query(
      "insert into public.workspace (id, name) values ($1::uuid, 'Queue Contract')",
      [workspaceId],
    );
    await admin.query(
      "insert into public.user_identity (id, email) values ($1::uuid, $2)",
      [actorId, `${actorId}@queue-contract.test`],
    );
    await strictTenantTransaction(admin, workspaceId, "", async (client) => {
      await client.query(`
        insert into public.membership (
          workspace_id, user_id, role, capabilities
        ) values ($1::uuid, $2::uuid, 'admin', '{}'::jsonb)
      `, [workspaceId, actorId]);
    });
    const prepare = strictCatalogImportPrepare(workspaceId);
    const prepared = await strictTenantTransaction(
      runtime,
      workspaceId,
      actorId,
      async (client) => {
        const result = await client.query<{
          result: { status: string; importId: string; validCount: number };
        }>(`
          select public.prepare_catalog_import_v1(
            $1::uuid, $2::uuid, $3::jsonb
          ) as result
        `, [workspaceId, intentId, JSON.stringify(prepare)]);
        const value = result.rows[0]?.result;
        if (!value) throw new Error("Prepare-Gateway lieferte kein Ergebnis.");
        await client.query(`
          select pgboss.enqueue_catalog_import_cleanup_v1(
            $1::uuid, $2::uuid, $3::uuid
          )
        `, [workspaceId, value.importId, cleanupDispatchId]);
        return value;
      },
    );
    expect(prepared).toMatchObject({
      status: "ready_for_review",
      validCount: 1,
    });
    const importId = prepared.importId;

    await strictTenantTransaction(runtime, workspaceId, actorId, async (client) => {
      await client.query(`
        select pgboss.enqueue_catalog_import_cleanup_v1(
          $1::uuid, $2::uuid, $3::uuid
        )
      `, [workspaceId, importId, randomUUID()]);
    });

    const started = await strictTenantTransaction(
      runtime,
      workspaceId,
      actorId,
      async (client) => {
        const result = await client.query<{
          result: { status: string; importId: string; dispatchRequired: boolean };
        }>(`
          select public.start_catalog_import_v1(
            $1::uuid, $2::uuid, 'catalog-import-rights-attestation.v1'
          ) as result
        `, [workspaceId, importId]);
        const value = result.rows[0]?.result;
        if (!value) throw new Error("Start-Gateway lieferte kein Ergebnis.");
        await client.query(`
          select pgboss.enqueue_catalog_import_v1(
            $1::uuid, $2::uuid, $3::uuid
          )
        `, [workspaceId, importId, importDispatchId]);
        return value;
      },
    );
    expect(started).toMatchObject({
      status: "queued",
      importId,
      dispatchRequired: true,
    });
    await strictTenantTransaction(runtime, workspaceId, actorId, async (client) => {
      await client.query(`
        select pgboss.enqueue_catalog_import_v1(
          $1::uuid, $2::uuid, $3::uuid
        )
      `, [workspaceId, importId, randomUUID()]);
    });

    const scheduled = await admin.query<{
      id: string;
      name: string;
      data: Record<string, unknown>;
      singletonKey: string;
      startAfter: Date;
    }>(`
      select id::text, name, data, singleton_key as "singletonKey",
             start_after as "startAfter"
        from pgboss.job
       where data->>'importId' = $1
       order by name
    `, [importId]);
    expect(scheduled.rows).toHaveLength(2);
    const cleanupJob = scheduled.rows.find(
      (job) => job.name === "catalog.import.cleanup.v1",
    );
    const importJob = scheduled.rows.find(
      (job) => job.name === "catalog.import.v1",
    );
    expect(cleanupJob).toMatchObject({
      id: cleanupDispatchId,
      data: {
        schemaVersion: "catalog-import-cleanup-dispatch.v1",
        workspaceId,
        importId,
      },
    });
    expect(importJob).toMatchObject({
      id: importDispatchId,
      singletonKey: `${importId}:claim:1:0`,
      data: {
        schemaVersion: "catalog-import-dispatch.v1",
        workspaceId,
        importId,
      },
    });
    expect(Object.keys(cleanupJob?.data ?? {}).sort()).toEqual([
      "importId",
      "schemaVersion",
      "workspaceId",
    ]);
    expect(Object.keys(importJob?.data ?? {}).sort()).toEqual([
      "importId",
      "schemaVersion",
      "workspaceId",
    ]);
    expect(cleanupJob?.singletonKey).toMatch(
      new RegExp(`^${importId}:preview:[0-9]+$`, "u"),
    );
    const due = await admin.query<{
      previewExpiresAt: Date;
      nextAttemptAt: Date;
    }>(`
      select preview_expires_at as "previewExpiresAt",
             next_attempt_at as "nextAttemptAt"
        from public.catalog_import_job
       where workspace_id = $1::uuid and id = $2::uuid
    `, [workspaceId, importId]);
    expect(cleanupJob?.startAfter.getTime()).toBe(
      due.rows[0]?.previewExpiresAt.getTime(),
    );
    expect(importJob?.startAfter.getTime()).toBe(
      due.rows[0]?.nextAttemptAt.getTime(),
    );

    const claimed = await strictTenantTransaction(
      worker,
      workspaceId,
      actorId,
      async (client) => {
        const result = await client.query<{
          result: {
            status: string;
            leaseToken: string;
            leaseGeneration: string;
            rowNumbers: number[];
          };
        }>(`
          select public.claim_catalog_import_v1(
            $1::uuid, $2::uuid, $3::uuid, 25
          ) as result
        `, [workspaceId, importId, importDispatchId]);
        const value = result.rows[0]?.result;
        if (!value) throw new Error("Claim-Gateway lieferte kein Ergebnis.");
        await client.query(`
          select pgboss.enqueue_catalog_import_v1(
            $1::uuid, $2::uuid, $3::uuid
          )
        `, [workspaceId, importId, sentinelDispatchId]);
        return value;
      },
    );
    expect(claimed).toMatchObject({
      status: "claimed",
      leaseToken: importDispatchId,
      leaseGeneration: "1",
      rowNumbers: [2],
    });
    const sentinel = await admin.query<{
      id: string;
      singletonKey: string;
      data: Record<string, unknown>;
    }>(`
      select id::text, singleton_key as "singletonKey", data
        from pgboss.job
       where id = $1::uuid
    `, [sentinelDispatchId]);
    expect(sentinel.rows[0]).toMatchObject({
      id: sentinelDispatchId,
      singletonKey: `${importId}:lease:1`,
      data: {
        schemaVersion: "catalog-import-dispatch.v1",
        workspaceId,
        importId,
      },
    });
    const earlySentinel = await strictTenantTransaction(
      worker,
      workspaceId,
      actorId,
      async (client) => client.query<{ result: { status: string } }>(`
        select public.claim_catalog_import_v1(
          $1::uuid, $2::uuid, $3::uuid, 25
        ) as result
      `, [workspaceId, importId, sentinelDispatchId]),
    );
    expect(earlySentinel.rows[0]?.result).toEqual({ status: "not_claimable" });

    const recoveryLocators = await worker.query<{
      locator_job_id: string;
      workspace_id: string;
      import_id: string;
      locator_status: string;
    }>(`
      select *
        from pgboss.list_catalog_import_recovery_locator_jobs_v1(null, 100)
    `);
    expect(recoveryLocators.rows).toEqual(expect.arrayContaining([
      {
        locator_job_id: importDispatchId,
        workspace_id: workspaceId,
        import_id: importId,
        locator_status: "valid",
      },
      {
        locator_job_id: sentinelDispatchId,
        workspace_id: workspaceId,
        import_id: importId,
        locator_status: "valid",
      },
    ]));
    const cleanupLocators = await worker.query<{
      locator_job_id: string;
      workspace_id: string;
      import_id: string;
      locator_status: string;
    }>(`
      select *
        from pgboss.list_catalog_import_cleanup_locator_jobs_v1(null, 100)
    `);
    expect(cleanupLocators.rows).toContainEqual({
      locator_job_id: cleanupDispatchId,
      workspace_id: workspaceId,
      import_id: importId,
      locator_status: "valid",
    });
    await expect(runtime.query(`
      select *
        from pgboss.list_catalog_import_recovery_locator_jobs_v1(null, 1)
    `)).rejects.toMatchObject({ code: "42501" });

    const malformedId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    await worker.query(`
      insert into pgboss.job (id, name, data)
      values (
        $1::uuid,
        'catalog.import.v1',
        jsonb_build_object(
          'schemaVersion', 'catalog-import-dispatch.v1',
          'workspaceId', $2::text,
          'importId', $3::text,
          'unexpected', true
        )
      )
    `, [malformedId, workspaceId, importId]);
    const malformed = await worker.query<{
      locator_job_id: string;
      workspace_id: string | null;
      import_id: string | null;
      locator_status: string;
    }>(`
      select *
        from pgboss.list_catalog_import_recovery_locator_jobs_v1(null, 100)
       where locator_job_id = $1::uuid
    `, [malformedId]);
    expect(malformed.rows).toEqual([{
      locator_job_id: malformedId,
      workspace_id: workspaceId,
      import_id: importId,
      locator_status: "queue_locator_invalid",
    }]);
    await expect(worker.query(`
      select pgboss.quarantine_catalog_import_locator_job_v1($1::uuid)
        as quarantined
    `, [importDispatchId])).rejects.toMatchObject({ code: "22023" });
    await expect(worker.query(`
      select pgboss.quarantine_catalog_import_locator_job_v1($1::uuid)
        as quarantined
    `, [malformedId])).resolves.toMatchObject({
      rows: [{ quarantined: true }],
    });
    const quarantined = await admin.query<{ state: string }>(`
      select state::text as state from pgboss.job where id = $1::uuid
    `, [malformedId]);
    expect(quarantined.rows).toEqual([{ state: "cancelled" }]);
  });

  it("verwehrt Runtime und Worker jeden direkten Tabellen- und Spaltenzugriff", async () => {
    if (!admin) throw new Error("Strict-ACL-Adminpool fehlt.");
    const privileges = await admin.query<{
      principal: string;
      tableName: string;
      selectTable: boolean;
      insertTable: boolean;
      updateTable: boolean;
      deleteTable: boolean;
      truncateTable: boolean;
      referencesTable: boolean;
      triggerTable: boolean;
      selectColumn: boolean;
      insertColumn: boolean;
      updateColumn: boolean;
      referencesColumn: boolean;
    }>(`
      with principal(name) as (
        values ('app_runtime'::text), ('app_worker'::text)
      ), relation(name) as (
        select * from pg_catalog.unnest($1::text[])
      )
      select principal.name as principal,
             relation.name as "tableName",
             pg_catalog.has_table_privilege(
               principal.name, 'public.' || relation.name, 'SELECT'
             ) as "selectTable",
             pg_catalog.has_table_privilege(
               principal.name, 'public.' || relation.name, 'INSERT'
             ) as "insertTable",
             pg_catalog.has_table_privilege(
               principal.name, 'public.' || relation.name, 'UPDATE'
             ) as "updateTable",
             pg_catalog.has_table_privilege(
               principal.name, 'public.' || relation.name, 'DELETE'
             ) as "deleteTable",
             pg_catalog.has_table_privilege(
               principal.name, 'public.' || relation.name, 'TRUNCATE'
             ) as "truncateTable",
             pg_catalog.has_table_privilege(
               principal.name, 'public.' || relation.name, 'REFERENCES'
             ) as "referencesTable",
             pg_catalog.has_table_privilege(
               principal.name, 'public.' || relation.name, 'TRIGGER'
             ) as "triggerTable",
             pg_catalog.has_any_column_privilege(
               principal.name, 'public.' || relation.name, 'SELECT'
             ) as "selectColumn",
             pg_catalog.has_any_column_privilege(
               principal.name, 'public.' || relation.name, 'INSERT'
             ) as "insertColumn",
             pg_catalog.has_any_column_privilege(
               principal.name, 'public.' || relation.name, 'UPDATE'
             ) as "updateColumn",
             pg_catalog.has_any_column_privilege(
               principal.name, 'public.' || relation.name, 'REFERENCES'
             ) as "referencesColumn"
        from principal cross join relation
       order by principal.name, relation.name
    `, [IMPORT_TABLES]);
    expect(privileges.rows).toHaveLength(2 * IMPORT_TABLES.length);
    for (const privilege of privileges.rows) {
      expect(privilege).toMatchObject({
        selectTable: false,
        insertTable: false,
        updateTable: false,
        deleteTable: false,
        truncateTable: false,
        referencesTable: false,
        triggerTable: false,
        selectColumn: false,
        insertColumn: false,
        updateColumn: false,
        referencesColumn: false,
      });
    }

    const schemaPrivileges = await admin.query<{
      principal: string;
      usage: boolean;
      create: boolean;
    }>(`
      select principal as principal,
             pg_catalog.has_schema_privilege(principal, 'public', 'USAGE')
               as usage,
             pg_catalog.has_schema_privilege(principal, 'public', 'CREATE')
               as create
        from pg_catalog.unnest(
          ARRAY['app_runtime', 'app_worker']::text[]
        ) as principal
       order by principal
    `);
    expect(schemaPrivileges.rows).toEqual([
      { principal: "app_runtime", usage: true, create: false },
      { principal: "app_worker", usage: true, create: false },
    ]);
  });
});
