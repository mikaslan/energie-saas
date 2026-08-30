import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgBoss } from "pg-boss";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalizeOfferJson } from "@/lib/integrations/offers/contract";
import {
  buildOfferPdfDraftInput,
  validateOfferPdfDraftInput,
  type OfferPdfDraftInputV1,
} from "@/lib/integrations/offers/pdf-contract";
import { withTenantOn } from "@/lib/db/tenant";
import { applyRoleContract } from "../../scripts/db-role-contract.mjs";
import {
  LEGACY_CALCULATION_QUEUE_OPTIONS,
  OFFER_PDF_QUEUE_OPTIONS,
} from "../../scripts/pgboss-bootstrap.mjs";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";
import { testPool } from "../setup/test-db";
import { tenantFixtures } from "../setup/tenant-fixtures";

type OfferPdfBinding = {
  workspaceId: string;
  contactId: string;
  projectId: string;
  offerId: string;
  variantId: string;
  variantRevisionId: string;
  variantRevision: number;
  variantSnapshotSha256: Buffer;
  actorId: string;
};

type DraftFixture = OfferPdfBinding & {
  draftId: string;
  inputSnapshot: Record<string, unknown>;
  inputSha256: Buffer;
};

type ErasureGraph = Record<string, unknown> & {
  contactId: string;
  offerIds: string[];
  offerVariantIds: string[];
  offerVariantRevisionIds: string[];
  offerVariantSectionIds: string[];
  offerBomLineIds: string[];
  offerPdfDraftIds?: string[];
};

const INPUT_VERSION = "offer-pdf-draft-input.v1";
const CANONICALIZATION_VERSION = "offer-jcs.v1";
const TEMPLATE_VERSION = "offer-pdf-draft-template.v1";
const RENDERER_RECIPE_VERSION =
  "offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac";

function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function asIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function offerPdfReservationKey(binding: OfferPdfBinding): Buffer {
  return sha256(JSON.stringify({
    schemaVersion: "offer-pdf-draft-reservation.v1",
    workspaceId: binding.workspaceId,
    variantId: binding.variantId,
    variantRevision: binding.variantRevision,
    variantSnapshotSha256: binding.variantSnapshotSha256.toString("hex"),
    inputVersion: INPUT_VERSION,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    templateVersion: TEMPLATE_VERSION,
    rendererRecipeVersion: RENDERER_RECIPE_VERSION,
  }));
}

function forgeOfferPdfDraftInput(
  input: OfferPdfDraftInputV1,
): OfferPdfDraftInputV1 {
  const forged = structuredClone(input);
  forged.recipient.displayName = "Manipulierte Empfaengerin";
  forged.installationSite.formattedAddress = "Fremdweg 99, 99999 Fremdstadt";
  const line = forged.sections[0]?.lines[0];
  if (!line) throw new Error("PDF-Testprojektion enthaelt keine Position.");
  const oldNet = line.finalNetCents;
  const oldTax = line.taxCents;
  const oldGross = line.grossCents;
  line.salesUnitNetCents += 137;
  line.finalNetCents += 137;
  line.taxCents = Number(
    (BigInt(line.finalNetCents) * BigInt(line.taxRateBps) + BigInt(5_000))
      / BigInt(10_000),
  );
  line.grossCents = line.finalNetCents + line.taxCents;
  const netDelta = line.finalNetCents - oldNet;
  const taxDelta = line.taxCents - oldTax;
  const grossDelta = line.grossCents - oldGross;
  if (line.positionType === "optional") {
    forged.totals.optionalNetCents += netDelta;
    forged.totals.optionalTaxCents += taxDelta;
    forged.totals.optionalGrossCents += grossDelta;
  } else {
    forged.totals.basisNetCents += netDelta;
    forged.totals.basisTaxCents += taxDelta;
    forged.totals.basisGrossCents += grossDelta;
  }
  const validated = validateOfferPdfDraftInput(forged);
  if (!validated.ok) {
    throw new Error(`Adversarialer PDF-Input ist ungueltig: ${validated.paths.join(", ")}`);
  }
  return validated.value;
}

async function tenantTransaction<Row>(
  workspaceId: string,
  callback: (client: PoolClient) => Promise<Row>,
): Promise<Row> {
  return tenantTransactionOn(testPool, workspaceId, callback);
}

