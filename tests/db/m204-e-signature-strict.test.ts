import { randomUUID } from "node:crypto";

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
  signSignatureByToken,
  uploadAnalogSignature,
  withdrawSignatureRequest,
} from "@/modules/signatures";
import { startEmbeddedPostgres, type EmbeddedTestDatabase } from "../setup/embedded-postgres";
import { applyRoleContract } from "../../scripts/db-role-contract.mjs";
import {
  CATALOG_IMPORT_CLEANUP_QUEUE_OPTIONS,
  CATALOG_IMPORT_QUEUE_OPTIONS,
  CUSTOMER_NOTIFICATION_QUEUE_OPTIONS,
  OFFER_ISSUANCE_QUEUE_OPTIONS,
  OFFER_PDF_QUEUE_OPTIONS,
  OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS,
} from "../../scripts/pgboss-bootstrap.mjs";
import { tenantFixtures } from "../setup/tenant-fixtures";

const DB = "energie_saas_test";
const MIGRATOR_PASSWORD = "m204_migrator";
const RUNTIME_PASSWORD = "m204_runtime";
const WORKER_PASSWORD = "m204_worker";

type JsonResult = QueryResultRow & { result: Record<string, unknown> };

function serviceUrl(embedded: EmbeddedTestDatabase, role: string, password: string): string {
  const url = new URL(embedded.url);
  url.username = role;
  url.password = password;
  return url.toString();
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
    alter database ${DB} owner to app_owner;
    alter schema public owner to app_owner;
    revoke all on schema public from public;
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

async function buildApprovedIssuance(admin: Pool, workspaceId: string): Promise<{
  issuanceId: string;
  offerId: string;
  variantId: string;
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
    offer_id: string;
    variant_id: string;
    variant_revision_id: string;
    variant_revision: number;
    actor_id: string;
  }>(
    admin,
    workspaceId,
    null,
    `select draft.id as source_pdf_draft_id, draft.state as source_state, draft.offer_id,
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
  return { issuanceId, offerId: row.offer_id, variantId: row.variant_id, actorId: row.actor_id, contactId: contact.rows[0]?.contact_id ?? "" };
}

describe("M2-04 e-signature strict-mode database", () => {
  let embedded: EmbeddedTestDatabase;
  let admin: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    embedded = await startEmbeddedPostgres();
    admin = new Pool({ connectionString: embedded.superuserUrl, max: 4 });
    await bootstrapStrictRoles(admin);
    await installPgBoss(serviceUrl(embedded, "app_worker", WORKER_PASSWORD));
    const ownerPool = new Pool({
      connectionString: serviceUrl(embedded, "app_migrator", MIGRATOR_PASSWORD),
      options: "-c role=app_owner",
      max: 1,
    });
    await migrate(drizzle(ownerPool), { migrationsFolder: "./drizzle" });
    const owner = await ownerPool.connect();
    try {
      await applyRoleContract(owner);
    } finally {
      owner.release();
    }
    await ownerPool.end();
    runtimePool = new Pool({ connectionString: serviceUrl(embedded, "app_runtime", RUNTIME_PASSWORD) });
  }, 120_000);

  afterAll(async () => {
    await runtimePool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await embedded?.stop().catch(() => undefined);
  });

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

  it("analoger Upload signiert einen pending Request", async () => {
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
  });

  it("Erasure-Graph + Tombstone-Worm + Scrub-Pfade (Scope-Reduktion)", async () => {
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

    // (a) Erasure-Graph trägt die Signatur-Keys.
    const graphRow = await adminQuery<{
      graph: {
        signatureRequestIds?: string[];
        signatureAttestationIds?: string[];
        signatureViewLogIds?: string[];
      };
    }>(
      admin,
      workspaceId,
      ctx.actorId,
      `select public.build_inactive_lead_erasure_graph($1::uuid, $2::uuid) as graph`,
      [workspaceId, ctx.contactId],
    );
    const graph = graphRow.rows[0]?.graph;
    expect(graph?.signatureRequestIds).toContain(created.requestId);
    expect(graph?.signatureViewLogIds?.length).toBeGreaterThan(0);

    // (c) Tombstone-Worm akzeptiert die neuen Keys: ein kanonischer
    // Tombstone mit Signatur-Keys wird akzeptiert (Worm validiert allowed_keys
    // + kanonische Sortierung).
    const opId = randomUUID();
    const eligible = new Date(Date.now() - 24 * 3600 * 1000);
    const erased = new Date();
    await admin.query(
      `insert into public.erasure_operation_locator (operation_id, scope_id)
       values ($1::uuid, $2::uuid)`,
      [opId, workspaceId],
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
      [opId, workspaceId, ctx.contactId, JSON.stringify(graph), eligible, erased],
    );

    // (b) Scrub-Pfade der 0044-Erweiterung: die drei DELETE-Statements laufen
    // über die Erasure-Guards (app.erasure_operation_id + Tombstone-Graph).
    const sc = await admin.connect();
    try {
      await sc.query("begin");
      await sc.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
      await sc.query("select pg_catalog.set_config('app.erasure_operation_id', $1, true)", [opId]);
      await sc.query(
        `delete from public.signature_view_log
          where workspace_id = $1::uuid and signature_request_id = $2::uuid`,
        [workspaceId, created.requestId],
      );
      await sc.query(
        `delete from public.signature_attestation
          where workspace_id = $1::uuid and signature_request_id = $2::uuid`,
        [workspaceId, created.requestId],
      );
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

    const remaining = await admin.query<{ count: number }>(
      `select count(*)::integer as count from public.signature_request where workspace_id = $1::uuid`,
      [workspaceId],
    );
    expect(remaining.rows[0]?.count).toBe(0);
  });
});
