import { randomBytes, randomUUID } from "node:crypto";
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
import { PgBoss } from "pg-boss";
import { Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  hashSignatureToken,
  SIGNATURE_REQUEST_CREATE_VERSION,
} from "@/lib/integrations/offers/signature-contract";
import {
  createSignatureRequest,
  recordSignatureView,
  revokeSignatureByCustomer,
  SignatureConflictError,
  signSignatureByToken,
  uploadAnalogSignature,
  withdrawSignatureRequest,
} from "@/modules/signatures";
import { startEmbeddedPostgres, type EmbeddedTestDatabase } from "../setup/embedded-postgres";
import {
  applyDefaultPrivilegeContract,
  applyRoleContract,
  verifyRoleContract,
} from "../../scripts/db-role-contract.mjs";
import {
  CATALOG_IMPORT_CLEANUP_QUEUE_OPTIONS,
  CATALOG_IMPORT_QUEUE_OPTIONS,
  CUSTOMER_NOTIFICATION_QUEUE_OPTIONS,
  CALCULATION_V2_QUEUE_OPTIONS,
  OFFER_ISSUANCE_QUEUE_OPTIONS,
  OFFER_PDF_QUEUE_OPTIONS,
  OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS,
} from "../../scripts/pgboss-bootstrap.mjs";
import { tenantFixtures } from "../setup/tenant-fixtures";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
  endPoolsAndStopEmbeddedPostgres,
} from "../setup/pg-pool-drain";

const DB = "energie_saas_test";
const MIGRATOR_PASSWORD = "m204_migrator";
const RUNTIME_PASSWORD = "m204_runtime";
const WORKER_PASSWORD = "m204_worker";
const PRE_F208B_MIGRATION_INDEX = 75;

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

type JsonResult = QueryResultRow & { result: Record<string, unknown> };

function serviceUrl(embedded: EmbeddedTestDatabase, role: string, password: string): string {
  const url = new URL(embedded.url);
  url.username = role;
  url.password = password;
  return url.toString();
}

