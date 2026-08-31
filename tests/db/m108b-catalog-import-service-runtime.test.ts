import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
  autoMapCatalogCsvHeaders,
  catalogCsvTemplate,
  inspectCatalogCsvFile,
  parseCatalogCsvPreview,
  type CatalogCsvPreviewV1,
} from "@/lib/integrations/catalog/import-contract";
import {
  activateCatalogComponent,
  cancelCatalogImport,
  createCatalogComponent,
  getCatalogImport,
  getLatestCatalogImport,
  listCatalogImportRows,
  prepareCatalogImport,
  startCatalogImport,
} from "@/modules/catalog";
import { applyRoleContract } from "../../scripts/db-role-contract.mjs";
import { bootstrapCalculationQueue } from "../../scripts/pgboss-bootstrap.mjs";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";

const STRICT_MIGRATOR_PASSWORD = "m108b_service_migrator";
const STRICT_RUNTIME_PASSWORD = "m108b_service_runtime";
const STRICT_WORKER_PASSWORD = "m108b_service_worker";

const [TEMPLATE_HEADER, TEMPLATE_ROW] = catalogCsvTemplate()
  .trimEnd()
  .split("\r\n");

if (!TEMPLATE_HEADER || !TEMPLATE_ROW) {
  throw new Error("catalog CSV template fixture is malformed");
}

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

function csvRow(
  sku: string,
  displayName = "Synthetisches Beispielmodul",
  purchasePrice = "79,00",
): string {
  return TEMPLATE_ROW
    .replace("BEISPIEL-PV-440", sku)
    .replace("Synthetisches Beispielmodul", displayName)
    .replace("79,00", purchasePrice);
}

function preview(
  fileName: string,
  rows: readonly string[],
): CatalogCsvPreviewV1 {
  const bytes = new TextEncoder().encode(
    `${TEMPLATE_HEADER}\r\n${rows.join("\r\n")}\r\n`,
  );
  const inspection = inspectCatalogCsvFile({ filename: fileName, bytes });
  return parseCatalogCsvPreview({
    filename: fileName,
    bytes,
    mapping: autoMapCatalogCsvHeaders(inspection.headers),
  });
}

type EditorFixture = Readonly<{ workspaceId: string; actorId: string }>;

type QueueRow = Readonly<{
  id: string;
  name: string;
  data: Record<string, unknown>;
  singletonKey: string | null;
  startAfter: Date;
}>;