async function tenantTransactionOn<Row>(
  pool: Pool,
  workspaceId: string,
  callback: (client: PoolClient) => Promise<Row>,
): Promise<Row> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local transaction isolation level read committed");
    await client.query(
      `select pg_catalog.set_config('app.actor_id', '', true),
              pg_catalog.set_config('app.workspace_id', $1, true)`,
      [workspaceId],
    );
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function prepareOffer(workspaceId: string): Promise<OfferPdfBinding> {
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${workspaceId}::uuid, 'M2-02 PDF DB Test')
    `);
  });
  await withTenantOn(testPool, workspaceId, async (tx) => {
    const factory = tenantFixtures.offer;
    if (!factory) throw new Error("Offer-Tenant-Fixture fehlt.");
    await factory(tx, workspaceId);
  });

  return tenantTransaction(workspaceId, async (client) => {
    const result = await client.query<OfferPdfBinding & QueryResultRow>(`
      select offer_record.workspace_id as "workspaceId",
             offer_record.contact_id as "contactId",
             offer_record.project_id as "projectId",
             offer_record.id as "offerId",
             variant.id as "variantId",
             revision.id as "variantRevisionId",
             revision.revision as "variantRevision",
             revision.snapshot_sha256 as "variantSnapshotSha256",
             offer_record.created_by as "actorId"
        from public.offer as offer_record
        join public.offer_variant as variant
          on variant.workspace_id = offer_record.workspace_id
         and variant.offer_id = offer_record.id
        join public.offer_variant_revision as revision
          on revision.workspace_id = variant.workspace_id
         and revision.offer_id = variant.offer_id
         and revision.variant_id = variant.id
         and revision.revision = variant.current_revision
       where offer_record.workspace_id = $1::uuid
       order by offer_record.id, variant.ordinal
       limit 1
    `, [workspaceId]);
    const row = result.rows[0];
    if (!row) throw new Error("M2-02 Offer-Bindung fehlt.");
    return row;
  });
}

async function insertDraft(
  binding: OfferPdfBinding,
): Promise<DraftFixture> {
  const draftId = randomUUID();
  const persisted = await tenantTransaction(binding.workspaceId, async (client) => {
    return client.query<{
      input_snapshot: Record<string, unknown>;
      input_sha256: Buffer;
    }>(`
      insert into public.offer_pdf_draft (
        id, workspace_id, project_id, offer_id, variant_id,
        variant_revision_id, variant_revision, variant_snapshot_sha256,
        input_version, canonicalization_version, template_version,
        renderer_recipe_version, created_by
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
        $6::uuid, $7, $8::bytea,
        $9, $10, $11, $12, $13::uuid
      )
      returning input_snapshot, input_sha256
    `, [
      draftId,
      binding.workspaceId,
      binding.projectId,
      binding.offerId,
      binding.variantId,
      binding.variantRevisionId,
      binding.variantRevision,
      binding.variantSnapshotSha256,
      INPUT_VERSION,
      CANONICALIZATION_VERSION,
      TEMPLATE_VERSION,
      RENDERER_RECIPE_VERSION,
      binding.actorId,
    ]);
  });
  const row = persisted.rows[0];
  if (!row) throw new Error("Abgeleiteter PDF-Draft fehlt.");
  const inputSnapshot = row.input_snapshot;
  const inputSha256 = row.input_sha256;
  return { ...binding, draftId, inputSnapshot, inputSha256 };
}

async function queryAs<Row extends QueryResultRow = QueryResultRow>(
  workspaceId: string,
  query: string,
  values: unknown[] = [],
): Promise<QueryResult<Row>> {
  return tenantTransaction(workspaceId, (client) => client.query<Row>(query, values));
}

async function claimDraft(fixture: DraftFixture, attempt: number): Promise<void> {
  await queryAs(
    fixture.workspaceId,
    `update public.offer_pdf_draft
        set state = 'running',
            attempt_count = $3,
            lease_token = $2::uuid,
            lease_expires_at = pg_catalog.statement_timestamp() + interval '30 minutes',
            started_at = coalesce(started_at, pg_catalog.statement_timestamp()),
            updated_at = pg_catalog.statement_timestamp()
      where workspace_id = $1::uuid and id = $4::uuid`,
    [fixture.workspaceId, randomUUID(), attempt, fixture.draftId],
  );
}

async function insertTombstone(
  workspaceId: string,
  contactId: string,
  operationId: string,
  graph: ErasureGraph,
): Promise<void> {
  await tenantTransaction(workspaceId, async (client) => {
    await client.query(
      `insert into public.erasure_operation_locator (operation_id, scope_id)
       values ($1::uuid, $2::uuid)`,
      [operationId, workspaceId],
    );
    await client.query(`
      with material as (
        select $1::uuid as operation_id,
               $2::uuid as workspace_id,
               $3::uuid as contact_id,
               'inactive_lead_24_months'::text as reason,
               $4::jsonb as graph_ids,
               pg_catalog.statement_timestamp() as eligible_at,
               pg_catalog.statement_timestamp() as erased_at
      ), graph_hashed as (
        select material.*,
               pg_catalog.sha256(pg_catalog.convert_to(
                 material.graph_ids::text, 'UTF8'
               )) as graph_sha256
          from material
      )
      insert into public.erasure_tombstone (
        operation_id, workspace_id, contact_id, reason,
        graph_sha256, tombstone_sha256, graph_ids, eligible_at, erased_at
      )
      select operation_id, workspace_id, contact_id, reason,
             graph_sha256,
             pg_catalog.sha256(pg_catalog.convert_to(
               pg_catalog.concat_ws(
                 '|', operation_id::text, workspace_id::text,
                 contact_id::text, reason,
                 pg_catalog.encode(graph_sha256, 'hex'),
                 pg_catalog.encode(
                   pg_catalog.timestamptz_send(eligible_at), 'hex'
                 ),
                 pg_catalog.encode(
                   pg_catalog.timestamptz_send(erased_at), 'hex'
                 )
               ),
               'UTF8'
             )),
             graph_ids, eligible_at, erased_at
        from graph_hashed
    `, [
      operationId,
      workspaceId,
      contactId,
      JSON.stringify(graph),
    ]);
  });
}

function serviceUrl(
  embedded: EmbeddedTestDatabase,
  role: "app_migrator" | "app_runtime" | "app_worker",
  password: string,
): string {
  const url = new URL(embedded.url);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function bootstrapStrictRolesAndPgBoss(
  embedded: EmbeddedTestDatabase,
  admin: Pool,
): Promise<void> {
  await admin.query(`
    create role app_owner nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_migrator login password 'm202_migrator'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_runtime login password 'm202_runtime'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_system login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_auth login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_worker login password 'm202_worker'
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
    revoke all privileges on database energie_saas_test from app_test;
    alter schema public owner to app_owner;
    revoke all on schema public from public, app_test;
    create schema pgboss authorization app_worker;
  `);

  const boss = new PgBoss({
    connectionString: serviceUrl(embedded, "app_worker", "m202_worker"),
    schema: "pgboss",
    createSchema: false,
  });
  const errors: unknown[] = [];
  boss.on("error", (error) => errors.push(error));
  try {
    await boss.start();
    await boss.createQueue("calculation.execute", LEGACY_CALCULATION_QUEUE_OPTIONS);
    await boss.createQueue("pdf.render", OFFER_PDF_QUEUE_OPTIONS);
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
  expect(errors, `pg-boss-Bootstrap: ${errors.map(String).join(", ")}`).toEqual([]);
}

async function strictOfferBinding(pool: Pool, workspaceId: string): Promise<OfferPdfBinding> {
  await withTenantOn(pool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${workspaceId}::uuid, 'M2-02 Strict ACL')
    `);
  });
  await withTenantOn(pool, workspaceId, async (tx) => {
    const factory = tenantFixtures.offer;
    if (!factory) throw new Error("Offer-Tenant-Fixture fehlt.");
    await factory(tx, workspaceId);
  });
  return tenantTransactionOn(pool, workspaceId, async (client) => {
    const result = await client.query<OfferPdfBinding & QueryResultRow>(`
      select offer_record.workspace_id as "workspaceId",
             offer_record.contact_id as "contactId",
             offer_record.project_id as "projectId",
             offer_record.id as "offerId",
             variant.id as "variantId",
             revision.id as "variantRevisionId",
             revision.revision as "variantRevision",
             revision.snapshot_sha256 as "variantSnapshotSha256",
             offer_record.created_by as "actorId"
        from public.offer as offer_record
        join public.offer_variant as variant
          on variant.workspace_id = offer_record.workspace_id
         and variant.offer_id = offer_record.id
        join public.offer_variant_revision as revision
          on revision.workspace_id = variant.workspace_id
         and revision.offer_id = variant.offer_id
         and revision.variant_id = variant.id
         and revision.revision = variant.current_revision
       where offer_record.workspace_id = $1::uuid
       order by offer_record.id, variant.ordinal
       limit 1
    `, [workspaceId]);
    const binding = result.rows[0];
    if (!binding) throw new Error("Strict-ACL-Offer-Bindung fehlt.");
    return binding;
  });
}