function migrationPrefixThroughF208bPredecessor(): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-f208b-role-prefix-"));
  mkdirSync(join(target, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(source, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.filter(
    (entry) => entry.idx <= PRE_F208B_MIGRATION_INDEX,
  );
  if (
    entries.length !== PRE_F208B_MIGRATION_INDEX + 1
    || entries.at(-1)?.idx !== PRE_F208B_MIGRATION_INDEX
  ) {
    rmSync(target, { recursive: true, force: true });
    throw new Error("F2.8b Rollen-Prefix 0..75 ist nicht lueckenlos.");
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

async function bootstrapStrictRoles(admin: Pool): Promise<void> {
  await admin.query(`
    create role app_owner nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_migrator login password '${MIGRATOR_PASSWORD}' noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_runtime login password '${RUNTIME_PASSWORD}' noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_system login noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_auth login noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_worker login password '${WORKER_PASSWORD}' noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_erasure nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role identity_reconciler nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    grant app_owner to app_migrator with admin false, inherit false, set true;
    grant app_worker to app_migrator with admin false, inherit false, set true;
    grant app_membership_writer to app_owner with admin false, inherit false, set false;
    grant app_membership_writer to app_system with admin false, inherit false, set false;
    grant identity_reconciler to app_owner with admin true, inherit false, set false;
    revoke app_membership_writer from app_test granted by current_user;
    alter database ${DB} owner to app_owner;
    alter schema public owner to app_owner;
    revoke all on database ${DB} from app_test;
    revoke all on schema public from public, app_test;
    create schema pgboss authorization app_worker;
    grant connect on database ${DB} to app_runtime, app_worker;
  `);
}

async function installPgBoss(workerUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: workerUrl, schema: "pgboss", createSchema: false });
  const errors: unknown[] = [];
  boss.on("error", (error) => errors.push(error));
  try {
    await boss.start();
    await boss.createQueue("calculation.execute", { policy: "exclusive", retryLimit: 0, expireInSeconds: 900 });
    await boss.createQueue("calculation.execute.v2", CALCULATION_V2_QUEUE_OPTIONS);
    await boss.createQueue("catalog.import.v1", CATALOG_IMPORT_QUEUE_OPTIONS);
    await boss.createQueue("catalog.import.cleanup.v1", CATALOG_IMPORT_CLEANUP_QUEUE_OPTIONS);
    await boss.createQueue("pdf.render", OFFER_PDF_QUEUE_OPTIONS);
    await boss.createQueue("offer.release-candidate.render", OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS);
    await boss.createQueue("offer-issuance.render.v1", OFFER_ISSUANCE_QUEUE_OPTIONS);
    await boss.createQueue("notification.customer", CUSTOMER_NOTIFICATION_QUEUE_OPTIONS);
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
  expect(errors).toEqual([]);
}

async function adminQuery<Row extends QueryResultRow = QueryResultRow>(
  admin: Pool,
  workspaceId: string,
  actorId: string | null,
  text: string,
  values: unknown[] = [],
) {
  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId ?? ""]);
    const result = await client.query<Row>(text, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function runtimeQuery<Row extends QueryResultRow = QueryResultRow>(
  runtime: Pool,
  workspaceId: string,
  actorId: string | null,
  text: string,
  values: unknown[] = [],
) {
  const client = await runtime.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId ?? ""]);
    const result = await client.query<Row>(text, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function addMember(
  admin: Pool,
  workspaceId: string,
  role: "editor" | "admin",
  capabilities: Record<string, boolean>,
): Promise<string> {
  const actorId = randomUUID();
  await admin.query(
    "insert into public.user_identity (id, email) values ($1::uuid, $2::text)",
    [actorId, `m204-external-${actorId}@invalid`],
  );
  await adminQuery(
    admin,
    workspaceId,
    null,
    `insert into public.membership (workspace_id, user_id, role, capabilities)
     values ($1::uuid, $2::uuid, $3::text, $4::jsonb)`,
    [workspaceId, actorId, role, JSON.stringify(capabilities)],
  );
  return actorId;
}

async function cloneApprovedIssuanceFixture(
  admin: Pool,
  workspaceId: string,
  offerId: string,
): Promise<string> {
  const issuanceId = randomUUID();
  const client = await admin.connect();
  try {
    await client.query("begin");
    // Nur das synthetische Fixture vervielfacht eine bereits vollstaendig
    // validierte Ausstellungsfassung. Fachpfade darunter bleiben aktiv; alle
    // Tabellen-CHECKs werden weiterhin von PostgreSQL ausgewertet.
    await client.query("set local session_replication_role = replica");
    const result = await client.query<{ approvals: number }>(`
      with source as materialized (
        select issuance_record.*
          from public.offer_issuance as issuance_record
         where issuance_record.workspace_id = $1::uuid
           and issuance_record.offer_id = $2::uuid
           and issuance_record.state = 'ready_for_approval'
         order by issuance_record.created_at desc, issuance_record.id desc
         limit 1
      ), clone_values as materialized (
        select $3::uuid as issuance_id,
               source.created_at + interval '1 second' as prepared_at,
               pg_catalog.sha256(pg_catalog.convert_to($3::text, 'UTF8'))
                 as reservation_key
          from source
      ), cloned_snapshot as materialized (
        select source.*,
               clone_values.issuance_id as cloned_issuance_id,
               clone_values.prepared_at as cloned_prepared_at,
               clone_values.reservation_key as cloned_reservation_key,
               pg_catalog.jsonb_set(
                 pg_catalog.jsonb_set(
                   source.input_snapshot,
                   '{issuanceId}', pg_catalog.to_jsonb(clone_values.issuance_id::text)
                 ),
                 '{preparedAt}', pg_catalog.to_jsonb(clone_values.prepared_at)
               ) as cloned_input_snapshot
          from source cross join clone_values
      ), inserted_issuance as (
        insert into public.offer_issuance
        select (pg_catalog.jsonb_populate_record(
          null::public.offer_issuance,
          pg_catalog.to_jsonb(cloned_snapshot)
            || pg_catalog.jsonb_build_object(
              'id', cloned_snapshot.cloned_issuance_id,
              'prepared_at', cloned_snapshot.cloned_prepared_at,
              'created_at', cloned_snapshot.cloned_prepared_at,
              'updated_at', cloned_snapshot.cloned_prepared_at,
              'reservation_key', cloned_snapshot.cloned_reservation_key,
              'input_snapshot', cloned_snapshot.cloned_input_snapshot,
              'input_sha256', pg_catalog.sha256(pg_catalog.convert_to(
                public.canonicalize_offer_json_v1(
                  cloned_snapshot.cloned_input_snapshot
                ),
                'UTF8'
              ))
            )
        )).*
          from cloned_snapshot
        returning id, input_sha256
      ), approval_source as materialized (
        select approval.*
          from public.offer_issuance_approval as approval
          join source on source.workspace_id = approval.workspace_id
                     and source.id = approval.issuance_id
      ), inserted_approvals as (
        insert into public.offer_issuance_approval
        select (pg_catalog.jsonb_populate_record(
          null::public.offer_issuance_approval,
          pg_catalog.to_jsonb(approval_source)
            || pg_catalog.jsonb_build_object(
              'id', pg_catalog.gen_random_uuid(),
              'issuance_id', inserted_issuance.id,
              'input_sha256', inserted_issuance.input_sha256,
              'approval_command', pg_catalog.jsonb_set(
                approval_source.approval_command,
                '{issuanceId}', pg_catalog.to_jsonb(inserted_issuance.id::text)
              )
            )
        )).*
          from approval_source cross join inserted_issuance
        returning id
      )
      select pg_catalog.count(*)::integer as approvals from inserted_approvals
    `, [workspaceId, offerId, issuanceId]);
    if (result.rows[0]?.approvals !== 2) {
      throw new Error("F2.8b Mehrfach-Link-Fixture verlangt zwei Freigaben.");
    }
    await client.query("commit");
    return issuanceId;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function buildApprovedIssuance(admin: Pool, workspaceId: string): Promise<{
  issuanceId: string;
  offerId: string;
  variantId: string;
  projectId: string;
  actorId: string;
  contactId: string;
}> {
  await admin.query("insert into public.workspace (id, name) values ($1, 'M2-04-strict')", [workspaceId]);
  await withTenantOn(admin, workspaceId, async (tx) => {
    await tenantFixtures.offer?.(tx, workspaceId);
    await tenantFixtures.offer_pdf_draft?.(tx, workspaceId);
  });

  const source = await adminQuery<{
    source_pdf_draft_id: string;
    source_state: string;
    project_id: string;
    offer_id: string;
    variant_id: string;
    variant_revision_id: string;
    variant_revision: number;
    actor_id: string;
  }>(
    admin,
    workspaceId,
    null,
    `select draft.id as source_pdf_draft_id, draft.state as source_state,
            draft.project_id, draft.offer_id,
            draft.variant_id, draft.variant_revision_id, draft.variant_revision,
            offer_record.created_by as actor_id
       from offer_pdf_draft as draft
       join offer as offer_record on offer_record.workspace_id = draft.workspace_id and offer_record.id = draft.offer_id
      where draft.workspace_id = $1::uuid
      order by draft.created_at desc, draft.id desc limit 1`,
    [workspaceId],
  );
  const row = source.rows[0];
  if (!row) throw new Error("PDF-Entwurf fehlt.");

  await adminQuery(admin, workspaceId, null, `update project set phase = 'offer' where workspace_id = $1::uuid and id = $2::uuid`, [workspaceId, row.project_id]);

  await adminQuery(admin, workspaceId, null, `update membership set role = 'admin', capabilities = '{}'::jsonb where workspace_id = $1::uuid and user_id = $2::uuid`, [workspaceId, row.actor_id]);

  const sender = { legalName: "M204 Energie GmbH", tradingName: "M204", representedBy: "M204 Vertretung", address: { street: "Testweg", houseNumber: "1", postalCode: "10115", city: "Berlin", country: "DE" }, email: "office@m204.invalid", phoneE164: "+493000000000", websiteHttpsUrl: "https://m204.invalid", registerCourt: "M204 RG", registerNumber: "HRB M204", vatId: "DE000000000" };
  const legalDocuments = { terms: { title: "Bedingungen", plainText: "Synthetische Bedingungen." }, withdrawalInformation: { title: "Widerruf", plainText: "Synthetische Widerrufsinformation." }, privacyNotice: { title: "Datenschutz", plainText: "Synthetischer Datenschutzhinweis." } };
  await adminQuery(admin, workspaceId, row.actor_id, `select public.revise_offer_release_profile($1::uuid, 0, 'M204 Profil', $2::jsonb, $3::jsonb)`, [workspaceId, JSON.stringify(sender), JSON.stringify(legalDocuments)]);
  const profile = await adminQuery<{ profile_id: string; profile_revision_id: string; profile_revision: number }>(admin, workspaceId, null, `select profile.id as profile_id, revision.id as profile_revision_id, revision.revision as profile_revision from offer_release_profile as profile join offer_release_profile_revision as revision on revision.workspace_id = profile.workspace_id and revision.profile_id = profile.id and revision.revision = profile.current_revision where profile.workspace_id = $1::uuid limit 1`, [workspaceId]);
  await adminQuery(admin, workspaceId, row.actor_id, `select public.activate_offer_release_profile($1::uuid, $2::uuid, $3::uuid, $4::integer)`, [workspaceId, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision]);

  const billingAddress = { street: "Rechnungsweg", houseNumber: "8a", postalCode: "10999", city: "Berlin", country: "DE" };
  await adminQuery(admin, workspaceId, row.actor_id, `select public.revise_offer_recipient($1::uuid, $2::uuid, 0, 'M204 Rechnungsempfaenger', 'M204 Kundin GmbH', 'rechnung@m204.invalid', $3::jsonb, true)`, [workspaceId, row.offer_id, JSON.stringify(billingAddress)]);
  const recipient = await adminQuery<{ recipient_revision_id: string; recipient_revision: number }>(admin, workspaceId, null, `select revision.id as recipient_revision_id, revision.revision as recipient_revision from offer_recipient as recipient join offer_recipient_revision as revision on revision.workspace_id = recipient.workspace_id and revision.recipient_id = recipient.id and revision.revision = recipient.current_revision where recipient.workspace_id = $1::uuid and recipient.offer_id = $2::uuid limit 1`, [workspaceId, row.offer_id]);

  if (row.source_state !== "succeeded") {
    await adminQuery(admin, workspaceId, null, `update offer_pdf_draft set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`, [workspaceId, row.source_pdf_draft_id]);
    const sourceArtifact = Buffer.from(`%PDF-1.7\n${"m204-release-source".repeat(8)}\n%%EOF`, "utf8");
    await adminQuery(admin, workspaceId, null, `update offer_pdf_draft set state = 'succeeded', lease_token = null, lease_expires_at = null, artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea), finished_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $3::uuid and state = 'running'`, [workspaceId, sourceArtifact, row.source_pdf_draft_id]);
  }

  await adminQuery(admin, workspaceId, row.actor_id, `select public.prepare_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::uuid, $7::uuid, $8::integer, $9::uuid, $10::integer, ((clock_timestamp() at time zone 'Europe/Berlin')::date + 14)::date)`, [workspaceId, row.offer_id, row.variant_id, row.variant_revision, row.source_pdf_draft_id, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision, recipient.rows[0]?.recipient_revision_id, recipient.rows[0]?.recipient_revision]);
  const candidate = await adminQuery<{ candidate_id: string }>(admin, workspaceId, null, `select id as candidate_id from offer_release_candidate where workspace_id = $1::uuid and offer_id = $2::uuid order by created_at desc, id desc limit 1`, [workspaceId, row.offer_id]);

  await adminQuery(admin, workspaceId, null, `update offer_release_candidate set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`, [workspaceId, candidate.rows[0]?.candidate_id]);
  const candidateArtifact = Buffer.from(`%PDF-1.7\n${"m204-release-candidate".repeat(8)}\n%%EOF`, "utf8");
  const artifactVersion = randomUUID();
  await adminQuery(admin, workspaceId, null, `update offer_release_candidate set state = 'ready_for_approval', lease_token = null, lease_expires_at = null, artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea), artifact_version = $3::uuid, finished_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $4::uuid and state = 'running'`, [workspaceId, candidateArtifact, artifactVersion, candidate.rows[0]?.candidate_id]);
  await adminQuery(admin, workspaceId, row.actor_id, `select public.approve_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, true, true, true, null)`, [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id, artifactVersion]);

  const prepared = await adminQuery<JsonResult>(admin, workspaceId, row.actor_id, `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`, [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id]);
  const issuanceId = prepared.rows[0]?.result.issuanceId;
  if (typeof issuanceId !== "string") throw new Error("Reservation fehlt.");
  const lease = randomUUID();
  await adminQuery(admin, workspaceId, null, `select public.claim_offer_issuance_render($1::uuid, $2::uuid, $3::uuid, 120) as result`, [workspaceId, issuanceId, lease]);
  const artifact = Buffer.from(`%PDF-1.7\n${"m204-final-issuance".repeat(8)}\n%%EOF`, "utf8");
  await adminQuery(admin, workspaceId, null, `select public.finalize_offer_issuance_render_success($1::uuid, $2::uuid, $3::uuid, 1, $4::bytea) as result`, [workspaceId, issuanceId, lease, artifact]);

  const secondActor = randomUUID();
  await admin.query("insert into public.user_identity (id, email) values ($1, $2)", [secondActor, `m204-${secondActor}@invalid`]);
  const mc = await admin.connect();
  await mc.query("begin");
  await mc.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
  await mc.query("insert into public.membership (workspace_id, user_id, role, capabilities) values ($1, $2, 'admin', '{}'::jsonb)", [workspaceId, secondActor]);
  await mc.query("commit");
  mc.release();

  const firstApproval = await adminQuery<JsonResult>(admin, workspaceId, row.actor_id, `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`, [workspaceId, issuanceId]);
  if (firstApproval.rows[0]?.result.status !== "approved") throw new Error("erste Freigabe fehlt.");
  const secondApproval = await adminQuery<JsonResult>(admin, workspaceId, secondActor, `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`, [workspaceId, issuanceId]);
  if (secondApproval.rows[0]?.result.status !== "approved") throw new Error("zweite Freigabe fehlt.");

  const contact = await adminQuery<{ contact_id: string }>(admin, workspaceId, null, `select contact_id from offer where workspace_id = $1::uuid and id = $2::uuid`, [workspaceId, row.offer_id]);
  return { issuanceId, offerId: row.offer_id, variantId: row.variant_id, projectId: row.project_id, actorId: row.actor_id, contactId: contact.rows[0]?.contact_id ?? "" };
}

type SignatureErasureGraph = {
  signatureRequestIds?: string[];
  signatureAttestationIds?: string[];
  signatureViewLogIds?: string[];
};

async function createSignatureErasureTombstone(
  admin: Pool,
  workspaceId: string,
  actorId: string,
  contactId: string,
): Promise<{ graph: SignatureErasureGraph; operationId: string }> {
  const graphRow = await adminQuery<{ graph: SignatureErasureGraph }>(
    admin,
    workspaceId,
    actorId,
    `select public.build_inactive_lead_erasure_graph($1::uuid, $2::uuid) as graph`,
    [workspaceId, contactId],
  );
  const graph = graphRow.rows[0]?.graph;
  if (!graph) throw new Error("Signatur-Erasure-Graph fehlt.");

  const operationId = randomUUID();
  const eligibleAt = new Date(Date.now() - 24 * 3600 * 1000);
  const erasedAt = new Date();
  await admin.query(
    `insert into public.erasure_operation_locator (operation_id, scope_id)
     values ($1::uuid, $2::uuid)`,
    [operationId, workspaceId],
  );
  await admin.query(
    `insert into public.erasure_tombstone (
       operation_id, workspace_id, contact_id, reason, graph_sha256,
       tombstone_sha256, graph_ids, eligible_at, erased_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 'inactive_lead_24_months',
       pg_catalog.sha256(pg_catalog.convert_to($4::jsonb::text, 'UTF8')),
       pg_catalog.sha256(pg_catalog.convert_to(
         pg_catalog.concat_ws('|',
           $1::text, $2::text, $3::text, 'inactive_lead_24_months',
           pg_catalog.encode(
             pg_catalog.sha256(pg_catalog.convert_to($4::jsonb::text, 'UTF8')),
             'hex'
           ),
           pg_catalog.encode(pg_catalog.timestamptz_send($5::timestamptz), 'hex'),
           pg_catalog.encode(pg_catalog.timestamptz_send($6::timestamptz), 'hex')
         ), 'UTF8'
       )),
       $4::jsonb, $5::timestamptz, $6::timestamptz
     )`,
    [operationId, workspaceId, contactId, JSON.stringify(graph), eligibleAt, erasedAt],
  );
  return { graph, operationId };
}

describe("M2-04 e-signature strict-mode database", () => {
  let embedded: EmbeddedTestDatabase;
  let admin: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    embedded = await startEmbeddedPostgres();
    admin = createDrainTrackedPool({ connectionString: embedded.superuserUrl, max: 4 });
    await bootstrapStrictRoles(admin);
    await installPgBoss(serviceUrl(embedded, "app_worker", WORKER_PASSWORD));
    const ownerPool = createDrainTrackedPool({
      connectionString: serviceUrl(embedded, "app_migrator", MIGRATOR_PASSWORD),
      options: "-c role=app_owner",
      max: 1,
    });
    await migrate(drizzle(ownerPool), { migrationsFolder: "./drizzle" });
    const owner = await ownerPool.connect();
    try {
      await applyDefaultPrivilegeContract(owner);
      await applyRoleContract(owner);
      await verifyRoleContract(owner);
    } finally {
      owner.release();
    }
    await endPoolAndWaitForClientRemoval(ownerPool);
    runtimePool = createDrainTrackedPool({
      connectionString: serviceUrl(embedded, "app_runtime", RUNTIME_PASSWORD),
    });
  }, 120_000);

  afterAll(async () => {
    await endPoolsAndStopEmbeddedPostgres(
      [runtimePool, admin],
      embedded,
      "M2-04-E-Signatur-Teardown fehlgeschlagen",
    );
  });

  it("Rollenmanifest lehnt ein partielles F2.8b-Funktionsset fail-closed ab", async () => {
    const ownerPool = createDrainTrackedPool({
      connectionString: serviceUrl(embedded, "app_migrator", MIGRATOR_PASSWORD),
      options: "-c role=app_owner",
      max: 1,
    });
    const owner = await ownerPool.connect();
    try {
      await owner.query("begin");
      await owner.query(`
        alter function public.sign_signature_analog(
          uuid, uuid, timestamptz, text, bytea
        ) rename to sign_signature_analog_f208b_probe
      `);
      await expect(applyRoleContract(owner)).rejects.toThrow(
        /F2\.8b-Signaturakzeptanz.*nur teilweise vorhanden/u,
      );
      await owner.query("rollback");
    } catch (error) {
      await owner.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      owner.release();
      await endPoolAndWaitForClientRemoval(ownerPool);
    }

    const current = await admin.query<{ allowed: boolean }>(`
      select pg_catalog.has_table_privilege(
        'app_runtime', 'public.signature_attestation', 'INSERT'
      ) as allowed
    `);
    expect(current.rows[0]?.allowed).toBe(false);
  });

  it("echter 0075-Rollenprefix bleibt lauffaehig und 0076 schneidet ACLs atomar um", async () => {
    const legacyEmbedded = await startEmbeddedPostgres();
    const legacyAdmin = createDrainTrackedPool({
      connectionString: legacyEmbedded.superuserUrl,
      max: 4,
    });
    const prefix = migrationPrefixThroughF208bPredecessor();
    let ownerPool: Pool | undefined;
    try {
      await bootstrapStrictRoles(legacyAdmin);
      await installPgBoss(serviceUrl(legacyEmbedded, "app_worker", WORKER_PASSWORD));
      ownerPool = createDrainTrackedPool({
        connectionString: serviceUrl(
          legacyEmbedded,
          "app_migrator",
          MIGRATOR_PASSWORD,
        ),
        options: "-c role=app_owner",
        max: 2,
      });

      const owner = await ownerPool.connect();
      try {
        await owner.query("begin");
        await applyDefaultPrivilegeContract(owner);
        await owner.query("commit");
        await migrate(drizzle(ownerPool), { migrationsFolder: prefix });

        await owner.query("begin");
        await applyRoleContract(owner);
        await verifyRoleContract(owner);
        await owner.query("commit");
        const before = await owner.query<{
          directInsert: boolean;
          analogPresent: boolean;
        }>(`
          select
            pg_catalog.has_table_privilege(
              'app_runtime', 'public.signature_attestation', 'INSERT'
            ) as "directInsert",
            pg_catalog.to_regprocedure(
              'public.sign_signature_analog(uuid,uuid,timestamptz,text,bytea)'
            ) is not null as "analogPresent"
        `);
        expect(before.rows[0]).toEqual({
          directInsert: true,
          analogPresent: false,
        });

        await migrate(drizzle(ownerPool), { migrationsFolder: resolve("drizzle") });
        // Absichtlich vor dem Post-Migrations-Rollenmanifest: Bereits der
        // Drizzle-Commit muss Alt-INSERT entziehen und die neue Kapsel oeffnen.
        const cutover = await owner.query<{
          directInsert: boolean;
          analogExecute: boolean;
          publicAnalogExecute: boolean;
        }>(`
          select
            pg_catalog.has_table_privilege(
              'app_runtime', 'public.signature_attestation', 'INSERT'
            ) as "directInsert",
            pg_catalog.has_function_privilege(
              'app_runtime',
              'public.sign_signature_analog(uuid,uuid,timestamptz,text,bytea)',
              'EXECUTE'
            ) as "analogExecute",
            exists (
              select 1
                from pg_catalog.pg_proc as routine
                cross join lateral pg_catalog.aclexplode(
                  coalesce(
                    routine.proacl,
                    pg_catalog.acldefault('f', routine.proowner)
                  )
                ) as privilege
               where routine.oid = pg_catalog.to_regprocedure(
                 'public.sign_signature_analog(uuid,uuid,timestamptz,text,bytea)'
               )
                 and privilege.grantee = 0
                 and privilege.privilege_type = 'EXECUTE'
            ) as "publicAnalogExecute"
        `);
        expect(cutover.rows[0]).toEqual({
          directInsert: false,
          analogExecute: true,
          publicAnalogExecute: false,
        });

        await owner.query("begin");
        await applyDefaultPrivilegeContract(owner);
        await applyRoleContract(owner);
        await verifyRoleContract(owner);
        await owner.query("commit");
      } catch (error) {
        await owner.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        owner.release();
      }
    } finally {
      await endPoolsAndStopEmbeddedPostgres(
        [...(ownerPool ? [ownerPool] : []), legacyAdmin],
        legacyEmbedded,
        "F2.8b-Rollenprefix-Teardown fehlgeschlagen",
      );
      rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("öffentliche Token-Kapseln signieren/widerrufen/zählen als app_runtime", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);

    const created = await withAuthorizedTenantOn(runtimePool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    expect(created.status).toBe("pending");

    const view = await recordSignatureView(runtimePool, { token: created.token });
    expect(view.status).toBe("pending");
    expect(view.viewCount).toBe(1);

    const signed = await signSignatureByToken(runtimePool, {
      schemaVersion: "signature-request-sign.v1",
      token: created.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    });
    expect(signed.status).toBe("signed");

    const revoked = await revokeSignatureByCustomer(runtimePool, { token: created.token });
    expect(revoked.status).toBe("revoked_by_customer");
    expect(hashSignatureToken(created.token).length).toBe(32);
    const outcome = await runtimeQuery<{
      phase: string;
      outcome: string;
      outcome_revision: number;
      installations: number;
      outcome_events: number;
      signature_events: number;
    }>(runtimePool, workspaceId, ctx.actorId, `select project_record.phase,
      project_record.outcome, project_record.outcome_revision,
      (select count(*)::integer from installation where workspace_id = $1::uuid
        and project_id = $2::uuid) as installations,
      (select count(*)::integer from domain_events where workspace_id = $1::uuid
        and aggregate_id = $2::uuid and event_type = 'project.outcome_won') as outcome_events,
      (select count(*)::integer from domain_events where workspace_id = $1::uuid
        and aggregate_id = $3::uuid and event_type = 'signature.signed') as signature_events
      from project as project_record where project_record.workspace_id = $1::uuid
        and project_record.id = $2::uuid`, [workspaceId, ctx.projectId, ctx.offerId]);
    expect(outcome.rows[0]).toEqual({
      phase: "offer",
      outcome: "won",
      outcome_revision: 1,
      installations: 0,
      outcome_events: 1,
      signature_events: 1,
    });
  });

  it("mehrere offene Links bleiben unabhaengig und weiteres Signieren bumppt Won nicht", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const createRequest = () => withAuthorizedTenantOn(
      runtimePool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    const first = await createRequest();
    await cloneApprovedIssuanceFixture(admin, workspaceId, ctx.offerId);
    const second = await createRequest();
    await cloneApprovedIssuanceFixture(admin, workspaceId, ctx.offerId);
    const sibling = await createRequest();

    await signSignatureByToken(runtimePool, {
      schemaVersion: "signature-request-sign.v1",
      token: first.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    });
    const afterFirst = await runtimeQuery<{
      outcome_revision: number;
      second_status: string;
      sibling_status: string;
    }>(runtimePool, workspaceId, ctx.actorId, `select
      project_record.outcome_revision,
      (select status from signature_request where workspace_id = $1::uuid
        and id = $3::uuid) as second_status,
      (select status from signature_request where workspace_id = $1::uuid
        and id = $4::uuid) as sibling_status
      from project as project_record
      where project_record.workspace_id = $1::uuid and project_record.id = $2::uuid`,
      [workspaceId, ctx.projectId, second.requestId, sibling.requestId]);
    expect(afterFirst.rows[0]).toEqual({
      outcome_revision: 1,
      second_status: "pending",
      sibling_status: "pending",
    });

    await signSignatureByToken(runtimePool, {
      schemaVersion: "signature-request-sign.v1",
      token: second.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    });
    const final = await runtimeQuery<{
      outcome: string;
      outcome_revision: number;
      sibling_status: string;
      attestations: number;
      outcome_events: number;
      signature_events: number;
      first_close_preserved: boolean;
      installations: number;
    }>(runtimePool, workspaceId, ctx.actorId, `select
      project_record.outcome, project_record.outcome_revision,
      (select status from signature_request where workspace_id = $1::uuid
        and id = $5::uuid) as sibling_status,
      (select count(*)::integer from signature_attestation where workspace_id = $1::uuid
        and signature_request_id in ($3::uuid, $4::uuid)) as attestations,
      (select count(*)::integer from domain_events where workspace_id = $1::uuid
        and aggregate_id = $2::uuid and event_type = 'project.outcome_won') as outcome_events,
      (select count(*)::integer from domain_events where workspace_id = $1::uuid
        and aggregate_id = $6::uuid and event_type = 'signature.signed') as signature_events,
      project_record.closed_at = (select signed_at from signature_request
        where workspace_id = $1::uuid and id = $3::uuid) as first_close_preserved,
      (select count(*)::integer from installation where workspace_id = $1::uuid
        and project_id = $2::uuid) as installations
      from project as project_record
      where project_record.workspace_id = $1::uuid and project_record.id = $2::uuid`,
      [
        workspaceId,
        ctx.projectId,
        first.requestId,
        second.requestId,
        sibling.requestId,
        ctx.offerId,
      ]);
    expect(final.rows[0]).toEqual({
      outcome: "won",
      outcome_revision: 1,
      sibling_status: "pending",
      attestations: 2,
      outcome_events: 1,
      signature_events: 2,
      first_close_preserved: true,
      installations: 0,
    });
  });

  it("deferred Terminal-Integrität rollt app_runtime-Signatur ohne Attestierung am COMMIT zurück", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const created = await withAuthorizedTenantOn(
      runtimePool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );

    const client = await runtimePool.connect();
    let commitFailure: unknown;
    try {
      await client.query("begin");
      await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
      await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [ctx.actorId]);
      await client.query(
        `update public.signature_request
            set status = 'signed',
                signer_name = 'Commit-integrity probe',
                signed_variant_id = variant_id,
                signed_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, created.requestId],
      );
      await client.query("commit");
    } catch (error) {
      commitFailure = error;
      await client.query("rollback").catch(() => undefined);
    } finally {
      client.release();
    }

    expect(commitFailure).toMatchObject({
      code: "23514",
      message: "Terminaler Signatur-Request verlangt Attestierung und geschlossenes Projekt",
    });

    const proof = await runtimeQuery<{
      request_status: string;
      attestations: number;
      project_outcome: string;
      project_closed_at: Date | null;
    }>(runtimePool, workspaceId, ctx.actorId, `select
      (select status from public.signature_request
        where workspace_id = $1::uuid and id = $3::uuid) as request_status,
      (select count(*)::integer from public.signature_attestation
        where workspace_id = $1::uuid and signature_request_id = $3::uuid) as attestations,
      project_record.outcome as project_outcome,
      project_record.closed_at as project_closed_at
      from public.project as project_record
      where project_record.workspace_id = $1::uuid and project_record.id = $2::uuid`,
      [workspaceId, ctx.projectId, created.requestId]);
    expect(proof.rows[0]).toEqual({
      request_status: "pending",
      attestations: 0,
      project_outcome: "open",
      project_closed_at: null,
    });
  });

  it("deferred Projekt-Integritaet verhindert einen zyklischen Won-Reopen-Bypass", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const created = await withAuthorizedTenantOn(
      runtimePool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    await signSignatureByToken(runtimePool, {
      schemaVersion: "signature-request-sign.v1",
      token: created.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    });

    const client = await runtimePool.connect();
    let commitFailure: unknown;
    try {
      await client.query("begin");
      await client.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', $2, true)`,
        [workspaceId, ctx.actorId],
      );
      await client.query(`
        update public.project
           set phase = 'request', updated_at = pg_catalog.clock_timestamp()
         where workspace_id = $1::uuid and id = $2::uuid
      `, [workspaceId, ctx.projectId]);
      await client.query(`
        update public.project
           set outcome = 'open', outcome_revision = outcome_revision + 1
         where workspace_id = $1::uuid and id = $2::uuid
      `, [workspaceId, ctx.projectId]);
      await client.query(`
        update public.project
           set outcome = 'won', outcome_revision = outcome_revision + 1
         where workspace_id = $1::uuid and id = $2::uuid
      `, [workspaceId, ctx.projectId]);
      await client.query(`
        update public.project
           set phase = 'offer', updated_at = pg_catalog.clock_timestamp()
         where workspace_id = $1::uuid and id = $2::uuid
      `, [workspaceId, ctx.projectId]);
      await client.query("commit");
    } catch (error) {
      commitFailure = error;
      await client.query("rollback").catch(() => undefined);
    } finally {
      client.release();
    }
    expect(commitFailure).toMatchObject({
      code: "23514",
      message: "Terminale Signatur bindet Projektphase, Outcome und Attestierung",
    });

    const project = await runtimeQuery<{
      phase: string;
      outcome: string;
      outcome_revision: number;
      closed: boolean;
    }>(runtimePool, workspaceId, ctx.actorId, `select phase, outcome,
      outcome_revision, closed_at is not null as closed
      from project where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, ctx.projectId]);
    expect(project.rows[0]).toEqual({
      phase: "offer",
      outcome: "won",
      outcome_revision: 1,
      closed: true,
    });
  });

  it("erlaubt Request→Offer und Signatur weiterhin atomar in derselben Transaktion", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const created = await withAuthorizedTenantOn(
      runtimePool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    await runtimeQuery(
      runtimePool,
      workspaceId,
      ctx.actorId,
      `update public.project
          set phase = 'request', updated_at = pg_catalog.clock_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, ctx.projectId],
    );

    const client = await runtimePool.connect();
    try {
      await client.query("begin");
      await client.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', $2, true)`,
        [workspaceId, ctx.actorId],
      );
      await client.query(`
        update public.project
           set phase = 'offer', updated_at = pg_catalog.clock_timestamp()
         where workspace_id = $1::uuid and id = $2::uuid
      `, [workspaceId, ctx.projectId]);
      const signed = await client.query<JsonResult>(`
        select public.sign_signature_by_token(
          $1::bytea, 'click', null, null
        ) as result
      `, [hashSignatureToken(created.token)]);
      expect(signed.rows[0]?.result.status).toBe("signed");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const proof = await runtimeQuery<{
      phase: string;
      outcome: string;
      outcome_revision: number;
      request_status: string;
      attestations: number;
    }>(runtimePool, workspaceId, ctx.actorId, `select
      project_record.phase, project_record.outcome, project_record.outcome_revision,
      (select status from public.signature_request
        where workspace_id = $1::uuid and id = $3::uuid) as request_status,
      (select count(*)::integer from public.signature_attestation
        where workspace_id = $1::uuid and signature_request_id = $3::uuid) as attestations
      from public.project as project_record
      where project_record.workspace_id = $1::uuid and project_record.id = $2::uuid`,
      [workspaceId, ctx.projectId, created.requestId]);
    expect(proof.rows[0]).toEqual({
      phase: "offer",
      outcome: "won",
      outcome_revision: 1,
      request_status: "signed",
      attestations: 1,
    });
  });

  it.each([
    {
      label: "isolierte Phase→Request-Mutation",
      disableOutcomeGuard: false,
      mutationSql: `update public.project
                       set phase = 'request', updated_at = pg_catalog.clock_timestamp()
                     where workspace_id = $1::uuid and id = $2::uuid`,
    },
    {
      label: "isolierte closed_at-Mutation hinter dem Primaerguard",
      disableOutcomeGuard: true,
      mutationSql: `update public.project
                       set closed_at = closed_at + interval '1 second'
                     where workspace_id = $1::uuid and id = $2::uuid`,
    },
  ])("deferred Projekt-Integritaet blockiert $label am COMMIT", async ({
    disableOutcomeGuard,
    mutationSql,
  }) => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const created = await withAuthorizedTenantOn(
      runtimePool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    await signSignatureByToken(runtimePool, {
      schemaVersion: "signature-request-sign.v1",
      token: created.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    });

    if (disableOutcomeGuard) {
      await admin.query(
        "alter table public.project disable trigger project_outcome_mutation_guard",
      );
    }
    const client = await (disableOutcomeGuard ? admin : runtimePool).connect();
    let commitFailure: unknown;
    try {
      await client.query("begin");
      await client.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', $2, true)`,
        [workspaceId, ctx.actorId],
      );
      // Synthetische Defense-in-depth-Probe: Nur der primaere Outcome-Guard
      // ist fuer die closed_at-Variante umgangen. Der deferred
      // Project-Constraint muss die isolierte Zeitmutation selbst erkennen.
      await client.query(mutationSql, [workspaceId, ctx.projectId]);
      await client.query("commit");
    } catch (error) {
      commitFailure = error;
      await client.query("rollback").catch(() => undefined);
    } finally {
      client.release();
      if (disableOutcomeGuard) {
        await admin.query(
          "alter table public.project enable trigger project_outcome_mutation_guard",
        );
      }
    }
    expect(commitFailure).toMatchObject({
      code: "23514",
      message: "Terminale Signatur bindet Projektphase, Outcome und Attestierung",
    });

    const project = await runtimeQuery<{
      phase: string;
      outcome: string;
      outcome_revision: number;
      closed_at_matches_signed_at: boolean;
    }>(runtimePool, workspaceId, ctx.actorId, `select project_record.phase,
      project_record.outcome, project_record.outcome_revision,
      project_record.closed_at = request_record.signed_at as closed_at_matches_signed_at
      from public.project as project_record
      join public.signature_request as request_record
        on request_record.workspace_id = project_record.workspace_id
       and request_record.project_id = project_record.id
       and request_record.id = $3::uuid
      where project_record.workspace_id = $1::uuid and project_record.id = $2::uuid`,
      [workspaceId, ctx.projectId, created.requestId]);
    expect(project.rows[0]).toEqual({
      phase: "offer",
      outcome: "won",
      outcome_revision: 1,
      closed_at_matches_signed_at: true,
    });
  });

  it("F301 sperrt Varianteninhalt actor-blind auch fuer direkte app_runtime-Writes", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const externalActor = await addMember(admin, workspaceId, "admin", { external_only: true });
    const created = await withAuthorizedTenantOn(
      runtimePool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );

    const directContentWrite = (actorId: string | null, suffix: string) => runtimeQuery(
      runtimePool,
      workspaceId,
      actorId,
      `update public.offer_variant
          set name = name || $3::text, updated_at = pg_catalog.clock_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, ctx.variantId, suffix],
    );
    for (const [actorId, suffix] of [
      [externalActor, " external"],
      [null, " actor-null"],
      ["kein-gueltiger-uuid-actor", " malformed"],
    ] as const) {
      await expect(directContentWrite(actorId, suffix)).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/signaturgebundener Inhalt ist gesperrt/u),
      });
    }

    await signSignatureByToken(runtimePool, {
      schemaVersion: "signature-request-sign.v1",
      token: created.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    });
    await expect(directContentWrite(externalActor, " signed")).rejects.toMatchObject({
      code: "23514",
    });

    await revokeSignatureByCustomer(runtimePool, { token: created.token });
    await expect(directContentWrite(externalActor, " revoked")).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("F301 autorisiert Signature-Create vor Inputs, Reads und Locks", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const externalActor = await addMember(admin, workspaceId, "admin", { external_only: true });
    const editorWithoutCapability = await addMember(admin, workspaceId, "editor", {});
    const foreignWorkspaceId = randomUUID();
    await admin.query(
      "insert into public.workspace (id, name) values ($1::uuid, 'M2-04 fremder Workspace')",
      [foreignWorkspaceId],
    );
    const foreignAdmin = await addMember(admin, foreignWorkspaceId, "admin", {});
    const probes = [
      {
        actorId: externalActor,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 0,
        tokenHash: Buffer.alloc(1),
      },
      {
        actorId: externalActor,
        offerId: randomUUID(),
        variantId: randomUUID(),
        ttlDays: 14,
        tokenHash: randomBytes(32),
      },
      {
        actorId: null,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
        tokenHash: randomBytes(32),
      },
      {
        actorId: editorWithoutCapability,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
        tokenHash: randomBytes(32),
      },
      {
        actorId: foreignAdmin,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
        tokenHash: randomBytes(32),
      },
    ] as const;

    for (const probe of probes) {
      await expect(runtimeQuery(
        runtimePool,
        workspaceId,
        probe.actorId,
        `select public.create_signature_request(
           $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::bytea
         ) as result`,
        [workspaceId, probe.offerId, probe.variantId, probe.ttlDays, probe.tokenHash],
      )).rejects.toMatchObject({
        code: "42501",
        message: "signature_request verlangt internen Editor oder Admin",
      });
    }

    const requests = await admin.query<{ count: number }>(
      "select pg_catalog.count(*)::integer as count from public.signature_request where workspace_id = $1::uuid",
      [workspaceId],
    );
    expect(requests.rows[0]?.count).toBe(0);
  });

  it("Widerruf↔Signatur-Race gewinnt genau einen terminalen Übergang", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const created = await withAuthorizedTenantOn(runtimePool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );

    const withdrawPromise = withAuthorizedTenantOn(runtimePool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      withdrawSignatureRequest(tx, serviceCtx, {
        schemaVersion: "signature-request-withdraw.v1",
        workspaceId,
        requestId: created.requestId,
        reasonCode: "other",
      }),
    );
    const signPromise = signSignatureByToken(runtimePool, {
      schemaVersion: "signature-request-sign.v1",
      token: created.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    });

    const [withdrawResult, signResult] = await Promise.allSettled([withdrawPromise, signPromise]);
    const outcomes = [withdrawResult, signResult].map((r) => (r.status === "fulfilled" ? r.value : r.reason));
    const terminal = outcomes.filter((o) => o?.status === "withdrawn" || o?.status === "signed");
    expect(terminal.length).toBeGreaterThanOrEqual(1);
  });

  it("analoger Update→Attestierungs-Pfad committet atomar und setzt Won", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const created = await withAuthorizedTenantOn(runtimePool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    const pdf = Buffer.from("%PDF-1.7\nanalog-signature-scan\n%%EOF", "latin1");
    const signed = await withAuthorizedTenantOn(runtimePool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      uploadAnalogSignature(tx, serviceCtx, {
        schemaVersion: "signature-request-analog.v1",
        workspaceId,
        requestId: created.requestId,
        mimeType: "application/pdf",
        signingDate: new Date().toISOString(),
        artifactBytes: pdf,
      }),
    );
    expect(signed.status).toBe("signed");
    expect(signed.mode).toBe("analog");
    expect(signed.projectId).toBe(ctx.projectId);
    const accepted = await runtimeQuery<{
      phase: string;
      outcome: string;
      outcome_revision: number;
      installations: number;
      signature_actor: string;
      activity_label: string;
      outcome_events: number;
      signature_events: number;
      request_status: string;
      attestations: number;
      closed_at_matches_signed_at: boolean;
    }>(runtimePool, workspaceId, ctx.actorId, `select project_record.phase,
      project_record.outcome, project_record.outcome_revision,
      (select count(*)::integer from installation where workspace_id = $1::uuid
        and project_id = $2::uuid) as installations,
      (select actor from domain_events where workspace_id = $1::uuid
        and aggregate_id = $3::uuid and event_type = 'signature.signed' limit 1) as signature_actor,
      (select payload->>'activityLabel' from domain_events where workspace_id = $1::uuid
        and aggregate_id = $3::uuid and event_type = 'signature.signed' limit 1) as activity_label,
      (select count(*)::integer from domain_events where workspace_id = $1::uuid
        and aggregate_id = $2::uuid and event_type = 'project.outcome_won') as outcome_events,
      (select count(*)::integer from domain_events where workspace_id = $1::uuid
        and aggregate_id = $3::uuid and event_type = 'signature.signed') as signature_events,
      (select status from signature_request where workspace_id = $1::uuid
        and id = $4::uuid) as request_status,
      (select count(*)::integer from signature_attestation where workspace_id = $1::uuid
        and signature_request_id = $4::uuid) as attestations,
      project_record.closed_at = (select signed_at from signature_request
        where workspace_id = $1::uuid and id = $4::uuid) as closed_at_matches_signed_at
      from project as project_record where project_record.workspace_id = $1::uuid
        and project_record.id = $2::uuid`, [workspaceId, ctx.projectId, ctx.offerId, created.requestId]);
    expect(accepted.rows[0]).toEqual({
      phase: "offer",
      outcome: "won",
      outcome_revision: 1,
      installations: 0,
      signature_actor: ctx.actorId,
      activity_label: "Signature request accepted analogously",
      outcome_events: 1,
      signature_events: 1,
      request_status: "signed",
      attestations: 1,
      closed_at_matches_signed_at: true,
    });
  });

  it.each([
    {
      label: "Lost",
      phase: "offer",
      outcome: "lost",
      outcomeRevision: 1,
      expectedCode: "project_outcome_conflict",
    },
    {
      label: "Cannot-Fulfil",
      phase: "offer",
      outcome: "cannot_fulfill",
      outcomeRevision: 1,
      expectedCode: "project_outcome_conflict",
    },
    {
      label: "Request-Phase",
      phase: "request",
      outcome: "open",
      outcomeRevision: 0,
      expectedCode: "project_outcome_conflict",
    },
    {
      label: "Outcome-Revisionsmaximum",
      phase: "offer",
      outcome: "open",
      outcomeRevision: 2_147_483_647,
      expectedCode: "project_outcome_revision_exhausted",
    },
  ])("$label blockiert die Signatur ohne Teilmutation", async ({
    phase,
    outcome,
    outcomeRevision,
    expectedCode,
  }) => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const created = await withAuthorizedTenantOn(
      runtimePool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );

    // Synthetischer Vorzustand: Der Superuser umgeht nur fuer diese Fixture
    // die Outcome-Trigger. Constraints/FKs bleiben aktiv; der eigentliche
    // Signaturaufruf bleibt app_runtime.
    const fixtureClient = await admin.connect();
    try {
      await fixtureClient.query("begin");
      await fixtureClient.query("set local session_replication_role = replica");
      const lossReasonId = outcome === "lost" ? randomUUID() : null;
      if (lossReasonId) {
        await fixtureClient.query(
          `insert into public.project_loss_reason (
             id, workspace_id, label, position
           ) values ($1::uuid, $2::uuid, 'F2.8b Konfliktprobe', 1)`,
          [lossReasonId, workspaceId],
        );
      }
      await fixtureClient.query(
        `update public.project
            set phase = $3::text,
                outcome = $4::text,
                outcome_revision = $5::integer,
                closed_at = case when $4::text in ('won', 'lost', 'cannot_fulfill')
                  then pg_catalog.clock_timestamp() else null end,
                loss_reason_id = $6::uuid,
                loss_reason_text = null,
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, ctx.projectId, phase, outcome, outcomeRevision, lossReasonId],
      );
      await fixtureClient.query("commit");
    } catch (error) {
      await fixtureClient.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      fixtureClient.release();
    }

    await expect(signSignatureByToken(runtimePool, {
      schemaVersion: "signature-request-sign.v1",
      token: created.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    })).rejects.toMatchObject({
      name: SignatureConflictError.name,
      code: expectedCode,
    });

    const proof = await runtimeQuery<{
      project_phase: string;
      project_outcome: string;
      project_outcome_revision: number;
      request_status: string;
      attestations: number;
      outcome_events: number;
      signature_events: number;
      installations: number;
    }>(runtimePool, workspaceId, ctx.actorId, `select
      project_record.phase as project_phase,
      project_record.outcome as project_outcome,
      project_record.outcome_revision as project_outcome_revision,
      (select status from signature_request where workspace_id = $1::uuid
        and id = $3::uuid) as request_status,
      (select count(*)::integer from signature_attestation where workspace_id = $1::uuid
        and signature_request_id = $3::uuid) as attestations,
      (select count(*)::integer from domain_events where workspace_id = $1::uuid
        and aggregate_id = $2::uuid and event_type = 'project.outcome_won') as outcome_events,
      (select count(*)::integer from domain_events where workspace_id = $1::uuid
        and aggregate_id = $4::uuid and event_type = 'signature.signed') as signature_events,
      (select count(*)::integer from installation where workspace_id = $1::uuid
        and project_id = $2::uuid) as installations
      from public.project as project_record
      where project_record.workspace_id = $1::uuid and project_record.id = $2::uuid`,
      [workspaceId, ctx.projectId, created.requestId, ctx.offerId]);
    expect(proof.rows[0]).toEqual({
      project_phase: phase,
      project_outcome: outcome,
      project_outcome_revision: outcomeRevision,
      request_status: "pending",
      attestations: 0,
      outcome_events: 0,
      signature_events: 0,
      installations: 0,
    });
  });

  it("app_runtime kann Signatur-Evidenz auch mit gefaelschten GUCs nicht schreiben", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const created = await withAuthorizedTenantOn(
      runtimePool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    const fakeAttestationId = randomUUID();
    const payload = {
      source: "signature",
      requestId: created.requestId,
      projectId: ctx.projectId,
      offerId: ctx.offerId,
      variantId: ctx.variantId,
      mode: "click",
      activityLabel: "Signature request accepted by customer",
    };

    await expect(runtimeQuery(
      runtimePool,
      workspaceId,
      ctx.actorId,
      `with forged_context as (
         select pg_catalog.set_config('app.signature_acceptance_request_id', $2::text, true),
                pg_catalog.set_config('app.signature_acceptance_attestation_id', $3::text, true),
                pg_catalog.set_config('app.signature_acceptance_mode', 'click', true),
                pg_catalog.set_config('app.signature_acceptance_actor', 'customer', true),
                pg_catalog.set_config('app.signature_acceptance_backfill', 'false', true)
       )
       insert into public.domain_events (
         workspace_id, aggregate_type, aggregate_id, event_type, actor, payload
       )
       select $1::uuid, 'offer', $4::uuid, 'signature.signed', 'customer', $5::jsonb
         from forged_context`,
      [workspaceId, created.requestId, fakeAttestationId, ctx.offerId, JSON.stringify(payload)],
    )).rejects.toMatchObject({
      code: "23514",
      message: "signature.signed verlangt den Akzeptanz-Trigger",
    });

    const events = await runtimeQuery<{ count: number }>(
      runtimePool,
      workspaceId,
      ctx.actorId,
      `select count(*)::integer as count from public.domain_events
        where workspace_id = $1::uuid and aggregate_id = $2::uuid
          and event_type = 'signature.signed'`,
      [workspaceId, ctx.offerId],
    );
    expect(events.rows[0]?.count).toBe(0);
  });

  it("deferred Terminal-Integrität rollt isolierten erlaubten Attestierungs-DELETE zurück", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const created = await withAuthorizedTenantOn(
      runtimePool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    const signed = await signSignatureByToken(runtimePool, {
      schemaVersion: "signature-request-sign.v1",
      token: created.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    });
    const { graph, operationId } = await createSignatureErasureTombstone(
      admin,
      workspaceId,
      ctx.actorId,
      ctx.contactId,
    );
    expect(graph.signatureAttestationIds).toContain(signed.attestationId);

    const eraseClient = await admin.connect();
    let commitFailure: unknown;
    try {
      await eraseClient.query("begin");
      await eraseClient.query("set local role app_owner");
      await eraseClient.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
      await eraseClient.query("select pg_catalog.set_config('app.actor_id', '', true)");
      await eraseClient.query("select pg_catalog.set_config('app.erasure_operation_id', $1, true)", [operationId]);
      await eraseClient.query(
        `delete from public.signature_attestation
          where workspace_id = $1::uuid and signature_request_id = $2::uuid`,
        [workspaceId, created.requestId],
      );
      await eraseClient.query("commit");
    } catch (error) {
      commitFailure = error;
      await eraseClient.query("rollback").catch(() => undefined);
    } finally {
      eraseClient.release();
    }

    expect(commitFailure).toMatchObject({
      code: "23514",
      message: "Terminaler Signatur-Request verlangt Attestierung und geschlossenes Projekt",
    });
    const proof = await adminQuery<{
      request_status: string;
      attestations: number;
      project_outcome: string;
      project_closed: boolean;
    }>(admin, workspaceId, null, `select
      (select status from public.signature_request where workspace_id = $1::uuid
        and id = $3::uuid) as request_status,
      (select count(*)::integer from public.signature_attestation where workspace_id = $1::uuid
        and signature_request_id = $3::uuid) as attestations,
      project_record.outcome as project_outcome,
      project_record.closed_at is not null as project_closed
      from public.project as project_record
      where project_record.workspace_id = $1::uuid and project_record.id = $2::uuid`,
      [workspaceId, ctx.projectId, created.requestId]);
    expect(proof.rows[0]).toEqual({
      request_status: "signed",
      attestations: 1,
      project_outcome: "won",
      project_closed: true,
    });
  });

  it("Erasure-Graph + Tombstone-Worm lassen echten Request-CASCADE zu", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(admin, workspaceId);
    const created = await withAuthorizedTenantOn(runtimePool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    await recordSignatureView(runtimePool, { token: created.token });
    const signed = await signSignatureByToken(runtimePool, {
      schemaVersion: "signature-request-sign.v1",
      token: created.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    });

    const { graph, operationId } = await createSignatureErasureTombstone(
      admin,
      workspaceId,
      ctx.actorId,
      ctx.contactId,
    );
    expect(graph.signatureRequestIds).toContain(created.requestId);
    expect(graph.signatureAttestationIds).toContain(signed.attestationId);
    expect(graph.signatureViewLogIds?.length).toBeGreaterThan(0);

    // Request-Erasure ist der echte Wurzelpfad; Attestierung, View-Log und
    // Token-Locator verschwinden ausschließlich über ihre FK-Cascades.
    const sc = await admin.connect();
    try {
      await sc.query("begin");
      await sc.query("set local role app_owner");
      await sc.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
      await sc.query("select pg_catalog.set_config('app.actor_id', '', true)");
      await sc.query("select pg_catalog.set_config('app.erasure_operation_id', $1, true)", [operationId]);
      await sc.query(
        `delete from public.signature_request
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, created.requestId],
      );
      await sc.query("commit");
    } catch (error) {
      await sc.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      sc.release();
    }

    const remaining = await admin.query<{
      requests: number;
      attestations: number;
      views: number;
      locators: number;
    }>(`select
      (select count(*)::integer from public.signature_request
        where workspace_id = $1::uuid and id = $2::uuid) as requests,
      (select count(*)::integer from public.signature_attestation
        where workspace_id = $1::uuid and signature_request_id = $2::uuid) as attestations,
      (select count(*)::integer from public.signature_view_log
        where workspace_id = $1::uuid and signature_request_id = $2::uuid) as views,
      (select count(*)::integer from public.signature_token_locator
        where signature_request_id = $2::uuid) as locators`, [workspaceId, created.requestId]);
    expect(remaining.rows[0]).toEqual({
      requests: 0,
      attestations: 0,
      views: 0,
      locators: 0,
    });
  });
});