describe.sequential("M1-08b Katalogimport unter strikten Servicerollen", () => {
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
    const ownerClient = await migrator.connect();
    try {
      await applyRoleContract(ownerClient);
    } finally {
      ownerClient.release();
    }
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

  async function createEditorFixture(): Promise<EditorFixture> {
    if (!admin) throw new Error("Strict-Service-Adminpool fehlt.");
    const fixture = { workspaceId: randomUUID(), actorId: randomUUID() };
    await withTenantOn(admin, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into public.workspace (id, name)
        values (${fixture.workspaceId}::uuid, 'M1-08b Strict Service')
      `);
      await tx.execute(sql`
        insert into public.user_identity (id, email)
        values (
          ${fixture.actorId}::uuid,
          ${`${fixture.actorId}@m108b-service.test`}
        )
      `);
      await tx.execute(sql`
        insert into public.membership (
          workspace_id, user_id, role, capabilities
        ) values (
          ${fixture.workspaceId}::uuid,
          ${fixture.actorId}::uuid,
          'editor',
          '{"manage_catalog":true,"edit_prices":true,"see_purchase_prices":true}'::jsonb
        )
      `);
    });
    return fixture;
  }

  async function asEditor<T>(
    fixture: EditorFixture,
    operation: Parameters<typeof withAuthorizedTenantOn<T>>[3],
  ): Promise<T> {
    if (!runtime) throw new Error("Strict-Service-Runtimepool fehlt.");
    return withAuthorizedTenantOn(
      runtime,
      fixture.actorId,
      fixture.workspaceId,
      operation,
    );
  }

  async function seedActiveComponent(
    fixture: EditorFixture,
    sku: string,
    displayName: string,
  ) {
    const sourcePreview = preview(
      `${sku.toLocaleLowerCase("en-US")}.csv`,
      [csvRow(sku, displayName)],
    );
    const row = sourcePreview.rows[0];
    if (row?.status !== "valid") {
      throw new Error("active component fixture must be valid");
    }
    return asEditor(fixture, async (tx, ctx) => {
      const created = await createCatalogComponent(tx, ctx, {
        ...row.command,
        internalSku: ` ${row.command.internalSku.toLocaleLowerCase("en-US")} `,
      });
      await activateCatalogComponent(tx, ctx, {
        componentId: created.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      });
      return created;
    });
  }

  async function queueRows(importId: string): Promise<QueueRow[]> {
    if (!admin) throw new Error("Strict-Service-Adminpool fehlt.");
    return (await admin.query<QueueRow>(`
      select id::text,
             name,
             data,
             singleton_key as "singletonKey",
             start_after as "startAfter"
        from pgboss.job
       where data->>'importId' = $1
       order by name, singleton_key, id
    `, [importId])).rows;
  }

  it("bindet Bestand, Review, Start und Queue atomar an den echten Runtime-Pfad", async () => {
    if (!admin) throw new Error("Strict-Service-Adminpool fehlt.");
    const fixture = await createEditorFixture();
    await expect(asEditor(fixture, (tx, ctx) =>
      getLatestCatalogImport(tx, ctx))).resolves.toBeNull();
    const unchanged = await seedActiveComponent(
      fixture,
      "EXISTING-SAME",
      "Synthetisches Beispielmodul",
    );
    const revised = await seedActiveComponent(
      fixture,
      "EXISTING-REVISE",
      "Bisheriger Komponentenname",
    );

    const normalized = await admin.query<{ id: string; internalSku: string }>(`
      select id::text, internal_sku as "internalSku"
        from public.catalog_component
       where workspace_id = $1::uuid
       order by internal_sku
    `, [fixture.workspaceId]);
    expect(normalized.rows).toEqual([
      { id: revised.componentId, internalSku: "EXISTING-REVISE" },
      { id: unchanged.componentId, internalSku: "EXISTING-SAME" },
    ]);

    const importPreview = preview("bestand.csv", [
      csvRow("EXISTING-SAME"),
      csvRow("EXISTING-REVISE", "Aktualisierter Komponentenname"),
    ]);
    const intentId = randomUUID();
    const prepared = await asEditor(fixture, (tx, ctx) =>
      prepareCatalogImport(tx, ctx, { intentId, preview: importPreview }));
    expect(prepared).toMatchObject({
      status: "ready_for_review",
      intentId,
      totalCount: 2,
      validCount: 2,
      invalidCount: 0,
      replayed: false,
    });

    const replayedPrepare = await asEditor(fixture, (tx, ctx) =>
      prepareCatalogImport(tx, ctx, { intentId, preview: importPreview }));
    expect(replayedPrepare).toMatchObject({
      status: "ready_for_review",
      importId: prepared.importId,
      intentId,
      replayed: true,
    });

    const details = await asEditor(fixture, (tx, ctx) =>
      getCatalogImport(tx, ctx, { importId: prepared.importId }));
    expect(details).toMatchObject({
      importId: prepared.importId,
      intentId,
      fileName: "bestand.csv",
      counts: { total: 2, valid: 2, invalid: 0 },
      state: "ready_for_review",
      resultCounts: { created: 0, revised: 0, unchanged: 0, conflict: 0 },
    });
    expect(details?.mapping).toEqual(importPreview.mapping);
    await expect(asEditor(fixture, (tx, ctx) =>
      getLatestCatalogImport(tx, ctx))).resolves.toMatchObject({
        importId: prepared.importId,
        intentId,
        state: "ready_for_review",
      });

    const reviewRows = await asEditor(fixture, (tx, ctx) =>
      listCatalogImportRows(tx, ctx, {
        importId: prepared.importId,
        afterRow: 1,
        limit: 100,
      }));
    expect(reviewRows.nextAfterRow).toBeNull();
    expect(reviewRows.rows).toEqual([
      expect.objectContaining({
        rowNumber: 2,
        normalizedSku: "EXISTING-SAME",
        operation: "unchanged",
        targetComponentId: unchanged.componentId,
        expectedComponentId: unchanged.componentId,
        expectedRevision: 1,
        expectedStatus: "active",
        result: null,
      }),
      expect.objectContaining({
        rowNumber: 3,
        normalizedSku: "EXISTING-REVISE",
        operation: "revise",
        targetComponentId: revised.componentId,
        expectedComponentId: revised.componentId,
        expectedRevision: 1,
        expectedStatus: "active",
        result: null,
      }),
    ]);

    const rollback = new Error("intentional outer rollback");
    await expect(asEditor(fixture, async (tx, ctx) => {
      await startCatalogImport(tx, ctx, {
        importId: prepared.importId,
        attestationVersion: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
      });
      throw rollback;
    })).rejects.toBe(rollback);

    await expect(asEditor(fixture, (tx, ctx) =>
      getCatalogImport(tx, ctx, { importId: prepared.importId })))
      .resolves.toMatchObject({
        state: "ready_for_review",
        executionActorId: null,
        attestedBy: null,
        nextAttemptAt: null,
      });
    expect((await queueRows(prepared.importId)).filter(
      (job) => job.name === "catalog.import.v1",
    )).toEqual([]);

    const started = await asEditor(fixture, (tx, ctx) =>
      startCatalogImport(tx, ctx, {
        importId: prepared.importId,
        attestationVersion: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
      }));
    expect(started).toMatchObject({
      status: "queued",
      importId: prepared.importId,
      replayed: false,
      dispatchRequired: true,
    });

    const replayedStart = await asEditor(fixture, (tx, ctx) =>
      startCatalogImport(tx, ctx, {
        importId: prepared.importId,
        attestationVersion: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
      }));
    expect(replayedStart).toEqual({
      status: "replayed",
      state: "queued",
      importId: prepared.importId,
      dispatchRequired: true,
    });

    const jobs = await queueRows(prepared.importId);
    const importJobs = jobs.filter((job) => job.name === "catalog.import.v1");
    const cleanupJobs = jobs.filter(
      (job) => job.name === "catalog.import.cleanup.v1",
    );
    expect(importJobs).toHaveLength(1);
    expect(cleanupJobs).toHaveLength(1);
    expect(importJobs[0]).toMatchObject({
      singletonKey: `${prepared.importId}:claim:1:0`,
      data: {
        schemaVersion: "catalog-import-dispatch.v1",
        workspaceId: fixture.workspaceId,
        importId: prepared.importId,
      },
    });
    expect(Object.keys(importJobs[0]?.data ?? {}).sort()).toEqual([
      "importId",
      "schemaVersion",
      "workspaceId",
    ]);
  });

  it("bewahrt Reviewdaten bis zur Frist und redigiert sie danach service-sichtbar", async () => {
    if (!admin || !worker) throw new Error("Strict-Service-Pools fehlen.");
    const fixture = await createEditorFixture();
    const importPreview = preview("redaktion.csv", [
      csvRow("REDACTION-VALID"),
      csvRow("REDACTION-INVALID", "Ungueltige Preiszeile", "kaputt"),
    ]);
    expect(importPreview.counts).toEqual({ total: 2, valid: 1, invalid: 1 });

    const prepared = await asEditor(fixture, (tx, ctx) =>
      prepareCatalogImport(tx, ctx, {
        intentId: randomUUID(),
        preview: importPreview,
      }));
    const beforeRows = await asEditor(fixture, (tx, ctx) =>
      listCatalogImportRows(tx, ctx, {
        importId: prepared.importId,
        afterRow: 1,
        limit: 100,
      }));
    expect(beforeRows.rows[0]).toMatchObject({
      normalizedSku: "REDACTION-VALID",
      operation: "create",
      sourceCommand: expect.objectContaining({ internalSku: "REDACTION-VALID" }),
    });
    expect(beforeRows.rows[1]).toMatchObject({
      normalizedSku: "REDACTION-INVALID",
      validationStatus: "invalid",
      errors: [expect.objectContaining({
        code: "invalid_money",
        sourceHeader: "purchasePriceNet",
      })],
    });

    await withTenantOn(admin, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`
        update public.catalog_import_job
           set created_at = pg_catalog.transaction_timestamp() - interval '31 days',
               updated_at = pg_catalog.transaction_timestamp() - interval '31 days',
               preview_expires_at =
                 pg_catalog.transaction_timestamp() - interval '24 days'
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${prepared.importId}::uuid
      `);
    });

    const cancelled = await asEditor(fixture, (tx, ctx) =>
      cancelCatalogImport(tx, ctx, { importId: prepared.importId }));
    expect(cancelled).toMatchObject({
      status: "cancelled_before_start",
      importId: prepared.importId,
      replayed: false,
    });
    const cancelReplay = await asEditor(fixture, (tx, ctx) =>
      cancelCatalogImport(tx, ctx, { importId: prepared.importId }));
    expect(cancelReplay).toMatchObject({
      status: "cancelled_before_start",
      importId: prepared.importId,
      replayed: true,
    });
    expect((await queueRows(prepared.importId)).filter(
      (job) => job.name === "catalog.import.cleanup.v1",
    )).toHaveLength(2);

    const cleaned = await withTenantOn(worker, fixture.workspaceId, (tx) =>
      tx.execute<{ import_id: string; redacted_at: Date }>(sql`
        select *
          from public.cleanup_catalog_import_snapshots_v1(
            ${fixture.workspaceId}::uuid,
            100
          )
      `));
    expect(cleaned.rows).toHaveLength(1);
    expect(cleaned.rows[0]?.import_id).toBe(prepared.importId);

    const afterDetails = await asEditor(fixture, (tx, ctx) =>
      getCatalogImport(tx, ctx, { importId: prepared.importId }));
    expect(afterDetails).toMatchObject({
      importId: prepared.importId,
      fileName: null,
      mapping: null,
      state: "cancelled_before_start",
      snapshotRedactedAt: expect.any(String),
    });

    const afterRows = await asEditor(fixture, (tx, ctx) =>
      listCatalogImportRows(tx, ctx, {
        importId: prepared.importId,
        afterRow: 1,
        limit: 100,
      }));
    expect(afterRows.rows[0]).toMatchObject({
      validationStatus: "valid",
      normalizedSku: null,
      operation: "create",
      sourceCommand: null,
      targetComponentId: beforeRows.rows[0]?.targetComponentId,
      result: null,
    });
    expect(afterRows.rows[1]).toMatchObject({
      validationStatus: "invalid",
      normalizedSku: null,
      sourceCommand: null,
      errors: [expect.objectContaining({
        code: "invalid_money",
        sourceHeader: null,
      })],
      result: null,
    });
  });
});
