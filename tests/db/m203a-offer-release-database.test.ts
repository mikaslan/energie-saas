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

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgBoss } from "pg-boss";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { withTenantOn } from "@/lib/db/tenant";
import { canonicalizeOfferJson } from "@/lib/integrations/offers/contract";
import {
  LEGACY_CALCULATION_QUEUE_OPTIONS,
  OFFER_PDF_QUEUE_OPTIONS,
  OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS,
} from "../../scripts/pgboss-bootstrap.mjs";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";
import { tenantFixtures } from "../setup/tenant-fixtures";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

type OfferBinding = QueryResultRow & {
  actor_id: string;
  offer_id: string;
};

type RevisedProfile = {
  status: "revised";
  workspaceId: string;
  profileId: string;
  profileRevisionId: string;
  revision: number;
  snapshot: Record<string, unknown>;
  snapshotSha256: string;
  createdBy: string;
  createdAt: string;
};

type ActivatedProfile = {
  status: "activated";
  workspaceId: string;
  activationId: string;
  profileId: string;
  profileRevisionId: string;
  profileRevision: number;
  profileSnapshotSha256: string;
  reviewState: "operator_reviewed";
  reviewedBy: string;
  reviewedAt: string;
  snapshot: Record<string, unknown>;
};

type RevisedRecipient = {
  status: "revised";
  workspaceId: string;
  offerId: string;
  recipientId: string;
  recipientRevisionId: string;
  revision: number;
  snapshot: Record<string, unknown>;
  snapshotSha256: string;
  createdBy: string;
  createdAt: string;
};

type CandidateSource = {
  id: string;
  project_id: string;
  offer_id: string;
  variant_id: string;
  variant_revision_id: string;
  variant_revision: number;
};

type PreparedCandidate = {
  status: "prepared";
  workspaceId: string;
  candidateId: string;
  offerId: string;
  variantId: string;
  variantRevision: number;
  profileRevision: number;
  recipientRevision: number;
  reservationKeySha256: string;
  inputSnapshot: Record<string, unknown> & {
    documentDate: string;
    validThrough: string;
    sections: Array<{ lines: Array<Record<string, unknown>> }>;
  };
  inputSha256: string;
  state: string;
  attemptCount: number;
  replayed: boolean;
};

type ApprovedCandidate = {
  status: "approved";
  candidateId: string;
  approvalId: string;
  candidateState: "ready_for_approval";
  artifactMimeType: "application/pdf";
  artifactSha256: string;
  artifactSizeBytes: number;
  artifactVersion: string;
  approvalCommand: Record<string, unknown>;
  derivedState: "approved_not_issued";
  replayed: boolean;
};

type MutableVariantSnapshot = {
  revision: number;
  snapshotSha256: string;
  taxDecision: { treatment: string; rateBps: number };
  totals: {
    basisNetCents: number;
    basisTaxCents: number;
    basisGrossCents: number;
  };
  sections: Array<{
    lines: Array<{
      isHidden?: boolean | string;
      taxTreatment: string;
      taxRateBps: number;
      taxDecision: { treatment: string; rateBps: number };
      computed: { salesTaxCents: number; salesGrossCents: number };
    }>;
  }>;
};

const RELEASE_TABLES = [
  "offer_recipient",
  "offer_recipient_revision",
  "offer_release_candidate",
  "offer_release_candidate_approval",
  "offer_release_profile",
  "offer_release_profile_activation",
  "offer_release_profile_revision",
] as const;

const RELEASE_MUTATION_SIGNATURES = [
  "activate_offer_release_profile(uuid, uuid, uuid, integer)",
  "approve_offer_release_candidate(uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, boolean)",
  "prepare_offer_release_candidate(uuid, uuid, uuid, integer, uuid, uuid, uuid, integer, uuid, integer, date)",
  "revise_offer_recipient(uuid, uuid, integer, text, text, text, jsonb, boolean)",
  "revise_offer_release_profile(uuid, integer, text, jsonb, jsonb)",
] as const;

const RELEASE_READ_SIGNATURES = [
  "read_offer_release_candidate_artifact(uuid, uuid, uuid)",
  "read_offer_release_candidate_status(uuid, uuid, uuid)",
] as const;

const PROFILE_SENDER = {
  legalName: "Testenergie GmbH",
  tradingName: "Testenergie",
  representedBy: "Mara Muster",
  address: {
    street: "Sonnenallee",
    houseNumber: "17",
    postalCode: "10115",
    city: "Berlin",
    country: "DE",
  },
  email: "OFFICE@RELEASE.INVALID",
  phoneE164: "+49301234567",
  websiteHttpsUrl: "https://release.invalid",
  registerCourt: "Amtsgericht Berlin",
  registerNumber: "HRB 12345",
  vatId: "DE123456789",
};

const LEGAL_DOCUMENTS = {
  terms: { title: "Angebotsbedingungen", plainText: "PRIVATE_TERMS_SENTINEL" },
  withdrawalInformation: {
    title: "Widerrufsinformation",
    plainText: "PRIVATE_WITHDRAWAL_SENTINEL",
  },
  privacyNotice: {
    title: "Datenschutzhinweis",
    plainText: "PRIVATE_PRIVACY_SENTINEL",
  },
};

const BILLING_ADDRESS = {
  street: "Rechnungsweg",
  houseNumber: "8a",
  postalCode: "10999",
  city: "Berlin",
  country: "DE",
};

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-m2-03a-upgrade-"));
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
    create role app_migrator login password 'm203a_migrator'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_runtime login password 'm203a_runtime'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_system login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_auth login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_worker login password 'm203a_worker'
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
    connectionString: serviceUrl(embedded, "app_worker", "m203a_worker"),
    schema: "pgboss",
    createSchema: false,
  });
  const errors: unknown[] = [];
  boss.on("error", (error) => errors.push(error));
  try {
    await boss.start();
    await boss.createQueue("calculation.execute", LEGACY_CALCULATION_QUEUE_OPTIONS);
    await boss.createQueue("pdf.render", OFFER_PDF_QUEUE_OPTIONS);
    await boss.createQueue(
      "offer.release-candidate.render",
      OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS,
    );
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
  expect(errors, `pg-boss-Bootstrap: ${errors.map(String).join(", ")}`).toEqual([]);
}