describe.sequential("M2-02 Offer-PDF-Datenbankvertrag", () => {
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  let bindingA: OfferPdfBinding;
  let bindingB: OfferPdfBinding;
  let draftA: DraftFixture;
  let draftB: DraftFixture;

  beforeAll(async () => {
    bindingA = await prepareOffer(workspaceA);
    bindingB = await prepareOffer(workspaceB);
    // Das allgemeine Tenant-Fixture enthaelt absichtlich einen laufenden
    // Calculation-Job. Fuer diese Suite wird er terminalisiert, damit der
    // identische SQLSTATE beim folgenden Erase beweisbar vom PDF-Lease-Guard
    // und nicht vom bereits bestehenden M1-07-Guard stammt.
    for (const binding of [bindingA, bindingB]) {
      await queryAs(
        binding.workspaceId,
        `update public.project_calculation_job
            set state = 'failed_final',
                lease_token = null,
                lease_expires_at = null,
                error_code = 'm202_fixture_terminal',
                error_retryable = false,
                finished_at = pg_catalog.statement_timestamp()
          where workspace_id = $1::uuid
            and project_id = $2::uuid
            and state = 'running'`,
        [binding.workspaceId, binding.projectId],
      );
    }
  }, 120_000);

  it("migriert additiv mit FORCE RLS, kanonischer Policy und beiden Guards", async () => {
    const journal = JSON.parse(
      readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 33,
      tag: "0033_supreme_jocasta",
    });

    const relation = await testPool.query<{
      owner: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select owner.rolname as owner,
             relation.relrowsecurity,
             relation.relforcerowsecurity
        from pg_catalog.pg_class as relation
        join pg_catalog.pg_roles as owner on owner.oid = relation.relowner
       where relation.oid = 'public.offer_pdf_draft'::regclass
    `);
    expect(relation.rows).toEqual([{
      owner: "app_test",
      relrowsecurity: true,
      relforcerowsecurity: true,
    }]);

    const policies = await testPool.query<{
      policyname: string;
      permissive: string;
      roles: string;
      cmd: string;
      same_predicate: boolean;
    }>(`
      select policyname, permissive, roles::text as roles, cmd,
             qual = with_check as same_predicate
        from pg_catalog.pg_policies
       where schemaname = 'public' and tablename = 'offer_pdf_draft'
       order by policyname
    `);
    expect(policies.rows).toEqual([{
      policyname: "tenant_isolation",
      permissive: "PERMISSIVE",
      roles: "{public}",
      cmd: "ALL",
      same_predicate: true,
    }]);

    const triggers = await testPool.query<{
      trigger_name: string;
      function_name: string;
      tgtype: number;
    }>(`
      select trigger_row.tgname as trigger_name,
             procedure.proname as function_name,
             trigger_row.tgtype
        from pg_catalog.pg_trigger as trigger_row
        join pg_catalog.pg_proc as procedure on procedure.oid = trigger_row.tgfoid
       where trigger_row.tgrelid = 'public.offer_pdf_draft'::regclass
         and not trigger_row.tgisinternal
       order by trigger_row.tgname
    `);
    expect(triggers.rows).toEqual([
      {
        trigger_name: "offer_pdf_draft_input_derive",
        function_name: "derive_offer_pdf_draft_input",
        tgtype: 7,
      },
      {
        trigger_name: "offer_pdf_draft_mutation_guard",
        function_name: "guard_offer_pdf_draft_mutation",
        tgtype: 27,
      },
      {
        trigger_name: "offer_pdf_draft_no_truncate",
        function_name: "forbid_mutation",
        tgtype: 34,
      },
    ]);

    const checks = await testPool.query<{ name: string; definition: string }>(`
      select constraint_row.conname as name,
             pg_catalog.pg_get_constraintdef(constraint_row.oid, false) as definition
        from pg_catalog.pg_constraint as constraint_row
       where constraint_row.conrelid = 'public.offer_pdf_draft'::regclass
         and constraint_row.conname in (
           'offer_pdf_draft_artifact_ck',
           'offer_pdf_draft_input_hash_ck'
         )
       order by constraint_row.conname
    `);
    expect(checks.rows).toHaveLength(2);
    expect(checks.rows.find((row) => row.name === "offer_pdf_draft_input_hash_ck")?.definition)
      .toMatch(/canonicalize_offer_json_v1/);
    expect(checks.rows.find((row) => row.name === "offer_pdf_draft_artifact_ck")?.definition)
      .toMatch(/sha256\(artifact_bytes\)/);
  });

  it("erlaubt Runtime nur Requestspalten und blockiert terminale INSERT-Umgehungen", async () => {
    const embedded = await startEmbeddedPostgres();
    const admin = new Pool({ connectionString: embedded.superuserUrl, max: 1 });
    let migrator: Pool | undefined;
    let runtime: Pool | undefined;
    let worker: Pool | undefined;
    try {
      await bootstrapStrictRolesAndPgBoss(embedded, admin);
      migrator = new Pool({
        connectionString: serviceUrl(embedded, "app_migrator", "m202_migrator"),
        options: "-c role=app_owner",
        max: 2,
      });
      await migrate(drizzle(migrator), { migrationsFolder: resolve("drizzle") });
      const contractClient = await migrator.connect();
      try {
        await contractClient.query("begin");
        await applyRoleContract(contractClient);
        await contractClient.query("commit");
      } catch (error) {
        await contractClient.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        contractClient.release();
      }

      const workspaceId = randomUUID();
      const binding = await strictOfferBinding(migrator, workspaceId);
      runtime = new Pool({
        connectionString: serviceUrl(embedded, "app_runtime", "m202_runtime"),
        max: 1,
      });
      worker = new Pool({
        connectionString: serviceUrl(embedded, "app_worker", "m202_worker"),
        max: 1,
      });
      const sourceProjection = await tenantTransactionOn(
        migrator,
        workspaceId,
        (client) => client.query<{
          offer_number: string;
          revision_snapshot: unknown;
        }>(`
          select offer_record.offer_number, revision.revision_snapshot
            from public.offer_variant_revision as revision
            join public.offer as offer_record
              on offer_record.workspace_id = revision.workspace_id
             and offer_record.id = revision.offer_id
             and offer_record.project_id = revision.project_id
           where revision.workspace_id = $1::uuid
             and revision.id = $2::uuid
        `, [workspaceId, binding.variantRevisionId]),
      );
      const sourceRow = sourceProjection.rows[0];
      if (!sourceRow) throw new Error("Strict-ACL-PDF-Source fehlt.");

      const canonicalizer = await migrator.query<{
        owner: string;
        language: string;
        volatility: string;
        security_definer: boolean;
        strict: boolean;
        parallel: string;
        config: string[] | null;
        source: string;
        runtime_execute: boolean;
        system_execute: boolean;
        auth_execute: boolean;
        worker_execute: boolean;
        erasure_execute: boolean;
      }>(`
        select owner.rolname as owner,
               language.lanname as language,
               routine.provolatile as volatility,
               routine.prosecdef as security_definer,
               routine.proisstrict as strict,
               routine.proparallel as parallel,
               routine.proconfig as config,
               routine.prosrc as source,
               pg_catalog.has_function_privilege(
                 'app_runtime', routine.oid, 'EXECUTE'
               ) as runtime_execute,
               pg_catalog.has_function_privilege(
                 'app_system', routine.oid, 'EXECUTE'
               ) as system_execute,
               pg_catalog.has_function_privilege(
                 'app_auth', routine.oid, 'EXECUTE'
               ) as auth_execute,
               pg_catalog.has_function_privilege(
                 'app_worker', routine.oid, 'EXECUTE'
               ) as worker_execute,
               pg_catalog.has_function_privilege(
                 'app_erasure', routine.oid, 'EXECUTE'
               ) as erasure_execute
          from pg_catalog.pg_proc as routine
          join pg_catalog.pg_namespace as namespace
            on namespace.oid = routine.pronamespace
          join pg_catalog.pg_roles as owner on owner.oid = routine.proowner
          join pg_catalog.pg_language as language on language.oid = routine.prolang
         where namespace.nspname = 'public'
           and routine.proname = 'canonicalize_offer_json_v1'
           and pg_catalog.oidvectortypes(routine.proargtypes) = 'jsonb'
      `);
      expect(canonicalizer.rows).toHaveLength(1);
      const canonicalizerContract = canonicalizer.rows[0];
      if (!canonicalizerContract) throw new Error("Offer-Canonicalizer fehlt.");
      const { source: canonicalizerSource, ...canonicalizerMetadata } = canonicalizerContract;
      expect(canonicalizerMetadata).toEqual({
        owner: "app_owner",
        language: "plpgsql",
        volatility: "i",
        security_definer: false,
        strict: true,
        parallel: "s",
        config: ["search_path=pg_catalog"],
        runtime_execute: true,
        system_execute: false,
        auth_execute: false,
        worker_execute: true,
        erasure_execute: false,
      });
      // Der exakte Quellhash schliesst neben SECURITY INVOKER auch versteckte
      // Tabellenzugriffe oder dynamische SQL-Erweiterungen des versiegelten
      // Canonicalizers aus.
      expect(sha256(canonicalizerSource).toString("hex")).toBe(
        "0b5cdc7c4aa05552def26bc36f3f64bfc73e18689b646b473db607ad858ca85c",
      );

      const canonicalizerAcl = await migrator.query<{
        grantee: string;
        grantor: string;
        privilege_type: string;
        is_grantable: boolean;
      }>(`
        select coalesce(grantee.rolname, 'PUBLIC') as grantee,
               grantor.rolname as grantor,
               acl.privilege_type,
               acl.is_grantable
          from pg_catalog.pg_proc as routine
          join pg_catalog.pg_namespace as namespace
            on namespace.oid = routine.pronamespace
         cross join lateral pg_catalog.aclexplode(
           coalesce(
             routine.proacl,
             pg_catalog.acldefault('f', routine.proowner)
           )
         ) as acl
          join pg_catalog.pg_roles as grantor on grantor.oid = acl.grantor
          left join pg_catalog.pg_roles as grantee on grantee.oid = acl.grantee
         where namespace.nspname = 'public'
           and routine.proname = 'canonicalize_offer_json_v1'
           and pg_catalog.oidvectortypes(routine.proargtypes) = 'jsonb'
           and acl.grantee <> routine.proowner
         order by grantee, acl.privilege_type, grantor
      `);
      expect(canonicalizerAcl.rows).toEqual([
        {
          grantee: "app_runtime",
          grantor: "app_owner",
          privilege_type: "EXECUTE",
          is_grantable: false,
        },
        {
          grantee: "app_worker",
          grantor: "app_owner",
          privilege_type: "EXECUTE",
          is_grantable: false,
        },
      ]);
      const canonicalized = await runtime.query<{ value: string }>(`
        select public.canonicalize_offer_json_v1(
          '{"z":2,"a":{"y":true,"b":null}}'::jsonb
        ) as value
      `);
      expect(canonicalized.rows).toEqual([{
        value: '{"a":{"b":null,"y":true},"z":2}',
      }]);

      const allowedColumns = [
        "canonicalization_version",
        "created_by",
        "id",
        "input_version",
        "offer_id",
        "project_id",
        "renderer_recipe_version",
        "template_version",
        "variant_id",
        "variant_revision",
        "variant_revision_id",
        "variant_snapshot_sha256",
        "workspace_id",
      ];
      const forbiddenColumns = [
        "artifact_bytes",
        "artifact_mime_type",
        "artifact_sha256",
        "artifact_size_bytes",
        "attempt_count",
        "created_at",
        "error_code",
        "error_retryable",
        "finished_at",
        "input_sha256",
        "input_snapshot",
        "lease_expires_at",
        "lease_token",
        "next_attempt_at",
        "reservation_key",
        "started_at",
        "state",
        "updated_at",
      ];
      const privileges = await migrator.query<{
        column_name: string;
        may_insert: boolean;
      }>(`
        select column_name,
               pg_catalog.has_column_privilege(
                 'app_runtime',
                 'public.offer_pdf_draft',
                 column_name,
                 'INSERT'
               ) as may_insert
          from pg_catalog.unnest($1::text[]) as column_name
         order by column_name
      `, [[...allowedColumns, ...forbiddenColumns]]);
      expect(
        privileges.rows.filter((row) => row.may_insert).map((row) => row.column_name),
      ).toEqual(allowedColumns);
      expect(
        privileges.rows.filter((row) => !row.may_insert).map((row) => row.column_name),
      ).toEqual(forbiddenColumns);
      const tableInsert = await migrator.query<{ may_insert: boolean }>(`
        select pg_catalog.has_table_privilege(
          'app_runtime', 'public.offer_pdf_draft', 'INSERT'
        ) as may_insert
      `);
      expect(tableInsert.rows).toEqual([{ may_insert: false }]);

      const adversarialPreparedAt = "2026-08-30T12:34:56.000Z";
      const genuineInput = buildOfferPdfDraftInput({
        offerNumber: sourceRow.offer_number,
        preparedAt: adversarialPreparedAt,
        variantSnapshot: sourceRow.revision_snapshot,
      });
      const forgedInput = forgeOfferPdfDraftInput(genuineInput);
      const forgedInputSha256 = sha256(canonicalizeOfferJson(forgedInput));
      const adversarialDraftId = randomUUID();
      await expect(tenantTransactionOn(runtime, workspaceId, (client) => client.query(`
        insert into public.offer_pdf_draft (
          id, workspace_id, project_id, offer_id, variant_id,
          variant_revision_id, variant_revision, variant_snapshot_sha256,
          input_version, canonicalization_version, template_version,
          renderer_recipe_version, input_snapshot, input_sha256, created_by
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          $6::uuid, $7, $8::bytea, $9, $10, $11, $12,
          $13::jsonb, $14::bytea, $15::uuid
        )
      `, [
        adversarialDraftId,
        workspaceId,
        binding.projectId,
        binding.offerId,
        binding.variantId,
        binding.variantRevisionId,
        binding.variantRevision,
        binding.variantSnapshotSha256,
        INPUT_VERSION,
        CANONICALIZATION_VERSION,
        TEMPLATE_VERSION,
        RENDERER_RECIPE_VERSION,
        JSON.stringify(forgedInput),
        forgedInputSha256,
        binding.actorId,
      ]))).rejects.toMatchObject({ code: "42501" });

      const poisonedReservationDraftId = randomUUID();
      await expect(tenantTransactionOn(runtime, workspaceId, (client) => client.query(`
        insert into public.offer_pdf_draft (
          id, workspace_id, project_id, offer_id, variant_id,
          variant_revision_id, variant_revision, variant_snapshot_sha256,
          input_version, canonicalization_version, template_version,
          renderer_recipe_version, reservation_key, created_by
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          $6::uuid, $7, $8::bytea, $9, $10, $11, $12,
          decode(repeat('00', 32), 'hex'), $13::uuid
        )
      `, [
        poisonedReservationDraftId,
        workspaceId,
        binding.projectId,
        binding.offerId,
        binding.variantId,
        binding.variantRevisionId,
        binding.variantRevision,
        binding.variantSnapshotSha256,
        INPUT_VERSION,
        CANONICALIZATION_VERSION,
        TEMPLATE_VERSION,
        RENDERER_RECIPE_VERSION,
        binding.actorId,
      ]))).rejects.toMatchObject({ code: "42501" });

      await expect(tenantTransactionOn(runtime, workspaceId, (client) => client.query(`
        insert into public.offer_pdf_draft (
          state, lease_token, error_code, artifact_bytes
        ) values (
          'succeeded', $1::uuid, 'forged', decode(repeat('00', 100), 'hex')
        )
      `, [randomUUID()]))).rejects.toMatchObject({ code: "42501" });

      const draftId = randomUUID();
      const inserted = await tenantTransactionOn(runtime, workspaceId, (client) =>
        client.query<{
          state: string;
          attempt_count: number;
          input_snapshot: OfferPdfDraftInputV1;
          input_sha256_hex: string;
          reservation_key_hex: string;
          created_at: Date | string;
          next_attempt_at: Date | string;
          updated_at: Date | string;
        }>(`
          insert into public.offer_pdf_draft (
            id, workspace_id, project_id, offer_id, variant_id,
            variant_revision_id, variant_revision, variant_snapshot_sha256,
            input_version, canonicalization_version, template_version,
            renderer_recipe_version, created_by
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
            $6::uuid, $7, $8::bytea, $9, $10, $11, $12,
            $13::uuid
          )
          returning state, attempt_count, input_snapshot,
                    pg_catalog.encode(input_sha256, 'hex') as input_sha256_hex,
                    pg_catalog.encode(reservation_key, 'hex') as reservation_key_hex,
                    created_at, next_attempt_at, updated_at
        `, [
          draftId,
          workspaceId,
          binding.projectId,
          binding.offerId,
          binding.variantId,
          binding.variantRevisionId,
          binding.variantRevision,
          binding.variantSnapshotSha256,
          INPUT_VERSION,
          CANONICALIZATION_VERSION,
          TEMPLATE_VERSION,
          RENDERER_RECIPE_VERSION,
          binding.actorId,
        ]),
      );
      const insertedRow = inserted.rows[0];
      if (!insertedRow) throw new Error("Strict-ACL-PDF-Draft fehlt.");
      const authoritativePreparedAt = asIso(insertedRow.created_at);
      const expectedInput = buildOfferPdfDraftInput({
        offerNumber: sourceRow.offer_number,
        preparedAt: authoritativePreparedAt,
        variantSnapshot: sourceRow.revision_snapshot,
      });
      expect(insertedRow.input_snapshot).toEqual(expectedInput);
      expect(insertedRow.input_sha256_hex).toBe(
        sha256(canonicalizeOfferJson(expectedInput)).toString("hex"),
      );
      expect(insertedRow.reservation_key_hex).toBe(
        offerPdfReservationKey(binding).toString("hex"),
      );
      expect(insertedRow.state).toBe("queued");
      expect(insertedRow.attempt_count).toBe(0);
      expect(asIso(insertedRow.next_attempt_at)).toBe(authoritativePreparedAt);
      expect(asIso(insertedRow.updated_at)).toBe(authoritativePreparedAt);

      const claimed = await tenantTransactionOn(worker, workspaceId, (client) =>
        client.query<{ state: string; attempt_count: number }>(`
          update public.offer_pdf_draft
             set state = 'running',
                 attempt_count = 1,
                 lease_token = $2::uuid,
                 lease_expires_at = pg_catalog.statement_timestamp()
                   + interval '5 minutes',
                 started_at = pg_catalog.statement_timestamp(),
                 updated_at = pg_catalog.statement_timestamp()
           where workspace_id = $1::uuid
             and id = $3::uuid
          returning state, attempt_count
        `, [workspaceId, randomUUID(), draftId]),
      );
      expect(claimed.rows).toEqual([{ state: "running", attempt_count: 1 }]);
    } finally {
      await worker?.end().catch(() => undefined);
      await runtime?.end().catch(() => undefined);
      await migrator?.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      await embedded.stop().catch(() => undefined);
    }
  }, 120_000);

  it("leitet den Input-Hash DB-seitig ab und isoliert Reads wie Writes pro Tenant", async () => {
    draftA = await insertDraft(bindingA);
    draftB = await insertDraft(bindingB);
    expect(draftA.inputSha256).toEqual(
      sha256(canonicalizeOfferJson(draftA.inputSnapshot)),
    );
    expect(validateOfferPdfDraftInput(draftA.inputSnapshot).ok).toBe(true);

    const own = await queryAs<{ id: string }>(
      workspaceA,
      "select id from public.offer_pdf_draft where id = $1::uuid",
      [draftA.draftId],
    );
    expect(own.rows).toEqual([{ id: draftA.draftId }]);

    const foreignRead = await queryAs<{ id: string }>(
      workspaceB,
      "select id from public.offer_pdf_draft where id = $1::uuid",
      [draftA.draftId],
    );
    expect(foreignRead.rows).toEqual([]);

    const foreignWrite = await queryAs(
      workspaceB,
      `update public.offer_pdf_draft
          set next_attempt_at = next_attempt_at
        where id = $1::uuid`,
      [draftA.draftId],
    );
    expect(foreignWrite.rowCount).toBe(0);
  });

  it("erzwingt den Lease-/Retry-Automaten und versiegelt Erfolg terminal", async () => {
    await expect(queryAs(
      workspaceA,
      `update public.offer_pdf_draft
          set state = 'failed_final',
              error_code = 'illegal_shortcut',
              error_retryable = false,
              started_at = pg_catalog.statement_timestamp(),
              finished_at = pg_catalog.statement_timestamp(),
              updated_at = pg_catalog.statement_timestamp()
        where id = $1::uuid`,
      [draftA.draftId],
    )).rejects.toThrow(/ungueltiger Abschluss-Uebergang/);
    await expect(queryAs(
      workspaceA,
      `update public.offer_pdf_draft
          set input_snapshot = input_snapshot || '{"tampered":true}'::jsonb,
              input_sha256 = pg_catalog.sha256(pg_catalog.convert_to(
                public.canonicalize_offer_json_v1(
                  input_snapshot || '{"tampered":true}'::jsonb
                ),
                'UTF8'
              ))
        where id = $1::uuid`,
      [draftA.draftId],
    )).rejects.toThrow(/versiegelte Quelle ist immutable/);

    await claimDraft(draftA, 1);
    await expect(claimDraft(draftA, 2)).rejects.toThrow(/aktive Lease/);

    await queryAs(
      workspaceA,
      `update public.offer_pdf_draft
          set state = 'retry_wait',
              lease_token = null,
              lease_expires_at = null,
              error_code = 'renderer_timeout',
              error_retryable = true,
              next_attempt_at = pg_catalog.statement_timestamp() + interval '1 second',
              updated_at = pg_catalog.statement_timestamp()
        where id = $1::uuid`,
      [draftA.draftId],
    );
    await queryAs(
      workspaceA,
      `update public.offer_pdf_draft
          set state = 'queued',
              error_code = null,
              error_retryable = null,
              next_attempt_at = pg_catalog.statement_timestamp(),
              updated_at = pg_catalog.statement_timestamp()
        where id = $1::uuid`,
      [draftA.draftId],
    );
    await claimDraft(draftA, 2);

    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(116, 65),
      Buffer.from("\n%%EOF"),
    ]);
    await queryAs(
      workspaceA,
      `update public.offer_pdf_draft
          set state = 'succeeded',
              lease_token = null,
              lease_expires_at = null,
              artifact_mime_type = 'application/pdf',
              artifact_sha256 = $2::bytea,
              artifact_size_bytes = $3,
              artifact_bytes = $4::bytea,
              finished_at = pg_catalog.statement_timestamp(),
              updated_at = pg_catalog.statement_timestamp()
        where id = $1::uuid`,
      [draftA.draftId, sha256(pdf), pdf.length, pdf],
    );

    const state = await queryAs<{
      state: string;
      attempt_count: number;
      digest: string;
    }>(
      workspaceA,
      `select state, attempt_count,
              pg_catalog.encode(artifact_sha256, 'hex') as digest
         from public.offer_pdf_draft where id = $1::uuid`,
      [draftA.draftId],
    );
    expect(state.rows).toEqual([{
      state: "succeeded",
      attempt_count: 2,
      digest: sha256(pdf).toString("hex"),
    }]);

    const replacementPdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(117, 67),
      Buffer.from("\n%%EOF"),
    ]);
    await expect(queryAs(
      workspaceA,
      `update public.offer_pdf_draft
          set artifact_sha256 = $2::bytea,
              artifact_size_bytes = $3,
              artifact_bytes = $4::bytea,
              updated_at = pg_catalog.statement_timestamp()
        where id = $1::uuid`,
      [
        draftA.draftId,
        sha256(replacementPdf),
        replacementPdf.length,
        replacementPdf,
      ],
    )).rejects.toThrow(/terminaler Zustand ist immutable/);
  });

  it("verwirft einen Artefakthash, der nicht zu den gespeicherten Bytes gehoert", async () => {
    await claimDraft(draftB, 1);
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(116, 66),
      Buffer.from("\n%%EOF"),
    ]);
    await expect(queryAs(
      workspaceB,
      `update public.offer_pdf_draft
          set state = 'succeeded',
              lease_token = null,
              lease_expires_at = null,
              artifact_mime_type = 'application/pdf',
              artifact_sha256 = decode(repeat('00', 32), 'hex'),
              artifact_size_bytes = $2,
              artifact_bytes = $3::bytea,
              finished_at = pg_catalog.statement_timestamp(),
              updated_at = pg_catalog.statement_timestamp()
        where id = $1::uuid`,
      [draftB.draftId, pdf.length, pdf],
    )).rejects.toThrow(/offer_pdf_draft_artifact_ck/);

    const unchanged = await queryAs<{ state: string; has_artifact: boolean }>(
      workspaceB,
      `select state, artifact_bytes is not null as has_artifact
         from public.offer_pdf_draft where id = $1::uuid`,
      [draftB.draftId],
    );
    expect(unchanged.rows).toEqual([{ state: "running", has_artifact: false }]);
  });

  it("sperrt direkte DELETEs und TRUNCATE auch fuer den Tabellenowner", async () => {
    await expect(queryAs(
      workspaceA,
      "delete from public.offer_pdf_draft where id = $1::uuid",
      [draftA.draftId],
    )).rejects.toThrow(/DELETE ist nur im Erasurevertrag erlaubt/);

    await expect(queryAs(
      workspaceA,
      "truncate table public.offer_pdf_draft",
    )).rejects.toThrow(/offer_pdf_draft is append-only/);
  });

  it("bewahrt den alten Tombstone-Shape und materialisiert PDF-IDs nur bei Bedarf", async () => {
    const contactWithoutPdf = randomUUID();
    await queryAs(
      workspaceB,
      `insert into public.contact (
         id, workspace_id, display_name, email_primary, email_normalized
       ) values ($1::uuid, $2::uuid, 'Legacy Tombstone Shape', $3, $3)`,
      [contactWithoutPdf, workspaceB, `${contactWithoutPdf}@test.local`],
    );
    const graphResult = await queryAs<{ graph: ErasureGraph }>(
      workspaceB,
      `select public.build_inactive_lead_erasure_graph($1::uuid, $2::uuid) as graph`,
      [workspaceB, contactWithoutPdf],
    );
    const graph = graphResult.rows[0]?.graph;
    expect(graph).toBeDefined();
    expect(graph).not.toHaveProperty("offerPdfDraftIds");
    await expect(insertTombstone(
      workspaceB,
      contactWithoutPdf,
      randomUUID(),
      graph!,
    )).resolves.toBeUndefined();
  });

  it("blockiert den echten Erase vor Eligibility bei aktiver PDF-Worker-Lease", async () => {
    const graphResult = await queryAs<{ graph: ErasureGraph }>(
      workspaceB,
      `select public.build_inactive_lead_erasure_graph($1::uuid, $2::uuid) as graph`,
      [workspaceB, bindingB.contactId],
    );
    expect(graphResult.rows[0]?.graph.offerPdfDraftIds).toEqual([draftB.draftId]);

    const operationId = randomUUID();
    await expect(testPool.query(
      `select public.erase_inactive_lead($1::uuid, $2::uuid, $3::uuid)`,
      [workspaceB, bindingB.contactId, operationId],
    )).rejects.toMatchObject({
      code: "55006",
      message: expect.stringMatching(/erasure_worker_active/),
    });

    const retained = await queryAs<{ state: string; has_input: boolean }>(
      workspaceB,
      `select state, input_snapshot is not null as has_input
         from public.offer_pdf_draft where id = $1::uuid`,
      [draftB.draftId],
    );
    expect(retained.rows).toEqual([{ state: "running", has_input: true }]);
    const tombstones = await testPool.query<{ count: number }>(
      `select pg_catalog.count(*)::int as count
         from public.erasure_tombstone where operation_id = $1::uuid`,
      [operationId],
    );
    expect(tombstones.rows).toEqual([{ count: 0 }]);

    const erasureSource = await testPool.query<{ source: string }>(`
      select routine.prosrc as source
        from pg_catalog.pg_proc as routine
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = routine.pronamespace
       where namespace.nspname = 'public'
         and routine.proname = 'erase_inactive_lead'
         and pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid, uuid'
    `);
    expect(erasureSource.rows[0]?.source).toMatch(
      /offer_pdf_draft[\s\S]*ORDER BY draft\.id FOR UPDATE;[\s\S]*lease_expires_at > pg_catalog\.statement_timestamp\(\)/,
    );
    // Der autorisierte PDF-Request schreibt offer.updated_at. Technische
    // Worker-Zeiten duerfen die 24-Monats-Retention dagegen nicht verlaengern.
    expect(erasureSource.rows[0]?.source).not.toMatch(
      /GREATEST\(draft\.(?:created_at|started_at|finished_at)/,
    );
  });

  it("nimmt die Draft-ID in den Tombstone-Graph auf und loescht Bytes nur per echtem Replay", async () => {
    const graphResult = await queryAs<{ graph: ErasureGraph }>(
      workspaceA,
      `select public.build_inactive_lead_erasure_graph($1::uuid, $2::uuid) as graph`,
      [workspaceA, bindingA.contactId],
    );
    const graph = graphResult.rows[0]?.graph;
    expect(graph?.offerPdfDraftIds).toEqual([draftA.draftId]);

    const operationId = randomUUID();
    await insertTombstone(workspaceA, bindingA.contactId, operationId, graph!);
    await expect(testPool.query<{ operation_id: string }>(
      `select public.replay_erasure_tombstone($1::uuid) as operation_id`,
      [operationId],
    )).resolves.toMatchObject({ rows: [{ operation_id: operationId }] });
    await expect(testPool.query<{ operation_id: string }>(
      `select public.replay_erasure_tombstone($1::uuid) as operation_id`,
      [operationId],
    )).resolves.toMatchObject({ rows: [{ operation_id: operationId }] });

    const remaining = await queryAs<{ count: number }>(
      workspaceA,
      `select pg_catalog.count(*)::int as count
         from public.offer_pdf_draft where id = $1::uuid`,
      [draftA.draftId],
    );
    expect(remaining.rows).toEqual([{ count: 0 }]);
    const retainedGraph = await queryAs<{ graph: ErasureGraph }>(
      workspaceA,
      `select graph_ids as graph
         from public.erasure_tombstone where operation_id = $1::uuid`,
      [operationId],
    );
    expect(retainedGraph.rows[0]?.graph.offerPdfDraftIds).toEqual([draftA.draftId]);
  });
});