async function tenantQuery<Row extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  workspaceId: string,
  actorId: string | null,
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
    await client.query(
      "select pg_catalog.set_config('app.actor_id', $1, true)",
      [actorId ?? ""],
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

async function prepareOffer(pool: Pool, workspaceId: string): Promise<OfferBinding> {
  await withTenantOn(pool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into public.workspace (id, name)
      values (${workspaceId}::uuid, 'M2-03a DB-Vertrag')
    `);
    const factory = tenantFixtures.offer;
    if (!factory) throw new Error("Offer-Tenant-Fixture fehlt.");
    await factory(tx, workspaceId);
  });
  const binding = await tenantQuery<OfferBinding>(
    pool,
    workspaceId,
    null,
    `select offer_record.id as offer_id,
            offer_record.created_by as actor_id
       from public.offer as offer_record
      where offer_record.workspace_id = $1::uuid
      order by offer_record.id
      limit 1`,
    [workspaceId],
  );
  const row = binding.rows[0];
  if (!row) throw new Error("M2-03a Offer-Bindung fehlt.");
  await tenantQuery(
    pool,
    workspaceId,
    null,
    `update public.membership
        set role = 'admin'
      where workspace_id = $1::uuid and user_id = $2::uuid`,
    [workspaceId, row.actor_id],
  );
  return row;
}

async function expectDenied(work: Promise<unknown>): Promise<void> {
  await expect(work).rejects.toMatchObject({ code: "42501" });
}

async function createSyntheticSourceRevision(
  owner: Pool,
  superuser: Pool,
  workspaceId: string,
  offerId: string,
  actorId: string,
  mode: "hidden" | "hidden_string" | "hidden_missing" | "visible" | "zero_tax",
): Promise<CandidateSource> {
  const currentRows = await tenantQuery<{
    id: string;
    variant_id: string;
    revision: number;
    revision_snapshot: MutableVariantSnapshot;
  }>(
    owner,
    workspaceId,
    actorId,
    `select revision.id, revision.variant_id, revision.revision,
            revision.revision_snapshot
       from public.offer_variant_revision as revision
       join public.offer_variant as variant
         on variant.workspace_id = revision.workspace_id
        and variant.id = revision.variant_id
        and variant.current_revision = revision.revision
      where revision.workspace_id = $1::uuid
        and revision.offer_id = $2::uuid`,
    [workspaceId, offerId],
  );
  const current = currentRows.rows[0];
  if (!current) throw new Error("Aktuelle synthetische Revision fehlt.");
  const nextRevision = current.revision + 1;
  const nextRevisionId = randomUUID();
  const snapshot = structuredClone(current.revision_snapshot);
  snapshot.revision = nextRevision;
  const line = snapshot.sections[0]?.lines[0];
  if (!line) throw new Error("Synthetische Testzeile fehlt.");
  if (mode === "hidden") line.isHidden = true;
  else if (mode === "hidden_string") line.isHidden = "true";
  else if (mode === "hidden_missing") delete line.isHidden;
  else line.isHidden = false;
  if (mode === "zero_tax") {
    snapshot.taxDecision.treatment = "zero_operator_confirmed";
    snapshot.taxDecision.rateBps = 0;
    snapshot.totals.basisTaxCents = 0;
    snapshot.totals.basisGrossCents = snapshot.totals.basisNetCents;
    line.taxTreatment = "zero_operator_confirmed";
    line.taxRateBps = 0;
    line.taxDecision.treatment = "zero_operator_confirmed";
    line.taxDecision.rateBps = 0;
    line.computed.salesTaxCents = 0;
    line.computed.salesGrossCents = 100;
  }
  const { snapshotSha256: ignoredSnapshotHash, ...snapshotPayload } = snapshot;
  void ignoredSnapshotHash;
  const snapshotHash = createHash("sha256")
    .update(canonicalizeOfferJson(snapshotPayload), "utf8")
    .digest("hex");
  snapshot.snapshotSha256 = snapshotHash;
  const superuserClient = await superuser.connect();
  try {
    await superuserClient.query("begin");
    await superuserClient.query(
      "select pg_catalog.set_config('app.workspace_id', $1, true)",
      [workspaceId],
    );
    await superuserClient.query("set local session_replication_role = replica");
    await superuserClient.query(
      `insert into public.offer_variant_revision (
       id, workspace_id, offer_id, variant_id, project_id, revision,
       schema_version, canonicalization_version, revision_snapshot,
       snapshot_sha256, resolution_id, resolution_revision, resolution_sha256,
       basis_net_cents, basis_tax_cents, basis_gross_cents,
       optional_net_cents, optional_tax_cents, optional_gross_cents,
       created_by, created_at
     )
     select $3::uuid, workspace_id, offer_id, variant_id, project_id,
            $4::integer, schema_version, canonicalization_version, $5::jsonb,
            decode($6::text, 'hex'), resolution_id, resolution_revision,
            resolution_sha256, basis_net_cents,
            case when $7::boolean then 0 else basis_tax_cents end,
            case when $7::boolean then basis_net_cents else basis_gross_cents end,
            optional_net_cents, optional_tax_cents, optional_gross_cents,
            created_by, pg_catalog.clock_timestamp()
       from public.offer_variant_revision
      where workspace_id = $1::uuid and id = $2::uuid`,
      [
        workspaceId,
        current.id,
        nextRevisionId,
        nextRevision,
        JSON.stringify(snapshot),
        snapshotHash,
        mode === "zero_tax",
      ],
    );
    await superuserClient.query(
      `update public.offer_variant
        set current_revision = $3::integer,
            updated_at = pg_catalog.clock_timestamp()
       where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, current.variant_id, nextRevision],
    );
    await superuserClient.query("commit");
  } catch (error) {
    await superuserClient.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    superuserClient.release();
  }

  const sourceId = randomUUID();
  await tenantQuery(
    owner,
    workspaceId,
    actorId,
    `insert into public.offer_pdf_draft (
       id, workspace_id, project_id, offer_id, variant_id,
       variant_revision_id, variant_revision, variant_snapshot_sha256,
       input_version, canonicalization_version, template_version,
       renderer_recipe_version, reservation_key, input_snapshot, input_sha256,
       state, attempt_count, next_attempt_at, created_by
     )
     select $3::uuid, revision.workspace_id, revision.project_id,
            revision.offer_id, revision.variant_id, revision.id,
            revision.revision, revision.snapshot_sha256,
            'offer-pdf-draft-input.v1', 'offer-jcs.v1',
            'offer-pdf-draft-template.v1',
            'offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac',
            decode(repeat('00', 32), 'hex'), '{}'::jsonb,
            decode(repeat('00', 32), 'hex'), 'queued', 0,
            pg_catalog.clock_timestamp(), $4::uuid
       from public.offer_variant_revision as revision
      where revision.workspace_id = $1::uuid and revision.id = $2::uuid`,
    [workspaceId, nextRevisionId, sourceId, actorId],
  );
  if (mode === "hidden_missing") {
    const missingClient = await superuser.connect();
    try {
      await missingClient.query("begin");
      await missingClient.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true)",
        [workspaceId],
      );
      await missingClient.query("set local session_replication_role = replica");
      await missingClient.query(
        `update public.offer_pdf_draft
            set input_snapshot = input_snapshot
                  #- '{sections,0,lines,0,isHidden}',
                input_sha256 = pg_catalog.sha256(pg_catalog.convert_to(
                  public.canonicalize_offer_json_v1(
                    input_snapshot #- '{sections,0,lines,0,isHidden}'
                  ),
                  'UTF8'
                ))
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, sourceId],
      );
      await missingClient.query("commit");
    } catch (error) {
      await missingClient.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      missingClient.release();
    }
  }
  const artifact = Buffer.from(
    `%PDF-1.7\n${`synthetic-${mode}-source`.repeat(10)}\n%%EOF`,
    "utf8",
  );
  await tenantQuery(
    owner,
    workspaceId,
    actorId,
    `update public.offer_pdf_draft
        set state = 'running', attempt_count = 1,
            lease_token = pg_catalog.gen_random_uuid(),
            lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes',
            started_at = pg_catalog.clock_timestamp(),
            updated_at = pg_catalog.clock_timestamp()
      where workspace_id = $1::uuid and id = $2::uuid`,
    [workspaceId, sourceId],
  );
  await tenantQuery(
    owner,
    workspaceId,
    actorId,
    `update public.offer_pdf_draft
        set state = 'succeeded', lease_token = null, lease_expires_at = null,
            artifact_mime_type = 'application/pdf', artifact_bytes = $3::bytea,
            artifact_sha256 = pg_catalog.sha256($3::bytea),
            artifact_size_bytes = pg_catalog.octet_length($3::bytea),
            finished_at = pg_catalog.clock_timestamp(),
            updated_at = pg_catalog.clock_timestamp()
      where workspace_id = $1::uuid and id = $2::uuid`,
    [workspaceId, sourceId, artifact],
  );
  return {
    id: sourceId,
    project_id: "",
    offer_id: offerId,
    variant_id: current.variant_id,
    variant_revision_id: nextRevisionId,
    variant_revision: nextRevision,
  };
}

async function callErasureAsDedicatedRole(
  superuser: Pool,
  workspaceId: string,
  contactId: string,
  operationId: string,
): Promise<string> {
  const client = await superuser.connect();
  try {
    await client.query("begin");
    await client.query("set local role app_erasure");
    const result = await client.query<{ operation_id: string }>(
      `select public.erase_inactive_lead(
         $1::uuid, $2::uuid, $3::uuid
       ) as operation_id`,
      [workspaceId, contactId, operationId],
    );
    await client.query("commit");
    const returnedOperationId = result.rows[0]?.operation_id;
    if (!returnedOperationId) throw new Error("Erasure-Ergebnis fehlt.");
    return returnedOperationId;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe.sequential("M2-03a Offer-Release-Datenbankvertrag", () => {
  it("migriert eine reale 0..33-Datenbank additiv auf 0034", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = new Pool({ connectionString: embedded.url, max: 2 });
    let prefix: string | undefined;
    try {
      prefix = migrationPrefixThrough(33);
      await migrate(drizzle(pool), { migrationsFolder: prefix });
      const workspaceId = randomUUID();
      await tenantQuery(
        pool,
        workspaceId,
        null,
        "insert into public.workspace (id, name) values ($1::uuid, 'Upgrade bleibt')",
        [workspaceId],
      );

      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

      const retained = await tenantQuery<{ name: string }>(
        pool,
        workspaceId,
        null,
        "select name from public.workspace where id = $1::uuid",
        [workspaceId],
      );
      expect(retained.rows).toEqual([{ name: "Upgrade bleibt" }]);
      const relations = await pool.query<{ relname: string }>(`
        select relation.relname
          from pg_catalog.pg_class as relation
          join pg_catalog.pg_namespace as namespace
            on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relname = any($1::text[])
         order by relation.relname
      `, [RELEASE_TABLES]);
      expect(relations.rows.map((row) => row.relname)).toEqual([...RELEASE_TABLES]);
    } finally {
      if (prefix) rmSync(prefix, { recursive: true, force: true });
      await pool.end().catch(() => undefined);
      await embedded.stop().catch(() => undefined);
    }
  }, 120_000);

  it("erzwingt im frischen Strict-Setup Owner, RLS, ACLs und schmale Funktionen", async () => {
    const embedded = await startEmbeddedPostgres();
    const admin = new Pool({ connectionString: embedded.superuserUrl, max: 1 });
    let migrator: Pool | undefined;
    let runtime: Pool | undefined;
    let worker: Pool | undefined;
    try {
      await bootstrapStrictRolesAndPgBoss(embedded, admin);
      migrator = new Pool({
        connectionString: serviceUrl(embedded, "app_migrator", "m203a_migrator"),
        options: "-c role=app_owner",
        max: 2,
      });
      await migrate(drizzle(migrator), { migrationsFolder: resolve("drizzle") });
      runtime = new Pool({
        connectionString: serviceUrl(embedded, "app_runtime", "m203a_runtime"),
        max: 4,
      });
      worker = new Pool({
        connectionString: serviceUrl(embedded, "app_worker", "m203a_worker"),
        max: 1,
      });

      const relationContract = await migrator.query<{
        relname: string;
        owner: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        permissive_policies: number;
        canonical_policy: boolean;
      }>(`
        select relation.relname,
               owner.rolname as owner,
               relation.relrowsecurity,
               relation.relforcerowsecurity,
               count(policy.policyname)::int as permissive_policies,
               bool_and(
                 policy.policyname = 'tenant_isolation'
                 and policy.permissive = 'PERMISSIVE'
                 and policy.roles = '{public}'::name[]
                 and policy.cmd = 'ALL'
                 and policy.qual = policy.with_check
               ) as canonical_policy
          from pg_catalog.pg_class as relation
          join pg_catalog.pg_namespace as namespace
            on namespace.oid = relation.relnamespace
          join pg_catalog.pg_roles as owner on owner.oid = relation.relowner
          left join pg_catalog.pg_policies as policy
            on policy.schemaname = namespace.nspname
           and policy.tablename = relation.relname
           and policy.permissive = 'PERMISSIVE'
         where namespace.nspname = 'public'
           and relation.relname = any($1::text[])
         group by relation.relname, owner.rolname,
                  relation.relrowsecurity, relation.relforcerowsecurity
         order by relation.relname
      `, [RELEASE_TABLES]);
      expect(relationContract.rows).toHaveLength(RELEASE_TABLES.length);
      for (const row of relationContract.rows) {
        expect(row).toMatchObject({
          owner: "app_owner",
          relrowsecurity: true,
          relforcerowsecurity: true,
          permissive_policies: 1,
          canonical_policy: true,
        });
      }

      const functionContract = await migrator.query<{
        signature: string;
        owner: string;
        security_definer: boolean;
        config: string[] | null;
        runtime_execute: boolean;
        worker_execute: boolean;
        system_execute: boolean;
        auth_execute: boolean;
        erasure_execute: boolean;
        public_execute: boolean;
      }>(`
        select routine.proname || '(' ||
                 pg_catalog.oidvectortypes(routine.proargtypes) || ')' as signature,
               owner.rolname as owner,
               routine.prosecdef as security_definer,
               routine.proconfig as config,
               pg_catalog.has_function_privilege('app_runtime', routine.oid, 'EXECUTE')
                 as runtime_execute,
               pg_catalog.has_function_privilege('app_worker', routine.oid, 'EXECUTE')
                 as worker_execute,
               pg_catalog.has_function_privilege('app_system', routine.oid, 'EXECUTE')
                 as system_execute,
               pg_catalog.has_function_privilege('app_auth', routine.oid, 'EXECUTE')
                 as auth_execute,
               pg_catalog.has_function_privilege('app_erasure', routine.oid, 'EXECUTE')
                 as erasure_execute,
               pg_catalog.has_function_privilege('public', routine.oid, 'EXECUTE')
                 as public_execute
          from pg_catalog.pg_proc as routine
          join pg_catalog.pg_namespace as namespace
            on namespace.oid = routine.pronamespace
          join pg_catalog.pg_roles as owner on owner.oid = routine.proowner
         where namespace.nspname = 'public'
           and routine.proname in (
             'activate_offer_release_profile',
             'approve_offer_release_candidate',
             'prepare_offer_release_candidate',
             'read_offer_release_candidate_artifact',
             'read_offer_release_candidate_status',
             'revise_offer_recipient',
             'revise_offer_release_profile'
           )
         order by signature
      `);
      expect(functionContract.rows.map((row) => row.signature)).toEqual(
        [...RELEASE_MUTATION_SIGNATURES, ...RELEASE_READ_SIGNATURES].sort(),
      );
      for (const row of functionContract.rows) {
        expect(row).toMatchObject({
          owner: "app_owner",
          security_definer: true,
          config: ["search_path=pg_catalog"],
          runtime_execute: true,
          worker_execute: false,
          system_execute: false,
          auth_execute: false,
          erasure_execute: false,
          public_execute: false,
        });
      }

      const dispatchContract = await migrator.query<{
        owner: string;
        security_definer: boolean;
        config: string[] | null;
        runtime_execute: boolean;
        worker_execute: boolean;
        public_execute: boolean;
      }>(`
        select owner.rolname as owner,
               routine.prosecdef as security_definer,
               routine.proconfig as config,
               pg_catalog.has_function_privilege(
                 'app_runtime', routine.oid, 'EXECUTE'
               ) as runtime_execute,
               pg_catalog.has_function_privilege(
                 'app_worker', routine.oid, 'EXECUTE'
               ) as worker_execute,
               pg_catalog.has_function_privilege(
                 'public', routine.oid, 'EXECUTE'
               ) as public_execute
          from pg_catalog.pg_proc as routine
          join pg_catalog.pg_namespace as namespace
            on namespace.oid = routine.pronamespace
          join pg_catalog.pg_roles as owner on owner.oid = routine.proowner
         where namespace.nspname = 'pgboss'
           and routine.proname = 'enqueue_offer_release_candidate'
           and pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid'
      `);
      expect(dispatchContract.rows).toEqual([{
        owner: "app_worker",
        security_definer: true,
        config: ["search_path=pg_catalog"],
        runtime_execute: true,
        worker_execute: true,
        public_execute: false,
      }]);

      const tablePrivileges = await migrator.query<{
        relname: string;
        runtime_select: boolean;
        runtime_insert: boolean;
        runtime_update: boolean;
        runtime_delete: boolean;
        runtime_truncate: boolean;
        worker_select: boolean;
      }>(`
        select relation.relname,
               pg_catalog.has_table_privilege(
                 'app_runtime', relation.oid, 'SELECT'
               ) as runtime_select,
               pg_catalog.has_table_privilege(
                 'app_runtime', relation.oid, 'INSERT'
               ) as runtime_insert,
               pg_catalog.has_table_privilege(
                 'app_runtime', relation.oid, 'UPDATE'
               ) as runtime_update,
               pg_catalog.has_table_privilege(
                 'app_runtime', relation.oid, 'DELETE'
               ) as runtime_delete,
               pg_catalog.has_table_privilege(
                 'app_runtime', relation.oid, 'TRUNCATE'
               ) as runtime_truncate,
               pg_catalog.has_table_privilege(
                 'app_worker', relation.oid, 'SELECT'
               ) as worker_select
          from pg_catalog.pg_class as relation
          join pg_catalog.pg_namespace as namespace
            on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relname = any($1::text[])
         order by relation.relname
      `, [RELEASE_TABLES]);
      expect(tablePrivileges.rows).toHaveLength(RELEASE_TABLES.length);
      for (const row of tablePrivileges.rows) {
        expect(row.runtime_select).toBe(![
          "offer_release_candidate",
          "offer_release_candidate_approval",
        ].includes(row.relname));
        expect(row.runtime_insert).toBe(false);
        expect(row.runtime_update).toBe(false);
        expect(row.runtime_delete).toBe(false);
        expect(row.runtime_truncate).toBe(false);
        expect(row.worker_select).toBe(row.relname === "offer_release_candidate");
      }

      const workerColumns = await migrator.query<{
        column_name: string;
        may_update: boolean;
      }>(`
        select column_name,
               pg_catalog.has_column_privilege(
                 'app_worker', 'public.offer_release_candidate',
                 column_name, 'UPDATE'
               ) as may_update
          from information_schema.columns
         where table_schema = 'public'
           and table_name = 'offer_release_candidate'
         order by column_name
      `);
      const expectedWorkerUpdates = [
        "artifact_bytes",
        "artifact_mime_type",
        "artifact_sha256",
        "artifact_size_bytes",
        "artifact_version",
        "attempt_count",
        "error_code",
        "error_retryable",
        "finished_at",
        "lease_expires_at",
        "lease_token",
        "next_attempt_at",
        "started_at",
        "state",
        "updated_at",
      ];
      expect(
        workerColumns.rows.filter((row) => row.may_update).map((row) => row.column_name),
      ).toEqual(expectedWorkerUpdates);

      const foreignKey = await migrator.query<{
        name: string;
        definition: string;
        deferrable: boolean;
        deferred: boolean;
      }>(`
        select constraint_row.conname as name,
               pg_catalog.pg_get_constraintdef(constraint_row.oid, false) as definition,
               constraint_row.condeferrable as deferrable,
               constraint_row.condeferred as deferred
          from pg_catalog.pg_constraint as constraint_row
         where constraint_row.conrelid = 'public.offer_release_profile'::regclass
           and constraint_row.contype = 'f'
           and constraint_row.conname = 'offer_release_profile_active_activation_fk'
      `);
      expect(foreignKey.rows).toHaveLength(1);
      expect(foreignKey.rows[0]).toMatchObject({ deferrable: true, deferred: true });
      expect(foreignKey.rows[0]?.definition).toContain(
        "FOREIGN KEY (workspace_id, active_activation_id, id)",
      );

      const guards = await migrator.query<{ relname: string; trigger_count: number }>(`
        select relation.relname,
               count(trigger_row.oid) filter (
                 where not trigger_row.tgisinternal
               )::int as trigger_count
          from pg_catalog.pg_class as relation
          join pg_catalog.pg_namespace as namespace
            on namespace.oid = relation.relnamespace
          left join pg_catalog.pg_trigger as trigger_row
            on trigger_row.tgrelid = relation.oid
         where namespace.nspname = 'public'
           and relation.relname = any($1::text[])
         group by relation.relname
         order by relation.relname
      `, [RELEASE_TABLES]);
      expect(guards.rows).toHaveLength(RELEASE_TABLES.length);
      expect(guards.rows.every((row) => row.trigger_count >= 2)).toBe(true);

      const workspaceId = randomUUID();
      const binding = await prepareOffer(migrator, workspaceId);

      for (const capabilities of [
        {},
        { external_only: true, prepare_offer_documents: true },
        { prepare_offer_documents: true, malformed: "true" },
      ]) {
        await tenantQuery(
          migrator,
          workspaceId,
          null,
          `update public.membership
              set role = 'editor', capabilities = $3::jsonb
            where workspace_id = $1::uuid and user_id = $2::uuid`,
          [workspaceId, binding.actor_id, JSON.stringify(capabilities)],
        );
        await expectDenied(tenantQuery(
          runtime,
          workspaceId,
          binding.actor_id,
          `select public.prepare_offer_release_candidate(
             $1::uuid, null::uuid, null::uuid, 1, null::uuid,
             null::uuid, null::uuid, 1, null::uuid, 1,
             (pg_catalog.clock_timestamp() at time zone 'Europe/Berlin')::date + 1
           )`,
          [workspaceId],
        ));
      }
      await tenantQuery(
        migrator,
        workspaceId,
        null,
        `update public.membership
            set role = 'admin', capabilities = '{}'::jsonb
          where workspace_id = $1::uuid and user_id = $2::uuid`,
        [workspaceId, binding.actor_id],
      );

      const revisedProfileRows = await tenantQuery<{ result: RevisedProfile }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.revise_offer_release_profile(
           $1::uuid, 0, '  WMEE Kundenangebot  ', $2::jsonb, $3::jsonb
         ) as result`,
        [workspaceId, JSON.stringify(PROFILE_SENDER), JSON.stringify(LEGAL_DOCUMENTS)],
      );
      const revisedProfile = revisedProfileRows.rows[0]?.result;
      expect(revisedProfile).toMatchObject({
        status: "revised",
        workspaceId,
        revision: 1,
        createdBy: binding.actor_id,
      });
      expect(revisedProfile?.snapshot).toMatchObject({
        schemaVersion: "offer-release-profile-snapshot.v1",
        canonicalizationVersion: "offer-jcs.v1",
        profileName: "WMEE Kundenangebot",
        locale: "de-DE",
        currency: "EUR",
        sender: { email: "office@release.invalid" },
      });
      expect(revisedProfile?.snapshot).toMatchObject({
        snapshotSha256: revisedProfile?.snapshotSha256,
      });

      const staleProfile = await tenantQuery<{ result: Record<string, unknown> }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.revise_offer_release_profile(
           $1::uuid, 0, 'Stale', $2::jsonb, $3::jsonb
         ) as result`,
        [workspaceId, JSON.stringify(PROFILE_SENDER), JSON.stringify(LEGAL_DOCUMENTS)],
      );
      expect(staleProfile.rows).toEqual([{
        result: { status: "conflict", currentRevision: 1 },
      }]);

      if (!revisedProfile) throw new Error("Profilrevision fehlt.");
      const activationRows = await tenantQuery<{ result: ActivatedProfile }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.activate_offer_release_profile(
           $1::uuid, $2::uuid, $3::uuid, 1
         ) as result`,
        [workspaceId, revisedProfile.profileId, revisedProfile.profileRevisionId],
      );
      const activation = activationRows.rows[0]?.result;
      expect(activation).toMatchObject({
        status: "activated",
        workspaceId,
        profileId: revisedProfile.profileId,
        profileRevisionId: revisedProfile.profileRevisionId,
        profileRevision: 1,
        profileSnapshotSha256: revisedProfile.snapshotSha256,
        reviewState: "operator_reviewed",
        reviewedBy: binding.actor_id,
      });

      const recipientRows = await tenantQuery<{ result: RevisedRecipient }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.revise_offer_recipient(
           $1::uuid, $2::uuid, 0, '  Ria Rechnung  ',
           'Testkundin GmbH', 'RIA@CUSTOMER.INVALID', $3::jsonb, true
         ) as result`,
        [workspaceId, binding.offer_id, JSON.stringify(BILLING_ADDRESS)],
      );
      const recipient = recipientRows.rows[0]?.result;
      expect(recipient).toMatchObject({
        status: "revised",
        workspaceId,
        offerId: binding.offer_id,
        revision: 1,
        createdBy: binding.actor_id,
      });
      expect(recipient?.snapshot).toMatchObject({
        displayName: "Ria Rechnung",
        company: "Testkundin GmbH",
        email: "ria@customer.invalid",
        billingAddress: BILLING_ADDRESS,
        confirmation: {
          code: "recipient_billing_operator_confirmed",
          confirmed: true,
          confirmedBy: binding.actor_id,
        },
        snapshotSha256: recipient?.snapshotSha256,
      });
      expect(JSON.stringify(recipient?.snapshot)).not.toContain("installation");

      const pdfFactory = tenantFixtures.offer_pdf_draft;
      if (!pdfFactory || !activation || !recipient) {
        throw new Error("Release-Quellfixture ist unvollstaendig.");
      }
      await withTenantOn(migrator, workspaceId, async (tx) => {
        await pdfFactory(tx, workspaceId);
      });
      const sourceRows = await tenantQuery<CandidateSource>(
        migrator,
        workspaceId,
        binding.actor_id,
        `select id, project_id, offer_id, variant_id, variant_revision_id,
                variant_revision
           from public.offer_pdf_draft
          where workspace_id = $1::uuid and offer_id = $2::uuid`,
        [workspaceId, binding.offer_id],
      );
      const source = sourceRows.rows[0];
      if (!source) throw new Error("Succeeded PDF-Quelle fehlt.");
      const sourceArtifact = Buffer.from(
        `%PDF-1.7\n${"synthetic-source-artifact".repeat(8)}\n%%EOF`,
        "utf8",
      );
      const sourceLease = randomUUID();
      await tenantQuery(
        migrator,
        workspaceId,
        null,
        `update public.offer_pdf_draft
            set state = 'running', attempt_count = 1,
                lease_token = $2::uuid,
                lease_expires_at = pg_catalog.clock_timestamp()
                  + interval '5 minutes',
                started_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $3::uuid`,
        [workspaceId, sourceLease, source.id],
      );
      await tenantQuery(
        migrator,
        workspaceId,
        null,
        `update public.offer_pdf_draft
            set state = 'succeeded', lease_token = null,
                lease_expires_at = null, artifact_mime_type = 'application/pdf',
                artifact_bytes = $2::bytea,
                artifact_sha256 = pg_catalog.sha256($2::bytea),
                artifact_size_bytes = pg_catalog.octet_length($2::bytea),
                finished_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $3::uuid`,
        [workspaceId, sourceArtifact, source.id],
      );
      const validity = await tenantQuery<{
        valid_through: string;
        document_date: string;
      }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select ((pg_catalog.clock_timestamp() at time zone 'Europe/Berlin')::date
                   + 30)::text as valid_through,
                (pg_catalog.clock_timestamp() at time zone 'Europe/Berlin')::date::text
                  as document_date`,
      );
      const validThrough = validity.rows[0]?.valid_through;
      const documentDate = validity.rows[0]?.document_date;
      if (!validThrough || !documentDate) throw new Error("Gueltigkeit fehlt.");
      const prepareValues = [
        workspaceId,
        binding.offer_id,
        source.variant_id,
        source.variant_revision,
        source.id,
        activation.profileId,
        activation.profileRevisionId,
        activation.profileRevision,
        recipient.recipientRevisionId,
        recipient.revision,
        validThrough,
      ];
      const prepareCandidate = () => tenantQuery<{ result: PreparedCandidate }>(
        runtime!,
        workspaceId,
        binding.actor_id,
        `select public.prepare_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
           $6::uuid, $7::uuid, $8::integer, $9::uuid, $10::integer,
           $11::date
         ) as result`,
        prepareValues,
      );
      const preparedRace = await Promise.all([
        prepareCandidate(),
        prepareCandidate(),
      ]);
      const preparedResults = preparedRace.map((row) => row.rows[0]?.result);
      expect(preparedResults.map((row) => row?.replayed).sort()).toEqual([
        false,
        true,
      ]);
      const prepared = preparedResults.find((row) => row?.replayed === false);
      if (!prepared) throw new Error("Frischer Candidate fehlt.");
      expect(prepared).toMatchObject({
        status: "prepared",
        workspaceId,
        offerId: binding.offer_id,
        variantId: source.variant_id,
        variantRevision: 1,
        profileRevision: 1,
        recipientRevision: 1,
        state: "queued",
        attemptCount: 0,
      });
      expect(prepared.inputSnapshot).toMatchObject({
        documentStatus: "not_issued",
        documentDate,
        validThrough,
        sender: {
          legalName: PROFILE_SENDER.legalName,
          contactEmail: "office@release.invalid",
        },
        recipient: {
          displayName: "Ria Rechnung",
          billingAddress: {
            ...BILLING_ADDRESS,
            formattedAddress: "Rechnungsweg 8a, 10999 Berlin",
          },
        },
        legalDocuments: LEGAL_DOCUMENTS,
      });
      expect(JSON.stringify(prepared.inputSnapshot)).not.toContain("isHidden");
      expect(
        prepared.inputSnapshot.sections.every((section) => (
          section.lines.every((line) => !("isHidden" in line))
        )),
      ).toBe(true);
      expect(prepared.inputSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(prepared.reservationKeySha256).toMatch(/^[0-9a-f]{64}$/u);

      const staleVariant = await tenantQuery<{ result: Record<string, unknown> }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.prepare_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, 2, $4::uuid,
           $5::uuid, $6::uuid, 1, $7::uuid, 1, $8::date
         ) as result`,
        [
          workspaceId,
          binding.offer_id,
          source.variant_id,
          source.id,
          activation.profileId,
          activation.profileRevisionId,
          recipient.recipientRevisionId,
          validThrough,
        ],
      );
      expect(staleVariant.rows).toEqual([{
        result: {
          status: "conflict",
          code: "variant_revision_changed",
          currentRevision: 1,
        },
      }]);
      const invalidValidity = await tenantQuery<{ result: Record<string, unknown> }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.prepare_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, 1, $4::uuid,
           $5::uuid, $6::uuid, 1, $7::uuid, 1, $8::date
         ) as result`,
        [
          workspaceId,
          binding.offer_id,
          source.variant_id,
          source.id,
          activation.profileId,
          activation.profileRevisionId,
          recipient.recipientRevisionId,
          documentDate,
        ],
      );
      expect(invalidValidity.rows).toEqual([{
        result: { status: "conflict", code: "validity_window_changed" },
      }]);

      const notReady = await tenantQuery<{ result: Record<string, unknown> }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.approve_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           true, true, true, true, null
         ) as result`,
        [workspaceId, binding.offer_id, prepared.candidateId, randomUUID()],
      );
      expect(notReady.rows).toEqual([{
        result: { status: "conflict", code: "candidate_not_ready" },
      }]);

      await tenantQuery(
        runtime,
        workspaceId,
        binding.actor_id,
        `select pgboss.enqueue_offer_release_candidate($1::uuid, $2::uuid)`,
        [workspaceId, prepared.candidateId],
      );
      await tenantQuery(
        runtime,
        workspaceId,
        binding.actor_id,
        `select pgboss.enqueue_offer_release_candidate($1::uuid, $2::uuid)`,
        [workspaceId, prepared.candidateId],
      );
      const dispatched = await worker.query<{
        data: Record<string, unknown>;
        singleton_key: string;
        policy: string;
      }>(
        `select data, singleton_key, policy
           from pgboss.job
          where name = 'offer.release-candidate.render'
            and data->>'candidateId' = $1::text`,
        [prepared.candidateId],
      );
      expect(dispatched.rows).toEqual([{
        data: {
          schemaVersion: "offer-release-candidate-dispatch.v1",
          workspaceId,
          candidateId: prepared.candidateId,
        },
        singleton_key: `${prepared.candidateId}:1`,
        policy: "exclusive",
      }]);

      const candidateLease = randomUUID();
      await tenantQuery(
        worker,
        workspaceId,
        null,
        `update public.offer_release_candidate
            set state = 'running', attempt_count = 1,
                lease_token = $2::uuid,
                lease_expires_at = pg_catalog.clock_timestamp()
                  + interval '5 minutes',
                started_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $3::uuid`,
        [workspaceId, candidateLease, prepared.candidateId],
      );
      const candidateArtifact = Buffer.from(
        `%PDF-1.7\n${"synthetic-release-artifact".repeat(8)}\n%%EOF`,
        "utf8",
      );
      const readyCandidate = await tenantQuery<{ artifact_version: string }>(
        worker,
        workspaceId,
        null,
        `update public.offer_release_candidate
            set state = 'ready_for_approval', lease_token = null,
                lease_expires_at = null, artifact_mime_type = 'application/pdf',
                artifact_bytes = $2::bytea,
                artifact_sha256 = pg_catalog.sha256($2::bytea),
                artifact_size_bytes = pg_catalog.octet_length($2::bytea),
                artifact_version = pg_catalog.gen_random_uuid(),
                finished_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $3::uuid
          returning artifact_version`,
        [workspaceId, candidateArtifact, prepared.candidateId],
      );
      const candidateArtifactVersion = readyCandidate.rows[0]?.artifact_version;
      if (!candidateArtifactVersion) throw new Error("Candidate-Artefaktversion fehlt.");
      await tenantQuery(
        migrator,
        workspaceId,
        null,
        `update public.membership
            set role = 'editor',
                capabilities = '{"prepare_offer_documents":true}'::jsonb
          where workspace_id = $1::uuid and user_id = $2::uuid`,
        [workspaceId, binding.actor_id],
      );
      const nonApproverStatus = await tenantQuery<{
        approval_artifact_version: string | null;
      }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select approval_artifact_version
           from public.read_offer_release_candidate_status(
             $1::uuid, $2::uuid, $3::uuid
           )`,
        [workspaceId, binding.offer_id, prepared.candidateId],
      );
      expect(nonApproverStatus.rows).toEqual([{ approval_artifact_version: null }]);
      await expectDenied(tenantQuery(
        runtime,
        workspaceId,
        binding.actor_id,
        `select artifact_bytes
           from public.offer_release_candidate
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, prepared.candidateId],
      ));
      const deniedArtifactRead = await tenantQuery(
        runtime,
        workspaceId,
        binding.actor_id,
        `select artifact_bytes
           from public.read_offer_release_candidate_artifact(
             $1::uuid, $2::uuid, $3::uuid
           )`,
        [workspaceId, binding.offer_id, prepared.candidateId],
      );
      expect(deniedArtifactRead.rows).toEqual([]);
      await expectDenied(tenantQuery(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.approve_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           true, true, true, true, null
         )`,
        [
          workspaceId,
          binding.offer_id,
          prepared.candidateId,
          candidateArtifactVersion,
        ],
      ));
      await tenantQuery(
        migrator,
        workspaceId,
        null,
        `update public.membership
            set role = 'admin', capabilities = '{}'::jsonb
          where workspace_id = $1::uuid and user_id = $2::uuid`,
        [workspaceId, binding.actor_id],
      );
      const staleArtifactVersion = await tenantQuery<{
        result: Record<string, unknown>;
      }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.approve_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           true, true, true, true, null
         ) as result`,
        [workspaceId, binding.offer_id, prepared.candidateId, randomUUID()],
      );
      expect(staleArtifactVersion.rows).toEqual([{
        result: { status: "conflict", code: "candidate_not_ready" },
      }]);
      const forbiddenZeroAck = await tenantQuery<{
        result: Record<string, unknown>;
      }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.approve_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           true, true, true, true, true
         ) as result`,
        [
          workspaceId,
          binding.offer_id,
          prepared.candidateId,
          candidateArtifactVersion,
        ],
      );
      expect(forbiddenZeroAck.rows).toEqual([{
        result: { status: "conflict", code: "zero_tax_review_forbidden" },
      }]);
      const approveCandidate = () => tenantQuery<{ result: ApprovedCandidate }>(
        runtime!,
        workspaceId,
        binding.actor_id,
        `select public.approve_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           true, true, true, true, null
         ) as result`,
        [
          workspaceId,
          binding.offer_id,
          prepared.candidateId,
          candidateArtifactVersion,
        ],
      );
      const approvalRace = await Promise.all([
        approveCandidate(),
        approveCandidate(),
      ]);
      const approvals = approvalRace.map((row) => row.rows[0]?.result);
      expect(approvals.map((row) => row?.replayed).sort()).toEqual([false, true]);
      expect(new Set(approvals.map((row) => row?.approvalId)).size).toBe(1);
      const sealedApproval = await tenantQuery<{
        artifact_version: string;
        approved_by: string;
      }>(
        migrator,
        workspaceId,
        null,
        `select artifact_version, approved_by
           from public.offer_release_candidate_approval
          where workspace_id = $1::uuid and candidate_id = $2::uuid`,
        [workspaceId, prepared.candidateId],
      );
      expect(sealedApproval.rows).toEqual([{
        artifact_version: candidateArtifactVersion,
        approved_by: binding.actor_id,
      }]);
      expect(approvals[0]).toMatchObject({
        status: "approved",
        candidateId: prepared.candidateId,
        candidateState: "ready_for_approval",
        artifactMimeType: "application/pdf",
        artifactSizeBytes: candidateArtifact.length,
        derivedState: "approved_not_issued",
        approvalCommand: {
          schemaVersion: "offer-release-approval-command.v1",
          workspaceId,
          offerId: binding.offer_id,
          candidateId: prepared.candidateId,
          expectedArtifactVersion: candidateArtifactVersion,
          recipientBillingReviewed: true,
          commercialContentReviewed: true,
          activeProfileReviewed: true,
          notIssuedStatusUnderstood: true,
        },
      });
      expect(approvals[0]?.approvalCommand).not.toHaveProperty(
        "zeroTaxTreatmentReviewed",
      );

      await expectDenied(tenantQuery(
        runtime,
        randomUUID(),
        binding.actor_id,
        `select public.prepare_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, 1, $4::uuid,
           $5::uuid, $6::uuid, 1, $7::uuid, 1, $8::date
         )`,
        [
          workspaceId,
          binding.offer_id,
          source.variant_id,
          source.id,
          activation.profileId,
          activation.profileRevisionId,
          recipient.recipientRevisionId,
          validThrough,
        ],
      ));

      const relationalClient = await admin.connect();
      try {
        await relationalClient.query("begin");
        await relationalClient.query(
          "select pg_catalog.set_config('app.workspace_id', $1, true)",
          [workspaceId],
        );
        await relationalClient.query("set local session_replication_role = replica");
        await relationalClient.query(
          `update public.offer_bom_line
              set is_hidden = true
            where workspace_id = $1::uuid
              and offer_id = $2::uuid
              and variant_id = $3::uuid
              and revision_id = $4::uuid
              and revision = $5::integer`,
          [
            workspaceId,
            binding.offer_id,
            source.variant_id,
            source.variant_revision_id,
            source.variant_revision,
          ],
        );
        await relationalClient.query("commit");
      } finally {
        relationalClient.release();
      }
      const relationalHidden = await tenantQuery<{ result: Record<string, unknown> }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.prepare_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
           $6::uuid, $7::uuid, 1, $8::uuid, 1,
           ((pg_catalog.clock_timestamp() at time zone 'Europe/Berlin')::date
             + 31)::date
         ) as result`,
        [
          workspaceId,
          binding.offer_id,
          source.variant_id,
          source.variant_revision,
          source.id,
          activation.profileId,
          activation.profileRevisionId,
          recipient.recipientRevisionId,
        ],
      );
      expect(relationalHidden.rows).toEqual([{
        result: { status: "conflict", code: "hidden_line_present" },
      }]);
      const relationalRestore = await admin.connect();
      try {
        await relationalRestore.query("begin");
        await relationalRestore.query(
          "select pg_catalog.set_config('app.workspace_id', $1, true)",
          [workspaceId],
        );
        await relationalRestore.query("set local session_replication_role = replica");
        await relationalRestore.query(
          `update public.offer_bom_line
              set is_hidden = false
            where workspace_id = $1::uuid
              and offer_id = $2::uuid
              and variant_id = $3::uuid
              and revision_id = $4::uuid
              and revision = $5::integer`,
          [
            workspaceId,
            binding.offer_id,
            source.variant_id,
            source.variant_revision_id,
            source.variant_revision,
          ],
        );
        await relationalRestore.query("commit");
      } finally {
        relationalRestore.release();
      }

      for (const mode of [
        "hidden",
        "hidden_string",
        "hidden_missing",
      ] as const) {
        const hiddenSource = await createSyntheticSourceRevision(
          migrator,
          admin,
          workspaceId,
          binding.offer_id,
          binding.actor_id,
          mode,
        );
        const hiddenResult = await tenantQuery<{ result: Record<string, unknown> }>(
          runtime,
          workspaceId,
          binding.actor_id,
          `select public.prepare_offer_release_candidate(
             $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
             $6::uuid, $7::uuid, 1, $8::uuid, 1,
             ((pg_catalog.clock_timestamp() at time zone 'Europe/Berlin')::date
               + 31)::date
           ) as result`,
          [
            workspaceId,
            binding.offer_id,
            hiddenSource.variant_id,
            hiddenSource.variant_revision,
            hiddenSource.id,
            activation.profileId,
            activation.profileRevisionId,
            recipient.recipientRevisionId,
          ],
        );
        expect(hiddenResult.rows, mode).toEqual([{
          result: { status: "conflict", code: "hidden_line_present" },
        }]);
      }

      const visibleSource = await createSyntheticSourceRevision(
        migrator,
        admin,
        workspaceId,
        binding.offer_id,
        binding.actor_id,
        "visible",
      );
      const visibleResult = await tenantQuery<{ result: PreparedCandidate }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.prepare_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
           $6::uuid, $7::uuid, 1, $8::uuid, 1,
           ((pg_catalog.clock_timestamp() at time zone 'Europe/Berlin')::date
             + 31)::date
         ) as result`,
        [
          workspaceId,
          binding.offer_id,
          visibleSource.variant_id,
          visibleSource.variant_revision,
          visibleSource.id,
          activation.profileId,
          activation.profileRevisionId,
          recipient.recipientRevisionId,
        ],
      );
      expect(visibleResult.rows[0]?.result).toMatchObject({
        status: "prepared",
        state: "queued",
      });
      const staleApprovedVariant = await tenantQuery<{
        result: Record<string, unknown>;
      }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.approve_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           true, true, true, true, null
         ) as result`,
        [
          workspaceId,
          binding.offer_id,
          prepared.candidateId,
          candidateArtifactVersion,
        ],
      );
      expect(staleApprovedVariant.rows).toEqual([{
        result: { status: "conflict", code: "candidate_source_changed" },
      }]);

      const zeroTaxSource = await createSyntheticSourceRevision(
        migrator,
        admin,
        workspaceId,
        binding.offer_id,
        binding.actor_id,
        "zero_tax",
      );
      const zeroPreparedRows = await tenantQuery<{ result: PreparedCandidate }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.prepare_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
           $6::uuid, $7::uuid, 1, $8::uuid, 1,
           ((pg_catalog.clock_timestamp() at time zone 'Europe/Berlin')::date
             + 32)::date
         ) as result`,
        [
          workspaceId,
          binding.offer_id,
          zeroTaxSource.variant_id,
          zeroTaxSource.variant_revision,
          zeroTaxSource.id,
          activation.profileId,
          activation.profileRevisionId,
          recipient.recipientRevisionId,
        ],
      );
      const zeroPrepared = zeroPreparedRows.rows[0]?.result;
      if (!zeroPrepared) throw new Error("Zero-Tax-Candidate fehlt.");
      expect(zeroPrepared).toMatchObject({
        status: "prepared",
        state: "queued",
        replayed: false,
      });
      expect(zeroPrepared.inputSnapshot).toMatchObject({
        totals: { basisTaxCents: 0, basisGrossCents: 100 },
      });
      const zeroCandidateArtifact = Buffer.from(
        `%PDF-1.7\n${"synthetic-zero-tax-artifact".repeat(8)}\n%%EOF`,
        "utf8",
      );
      await tenantQuery(
        worker,
        workspaceId,
        null,
        `update public.offer_release_candidate
            set state = 'running', attempt_count = 1,
                lease_token = pg_catalog.gen_random_uuid(),
                lease_expires_at = pg_catalog.clock_timestamp()
                  + interval '5 minutes',
                started_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, zeroPrepared.candidateId],
      );
      const readyZeroCandidate = await tenantQuery<{ artifact_version: string }>(
        worker,
        workspaceId,
        null,
        `update public.offer_release_candidate
            set state = 'ready_for_approval', lease_token = null,
                lease_expires_at = null, artifact_mime_type = 'application/pdf',
                artifact_bytes = $3::bytea,
                artifact_sha256 = pg_catalog.sha256($3::bytea),
                artifact_size_bytes = pg_catalog.octet_length($3::bytea),
                artifact_version = pg_catalog.gen_random_uuid(),
                finished_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $2::uuid
          returning artifact_version`,
        [workspaceId, zeroPrepared.candidateId, zeroCandidateArtifact],
      );
      const zeroArtifactVersion = readyZeroCandidate.rows[0]?.artifact_version;
      if (!zeroArtifactVersion) throw new Error("Zero-Tax-Artefaktversion fehlt.");
      const requiredZeroAck = await tenantQuery<{
        result: Record<string, unknown>;
      }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.approve_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           true, true, true, true, null
         ) as result`,
        [workspaceId, binding.offer_id, zeroPrepared.candidateId, zeroArtifactVersion],
      );
      expect(requiredZeroAck.rows).toEqual([{
        result: { status: "conflict", code: "zero_tax_review_required" },
      }]);
      const zeroApproval = await tenantQuery<{ result: ApprovedCandidate }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.approve_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           true, true, true, true, true
         ) as result`,
        [workspaceId, binding.offer_id, zeroPrepared.candidateId, zeroArtifactVersion],
      );
      expect(zeroApproval.rows[0]?.result).toMatchObject({
        status: "approved",
        candidateId: zeroPrepared.candidateId,
        approvalCommand: { zeroTaxTreatmentReviewed: true },
        replayed: false,
      });

      const recipientRevision2Rows = await tenantQuery<{
        result: RevisedRecipient;
      }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.revise_offer_recipient(
           $1::uuid, $2::uuid, 1, 'Ria Rechnung Neu',
           'Testkundin GmbH', 'ria-neu@customer.invalid', $3::jsonb, true
         ) as result`,
        [workspaceId, binding.offer_id, JSON.stringify(BILLING_ADDRESS)],
      );
      const recipientRevision2 = recipientRevision2Rows.rows[0]?.result;
      if (!recipientRevision2) throw new Error("Recipient-Revision 2 fehlt.");
      const staleApprovedRecipient = await tenantQuery<{
        result: Record<string, unknown>;
      }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.approve_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           true, true, true, true, true
         ) as result`,
        [workspaceId, binding.offer_id, zeroPrepared.candidateId, zeroArtifactVersion],
      );
      expect(staleApprovedRecipient.rows).toEqual([{
        result: { status: "conflict", code: "candidate_source_changed" },
      }]);
      const stalePreparedRecipient = await tenantQuery<{
        result: Record<string, unknown>;
      }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.prepare_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
           $6::uuid, $7::uuid, 1, $8::uuid, 1,
           ((pg_catalog.clock_timestamp() at time zone 'Europe/Berlin')::date
             + 34)::date
         ) as result`,
        [
          workspaceId,
          binding.offer_id,
          zeroTaxSource.variant_id,
          zeroTaxSource.variant_revision,
          zeroTaxSource.id,
          activation.profileId,
          activation.profileRevisionId,
          recipient.recipientRevisionId,
        ],
      );
      expect(stalePreparedRecipient.rows).toEqual([{
        result: {
          status: "conflict",
          code: "recipient_revision_changed",
          currentRevision: 2,
        },
      }]);

      const activePreparedRows = await tenantQuery<{ result: PreparedCandidate }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.prepare_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
           $6::uuid, $7::uuid, 1, $8::uuid, 2,
           ((pg_catalog.clock_timestamp() at time zone 'Europe/Berlin')::date
             + 33)::date
         ) as result`,
        [
          workspaceId,
          binding.offer_id,
          zeroTaxSource.variant_id,
          zeroTaxSource.variant_revision,
          zeroTaxSource.id,
          activation.profileId,
          activation.profileRevisionId,
          recipientRevision2.recipientRevisionId,
        ],
      );
      const activePrepared = activePreparedRows.rows[0]?.result;
      if (!activePrepared) throw new Error("Lease-Candidate fehlt.");
      await tenantQuery(
        worker,
        workspaceId,
        null,
        `update public.offer_release_candidate
            set state = 'running', attempt_count = 1,
                lease_token = pg_catalog.gen_random_uuid(),
                lease_expires_at = pg_catalog.clock_timestamp()
                  + interval '5 minutes',
                started_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, activePrepared.candidateId],
      );
      const profileRevision2Rows = await tenantQuery<{ result: RevisedProfile }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.revise_offer_release_profile(
           $1::uuid, 1, 'WMEE Kundenangebot Revision 2', $2::jsonb, $3::jsonb
         ) as result`,
        [workspaceId, JSON.stringify(PROFILE_SENDER), JSON.stringify(LEGAL_DOCUMENTS)],
      );
      const profileRevision2 = profileRevision2Rows.rows[0]?.result;
      if (!profileRevision2) throw new Error("Profilrevision 2 fehlt.");
      const activation2Rows = await tenantQuery<{ result: ActivatedProfile }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.activate_offer_release_profile(
           $1::uuid, $2::uuid, $3::uuid, 2
         ) as result`,
        [
          workspaceId,
          profileRevision2.profileId,
          profileRevision2.profileRevisionId,
        ],
      );
      expect(activation2Rows.rows[0]?.result).toMatchObject({
        status: "activated",
        profileRevision: 2,
        reviewState: "operator_reviewed",
      });
      const staleApprovedProfile = await tenantQuery<{
        result: Record<string, unknown>;
      }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.approve_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           true, true, true, true, true
         ) as result`,
        [workspaceId, binding.offer_id, zeroPrepared.candidateId, zeroArtifactVersion],
      );
      expect(staleApprovedProfile.rows).toEqual([{
        result: { status: "conflict", code: "profile_activation_changed" },
      }]);
      const stalePreparedProfile = await tenantQuery<{
        result: Record<string, unknown>;
      }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.prepare_offer_release_candidate(
           $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
           $6::uuid, $7::uuid, 1, $8::uuid, 2,
           ((pg_catalog.clock_timestamp() at time zone 'Europe/Berlin')::date
             + 35)::date
         ) as result`,
        [
          workspaceId,
          binding.offer_id,
          zeroTaxSource.variant_id,
          zeroTaxSource.variant_revision,
          zeroTaxSource.id,
          activation.profileId,
          activation.profileRevisionId,
          recipientRevision2.recipientRevisionId,
        ],
      );
      expect(stalePreparedProfile.rows).toEqual([{
        result: {
          status: "conflict",
          code: "profile_revision_changed",
          currentRevision: 2,
        },
      }]);
      const contactRows = await tenantQuery<{ contact_id: string }>(
        migrator,
        workspaceId,
        null,
        `select contact_id
           from public.offer
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, binding.offer_id],
      );
      const contactId = contactRows.rows[0]?.contact_id;
      if (!contactId) throw new Error("Erasure-Kontakt fehlt.");
      const leaseFixtureClient = await admin.connect();
      try {
        await leaseFixtureClient.query("begin");
        await leaseFixtureClient.query(
          "set local session_replication_role = replica",
        );
        await leaseFixtureClient.query(
          `update public.project_calculation_job
              set lease_expires_at = pg_catalog.clock_timestamp()
                - interval '1 minute'
            where workspace_id = $1::uuid`,
          [workspaceId],
        );
        await leaseFixtureClient.query("commit");
      } catch (error) {
        await leaseFixtureClient.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        leaseFixtureClient.release();
      }
      await expect(callErasureAsDedicatedRole(
        admin,
        workspaceId,
        contactId,
        randomUUID(),
      )).rejects.toMatchObject({ code: "55006" });

      await tenantQuery(
        worker,
        workspaceId,
        null,
        `update public.offer_release_candidate
            set state = 'failed_final', lease_token = null,
                lease_expires_at = null, error_code = 'synthetic_failure',
                error_retryable = false,
                finished_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, activePrepared.candidateId],
      );
      await expect(tenantQuery(
        migrator,
        workspaceId,
        null,
        `delete from public.offer_release_candidate
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, activePrepared.candidateId],
      )).rejects.toThrow(/Erasurevertrag/u);

      const graphRows = await tenantQuery<{ graph_ids: Record<string, unknown> }>(
        migrator,
        workspaceId,
        null,
        `select public.build_inactive_lead_erasure_graph(
           $1::uuid, $2::uuid
         ) as graph_ids`,
        [workspaceId, contactId],
      );
      const erasureGraph = graphRows.rows[0]?.graph_ids;
      if (!erasureGraph) throw new Error("Release-Erasuregraph fehlt.");
      expect(erasureGraph).toMatchObject({
        contactId,
        offerRecipientIds: [recipient.recipientId],
      });
      for (const key of [
        "offerRecipientRevisionIds",
        "offerReleaseCandidateIds",
        "offerReleaseCandidateApprovalIds",
      ] as const) {
        const ids = erasureGraph[key];
        expect(Array.isArray(ids)).toBe(true);
        expect(ids).toEqual([...(ids as string[])].sort());
      }
      expect(erasureGraph).not.toHaveProperty("offerReleaseProfileIds");

      const erasureOperationId = randomUUID();
      await tenantQuery(
        migrator,
        workspaceId,
        null,
        `insert into public.erasure_operation_locator (operation_id, scope_id)
         values ($1::uuid, $2::uuid)`,
        [erasureOperationId, workspaceId],
      );
      await tenantQuery(
        migrator,
        workspaceId,
        null,
        `with material as (
           select $4::jsonb as graph_ids,
                  pg_catalog.clock_timestamp() - interval '1 day' as eligible_at,
                  pg_catalog.clock_timestamp() as erased_at
         ), graph_hash as (
           select material.*,
                  pg_catalog.sha256(pg_catalog.convert_to(
                    material.graph_ids::text, 'UTF8'
                  )) as graph_sha256
             from material
         ), sealed as (
           select graph_hash.*,
                  pg_catalog.sha256(pg_catalog.convert_to(
                    pg_catalog.concat_ws(
                      '|', $1::uuid::text, $2::uuid::text, $3::uuid::text,
                      'inactive_lead_24_months',
                      pg_catalog.encode(graph_hash.graph_sha256, 'hex'),
                      pg_catalog.encode(
                        pg_catalog.timestamptz_send(graph_hash.eligible_at),
                        'hex'
                      ),
                      pg_catalog.encode(
                        pg_catalog.timestamptz_send(graph_hash.erased_at),
                        'hex'
                      )
                    ), 'UTF8'
                  )) as tombstone_sha256
             from graph_hash
         )
         insert into public.erasure_tombstone (
           operation_id, workspace_id, contact_id, reason, graph_sha256,
           tombstone_sha256, graph_ids, eligible_at, erased_at
         )
         select $1::uuid, $2::uuid, $3::uuid, 'inactive_lead_24_months',
                graph_sha256, tombstone_sha256, graph_ids,
                eligible_at, erased_at
           from sealed`,
        [
          erasureOperationId,
          workspaceId,
          contactId,
          JSON.stringify(erasureGraph),
        ],
      );
      expect(await callErasureAsDedicatedRole(
        admin,
        workspaceId,
        contactId,
        erasureOperationId,
      )).toBe(erasureOperationId);
      expect(await callErasureAsDedicatedRole(
        admin,
        workspaceId,
        contactId,
        erasureOperationId,
      )).toBe(erasureOperationId);
      const erasedReleaseRows = await tenantQuery<{
        candidate_count: number;
        approval_count: number;
        recipient_count: number;
        profile_count: number;
      }>(
        migrator,
        workspaceId,
        null,
        `select
           (select pg_catalog.count(*)::int
              from public.offer_release_candidate
             where workspace_id = $1::uuid) as candidate_count,
           (select pg_catalog.count(*)::int
              from public.offer_release_candidate_approval
             where workspace_id = $1::uuid) as approval_count,
           (select pg_catalog.count(*)::int
              from public.offer_recipient
             where workspace_id = $1::uuid) as recipient_count,
           (select pg_catalog.count(*)::int
              from public.offer_release_profile
             where workspace_id = $1::uuid) as profile_count`,
        [workspaceId],
      );
      expect(erasedReleaseRows.rows).toEqual([{
        candidate_count: 0,
        approval_count: 0,
        recipient_count: 0,
        profile_count: 1,
      }]);

      await expectDenied(tenantQuery(
        runtime,
        workspaceId,
        binding.actor_id,
        `insert into public.offer_recipient (
           workspace_id, offer_id, created_by
         ) values ($1::uuid, $2::uuid, $3::uuid)`,
        [workspaceId, binding.offer_id, binding.actor_id],
      ));
      await expectDenied(tenantQuery(
        runtime,
        randomUUID(),
        binding.actor_id,
        `select public.revise_offer_release_profile(
           $1::uuid, 1, 'Fremd', $2::jsonb, $3::jsonb
         )`,
        [workspaceId, JSON.stringify(PROFILE_SENDER), JSON.stringify(LEGAL_DOCUMENTS)],
      ));
      await expectDenied(tenantQuery(
        runtime,
        workspaceId,
        randomUUID(),
        `select public.revise_offer_release_profile(
           $1::uuid, 1, 'Ohne Membership', $2::jsonb, $3::jsonb
         )`,
        [workspaceId, JSON.stringify(PROFILE_SENDER), JSON.stringify(LEGAL_DOCUMENTS)],
      ));

      await expect(tenantQuery(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.revise_offer_recipient(
           $1::uuid, $2::uuid, 1, 'Ria Rechnung', null,
           'ria@customer.invalid', $3::jsonb, false
         )`,
        [workspaceId, binding.offer_id, JSON.stringify(BILLING_ADDRESS)],
      )).rejects.toMatchObject({ code: "22023" });

      await expect(tenantQuery(
        migrator,
        workspaceId,
        null,
        `update public.offer_release_profile
            set current_revision = current_revision + 2
          where workspace_id = $1::uuid`,
        [workspaceId],
      )).rejects.toThrow(/monoton/u);
      await expect(tenantQuery(
        migrator,
        workspaceId,
        null,
        `update public.offer_release_profile_revision
            set snapshot = snapshot
          where workspace_id = $1::uuid`,
        [workspaceId],
      )).rejects.toThrow(/append-only|immutable/u);
      await expect(migrator.query(
        "truncate table public.offer_release_candidate_approval",
      )).rejects.toThrow(/TRUNCATE|append-only/u);

      const foreignRead = await tenantQuery<{ id: string }>(
        runtime,
        randomUUID(),
        binding.actor_id,
        "select id from public.offer_release_profile where workspace_id = $1::uuid",
        [workspaceId],
      );
      expect(foreignRead.rows).toEqual([]);
    } finally {
      await worker?.end().catch(() => undefined);
      await runtime?.end().catch(() => undefined);
      await migrator?.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      await embedded.stop().catch(() => undefined);
    }
  }, 180_000);
});
