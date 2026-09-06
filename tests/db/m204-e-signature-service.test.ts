import { randomBytes, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  hashSignatureToken,
  SIGNATURE_REQUEST_CREATE_VERSION,
  SIGNATURE_REQUEST_SIGN_VERSION,
} from "@/lib/integrations/offers/signature-contract";
import {
  OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
  OFFER_VARIANT_REVISE_COMMAND_VERSION,
} from "@/lib/integrations/offers/contract";
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  createSignatureRequest,
  listSignatureRequests,
  revokeSignatureByCustomer,
  SignatureConflictError,
  signSignatureByToken,
  withdrawSignatureRequest,
} from "@/modules/signatures";
import { duplicateOfferVariant, reviseOfferVariant } from "@/modules/offers";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

type JsonResult = QueryResultRow & { result: Record<string, unknown> };

async function waitForBackendLock(observer: PoolClient, backendPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observer.query<{ wait_event_type: string | null }>(`
      select wait_event_type
        from pg_catalog.pg_stat_activity
       where pid = $1
    `, [backendPid]);
    if (state.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("F3.1: paralleler Signatur-Write wartete nicht am kanonischen Lock.");
}

async function tenantQuery<Row extends QueryResultRow = QueryResultRow>(
  workspaceId: string,
  actorId: string | null,
  query: string,
  values: unknown[] = [],
) {
  const client = await testPool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId ?? ""]);
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

async function buildApprovedIssuance(workspaceId: string): Promise<{
  issuanceId: string;
  offerId: string;
  variantId: string;
  actorId: string;
  contactId: string;
}> {
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into public.workspace (id, name) values (${workspaceId}::uuid, 'M2-04')
    `);
    await tenantFixtures.offer?.(tx, workspaceId);
    await tenantFixtures.offer_pdf_draft?.(tx, workspaceId);
  });

  const source = await tenantQuery<{
    source_pdf_draft_id: string;
    source_state: string;
    project_id: string;
    offer_id: string;
    variant_id: string;
    variant_revision_id: string;
    variant_revision: number;
    actor_id: string;
  }>(
    workspaceId,
    null,
    `select draft.id as source_pdf_draft_id,
            draft.state as source_state,
            draft.project_id,
            draft.offer_id,
            draft.variant_id,
            draft.variant_revision_id,
            draft.variant_revision,
            offer_record.created_by as actor_id
       from offer_pdf_draft as draft
       join offer as offer_record
         on offer_record.workspace_id = draft.workspace_id
        and offer_record.id = draft.offer_id
      where draft.workspace_id = $1::uuid
      order by draft.created_at desc, draft.id desc
      limit 1`,
    [workspaceId],
  );
  const row = source.rows[0];
  if (!row) throw new Error("M2-04: PDF-Entwurf fehlt.");

  await tenantQuery(workspaceId, null, `update membership set role = 'admin', capabilities = '{}'::jsonb where workspace_id = $1::uuid and user_id = $2::uuid`, [workspaceId, row.actor_id]);

  const sender = {
    legalName: "M204 Energie GmbH", tradingName: "M204", representedBy: "M204 Vertretung",
    address: { street: "Testweg", houseNumber: "1", postalCode: "10115", city: "Berlin", country: "DE" },
    email: "office@m204.invalid", phoneE164: "+493000000000", websiteHttpsUrl: "https://m204.invalid",
    registerCourt: "M204 Registergericht", registerNumber: "HRB M204 1", vatId: "DE000000000",
  };
  const legalDocuments = {
    terms: { title: "Bedingungen", plainText: "Synthetische Bedingungen." },
    withdrawalInformation: { title: "Widerruf", plainText: "Synthetische Widerrufsinformation." },
    privacyNotice: { title: "Datenschutz", plainText: "Synthetischer Datenschutzhinweis." },
  };
  await tenantQuery(workspaceId, row.actor_id, `select public.revise_offer_release_profile($1::uuid, 0, 'M204 Profil', $2::jsonb, $3::jsonb)`, [workspaceId, JSON.stringify(sender), JSON.stringify(legalDocuments)]);
  const profile = await tenantQuery<{ profile_id: string; profile_revision_id: string; profile_revision: number }>(workspaceId, null, `select profile.id as profile_id, revision.id as profile_revision_id, revision.revision as profile_revision from offer_release_profile as profile join offer_release_profile_revision as revision on revision.workspace_id = profile.workspace_id and revision.profile_id = profile.id and revision.revision = profile.current_revision where profile.workspace_id = $1::uuid limit 1`, [workspaceId]);
  await tenantQuery(workspaceId, row.actor_id, `select public.activate_offer_release_profile($1::uuid, $2::uuid, $3::uuid, $4::integer)`, [workspaceId, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision]);

  const billingAddress = { street: "Rechnungsweg", houseNumber: "8a", postalCode: "10999", city: "Berlin", country: "DE" };
  await tenantQuery(workspaceId, row.actor_id, `select public.revise_offer_recipient($1::uuid, $2::uuid, 0, 'M204 Rechnungsempfaenger', 'M204 Kundin GmbH', 'rechnung@m204.invalid', $3::jsonb, true)`, [workspaceId, row.offer_id, JSON.stringify(billingAddress)]);
  const recipient = await tenantQuery<{ recipient_revision_id: string; recipient_revision: number }>(workspaceId, null, `select revision.id as recipient_revision_id, revision.revision as recipient_revision from offer_recipient as recipient join offer_recipient_revision as revision on revision.workspace_id = recipient.workspace_id and revision.recipient_id = recipient.id and revision.revision = recipient.current_revision where recipient.workspace_id = $1::uuid and recipient.offer_id = $2::uuid limit 1`, [workspaceId, row.offer_id]);

  if (row.source_state !== "succeeded") {
    await tenantQuery(workspaceId, null, `update offer_pdf_draft set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`, [workspaceId, row.source_pdf_draft_id]);
    const sourceArtifact = Buffer.from(`%PDF-1.7\n${"m204-release-source".repeat(8)}\n%%EOF`, "utf8");
    await tenantQuery(workspaceId, null, `update offer_pdf_draft set state = 'succeeded', lease_token = null, lease_expires_at = null, artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea), finished_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $3::uuid and state = 'running'`, [workspaceId, sourceArtifact, row.source_pdf_draft_id]);
  }

  await tenantQuery(workspaceId, row.actor_id, `select public.prepare_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::uuid, $7::uuid, $8::integer, $9::uuid, $10::integer, ((clock_timestamp() at time zone 'Europe/Berlin')::date + 14)::date)`, [workspaceId, row.offer_id, row.variant_id, row.variant_revision, row.source_pdf_draft_id, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision, recipient.rows[0]?.recipient_revision_id, recipient.rows[0]?.recipient_revision]);
  const candidate = await tenantQuery<{ candidate_id: string }>(workspaceId, null, `select id as candidate_id from offer_release_candidate where workspace_id = $1::uuid and offer_id = $2::uuid order by created_at desc, id desc limit 1`, [workspaceId, row.offer_id]);

  await tenantQuery(workspaceId, null, `update offer_release_candidate set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`, [workspaceId, candidate.rows[0]?.candidate_id]);
  const candidateArtifact = Buffer.from(`%PDF-1.7\n${"m204-release-candidate".repeat(8)}\n%%EOF`, "utf8");
  const artifactVersion = randomUUID();
  await tenantQuery(workspaceId, null, `update offer_release_candidate set state = 'ready_for_approval', lease_token = null, lease_expires_at = null, artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea), artifact_version = $3::uuid, finished_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $4::uuid and state = 'running'`, [workspaceId, candidateArtifact, artifactVersion, candidate.rows[0]?.candidate_id]);
  await tenantQuery(workspaceId, row.actor_id, `select public.approve_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, true, true, true, null)`, [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id, artifactVersion]);

  const prepared = await tenantQuery<JsonResult>(workspaceId, row.actor_id, `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`, [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id]);
  const issuanceId = prepared.rows[0]?.result.issuanceId;
  if (typeof issuanceId !== "string") throw new Error("M2-04: Reservation fehlt.");
  const lease = randomUUID();
  await tenantQuery(workspaceId, null, `select public.claim_offer_issuance_render($1::uuid, $2::uuid, $3::uuid, 120) as result`, [workspaceId, issuanceId, lease]);
  const artifact = Buffer.from(`%PDF-1.7\n${"m204-final-issuance".repeat(8)}\n%%EOF`, "utf8");
  await tenantQuery(workspaceId, null, `select public.finalize_offer_issuance_render_success($1::uuid, $2::uuid, $3::uuid, 1, $4::bytea) as result`, [workspaceId, issuanceId, lease, artifact]);

  const secondActor = randomUUID();
  await tenantQuery(workspaceId, null, `insert into public.user_identity (id, email) values ($1::uuid, $2::text)`, [secondActor, `m204-${secondActor}@example.invalid`]);
  await tenantQuery(workspaceId, null, `insert into public.membership (workspace_id, user_id, role, capabilities) values ($1::uuid, $2::uuid, 'admin', '{}'::jsonb)`, [workspaceId, secondActor]);

  const firstApproval = await tenantQuery<JsonResult>(workspaceId, row.actor_id, `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`, [workspaceId, issuanceId]);
  if (firstApproval.rows[0]?.result.status !== "approved") throw new Error("M2-04: erste Freigabe fehlt.");
  const secondApproval = await tenantQuery<JsonResult>(workspaceId, secondActor, `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`, [workspaceId, issuanceId]);
  if (secondApproval.rows[0]?.result.status !== "approved") throw new Error("M2-04: zweite Freigabe fehlt.");

  const contact = await tenantQuery<{ contact_id: string }>(workspaceId, null, `select contact_id from offer where workspace_id = $1::uuid and id = $2::uuid`, [workspaceId, row.offer_id]);
  return {
    issuanceId,
    offerId: row.offer_id,
    variantId: row.variant_id,
    actorId: row.actor_id,
    contactId: contact.rows[0]?.contact_id ?? "",
  };
}

describe("M2-04 e-signature service database", () => {
  it("durchlaeuft die 5-Zustands-Maschine, TTL-Ablauf, Content-Hash-Bindung, View und Widerruf", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    if (!ctx.variantId) throw new Error("M2-04: Variante fehlt.");

    // Erzeugung über den internen Service.
    const created = await withAuthorizedTenantOn(testPool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    expect(created.status).toBe("pending");
    expect(created.token.length).toBeGreaterThan(20);

    // Content-Hash-Bindung: request.content_sha256 = sha256(issuance.artifact_bytes).
    const binding = await tenantQuery<{ content_sha256: Buffer; artifact_sha256: Buffer }>(
      workspaceId,
      ctx.actorId,
      `select request_record.content_sha256, issuance.artifact_sha256
         from signature_request as request_record
         join offer_issuance as issuance
           on issuance.workspace_id = request_record.workspace_id
          and issuance.id = request_record.issuance_id
        where request_record.workspace_id = $1::uuid and request_record.id = $2::uuid`,
      [workspaceId, created.requestId],
    );
    expect(binding.rows[0]?.content_sha256).toEqual(binding.rows[0]?.artifact_sha256);

    // Token-Hash-Roundtrip.
    const originalTokenHash = hashSignatureToken(created.token);
    expect(originalTokenHash.length).toBe(32);
    const replay = await tenantQuery<JsonResult>(
      workspaceId,
      ctx.actorId,
      `select public.create_signature_request(
         $1::uuid, $2::uuid, $3::uuid, 14, $4::bytea
       ) as result`,
      [workspaceId, ctx.offerId, ctx.variantId, originalTokenHash],
    );
    expect(replay.rows[0]?.result).toMatchObject({
      status: "pending",
      requestId: created.requestId,
      offerId: ctx.offerId,
      replayed: true,
    });
    const replayCardinality = await tenantQuery<{
      request_count: number;
      locator_count: number;
    }>(
      workspaceId,
      ctx.actorId,
      `select
         (select count(*)::integer from signature_request
           where workspace_id = $1::uuid and issuance_id = $2::uuid) as request_count,
         (select count(*)::integer from signature_token_locator
           where workspace_id = $1::uuid and signature_request_id = $3::uuid) as locator_count`,
      [workspaceId, ctx.issuanceId, created.requestId],
    );
    expect(replayCardinality.rows[0]).toEqual({ request_count: 1, locator_count: 1 });

    await expect(withAuthorizedTenantOn(
      testPool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    )).rejects.toMatchObject({
      name: SignatureConflictError.name,
      code: "request_already_exists",
    });
    await expect(signSignatureByToken(testPool, {
      schemaVersion: SIGNATURE_REQUEST_SIGN_VERSION,
      token: created.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    })).resolves.toMatchObject({ status: "signed", requestId: created.requestId });
  });

  it("weist terminale Uebergaenge zurueck und widerruft nur aus pending", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const created = await withAuthorizedTenantOn(testPool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    const withdrawn = await withAuthorizedTenantOn(testPool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      withdrawSignatureRequest(tx, serviceCtx, {
        schemaVersion: "signature-request-withdraw.v1",
        workspaceId,
        requestId: created.requestId,
        reasonCode: "other",
      }),
    );
    expect(withdrawn.status).toBe("withdrawn");
  });

  it("verweigert fremde Mandanten und external_only (RLS negativ)", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const created = await withAuthorizedTenantOn(testPool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    const otherWorkspace = randomUUID();
    await withTenantOn(testPool, otherWorkspace, async (tx) => {
      await tx.execute(sql`insert into public.workspace (id, name) values (${otherWorkspace}::uuid, 'fremd')`);
    });
    const foreign = await tenantQuery(
      otherWorkspace,
      ctx.actorId,
      `select id from public.signature_request where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, created.requestId],
    );
    expect(foreign.rows).toEqual([]);
  });

  it("erweitert den Erasure-Graphen und loescht den Signatur-Untergraphen", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const created = await withAuthorizedTenantOn(testPool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    const graph = await tenantQuery<{ graph: { signatureRequestIds?: string[] } }>(
      workspaceId,
      ctx.actorId,
      `select public.build_inactive_lead_erasure_graph($1::uuid, $2::uuid) as graph`,
      [workspaceId, ctx.contactId],
    );
    expect(graph.rows[0]?.graph.signatureRequestIds).toContain(created.requestId);
  });

  it("F301-SIGN-01 sperrt pending-Inhalt atomar und entsperrt nach Withdraw", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const revision = await tenantQuery<{ current_revision: number }>(
      workspaceId,
      null,
      `select current_revision from offer_variant
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, ctx.variantId],
    );
    const currentRevision = revision.rows[0]?.current_revision;
    if (!currentRevision) throw new Error("F3.1: Variantenrevision fehlt.");

    const created = await withAuthorizedTenantOn(
      testPool,
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

    await expect(withAuthorizedTenantOn(
      testPool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => reviseOfferVariant(tx, serviceCtx, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        expectedRevision: currentRevision,
        operations: [{ operation: "set_variant_description", description: "gesperrt" }],
      }),
    )).rejects.toMatchObject({
      name: "OfferBlockedError",
      code: "variant_signature_pending",
    });

    await expect(tenantQuery(
      workspaceId,
      ctx.actorId,
      `update offer_variant set name = 'Direkte Umgehung', updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, ctx.variantId],
    )).rejects.toThrow(/signaturgebundener Inhalt ist gesperrt/u);

    await withAuthorizedTenantOn(
      testPool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => withdrawSignatureRequest(tx, serviceCtx, {
        schemaVersion: "signature-request-withdraw.v1",
        workspaceId,
        requestId: created.requestId,
        reasonCode: "content_error",
      }),
    );
    const revised = await withAuthorizedTenantOn(
      testPool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => reviseOfferVariant(tx, serviceCtx, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        expectedRevision: currentRevision,
        operations: [{ operation: "set_variant_description", description: "nach Withdraw" }],
      }),
    );
    expect(revised.revision).toBe(currentRevision + 1);
  });

  it("F301-SIGN-02 verweigert einen Signaturrequest auf ueberholter Issuance-Revision", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const revision = await tenantQuery<{ current_revision: number }>(
      workspaceId,
      null,
      `select current_revision from offer_variant
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, ctx.variantId],
    );
    const currentRevision = revision.rows[0]?.current_revision;
    if (!currentRevision) throw new Error("F3.1: Variantenrevision fehlt.");
    const existing = await withAuthorizedTenantOn(
      testPool,
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
    const expiryFixture = await testPool.connect();
    try {
      await expiryFixture.query("begin");
      await expiryFixture.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', $2, true)`,
        [workspaceId, ctx.actorId],
      );
      // Nur die Uhrkante wird fuer einen weiterhin gespeicherten pending-
      // Request verschoben. Readmodel und Content-Lock muessen den Ablauf
      // ohne vorherige Statusmaterialisierung selbst ableiten.
      await expiryFixture.query(
        "alter table signature_request disable trigger signature_request_mutation_guard",
      );
      const expired = await expiryFixture.query(
        `update signature_request
            set created_at = pg_catalog.statement_timestamp() - interval '2 seconds',
                expires_at = pg_catalog.statement_timestamp() - interval '1 second'
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, existing.requestId],
      );
      expect(expired.rowCount).toBe(1);
      await expiryFixture.query(
        "alter table signature_request enable trigger signature_request_mutation_guard",
      );
      await expiryFixture.query("commit");
    } catch (error) {
      await expiryFixture.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      expiryFixture.release();
    }
    const expiredRequests = await withAuthorizedTenantOn(
      testPool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => listSignatureRequests(tx, serviceCtx, {
        workspaceId,
        offerId: ctx.offerId,
      }),
    );
    expect(expiredRequests.find((request) => request.requestId === existing.requestId)?.status)
      .toBe("expired");
    await withAuthorizedTenantOn(
      testPool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => reviseOfferVariant(tx, serviceCtx, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        expectedRevision: currentRevision,
        operations: [{ operation: "set_variant_description", description: "neuer als Issuance" }],
      }),
    );

    await expect(withAuthorizedTenantOn(
      testPool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    )).rejects.toMatchObject({
      name: SignatureConflictError.name,
      code: "variant_revision_changed",
    });
  });

  it("F301-SIGN-03 entscheidet Create-vs.-Revision ohne Lock-Zyklus", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const basis = await tenantQuery<{
      project_id: string;
      current_revision: number;
    }>(
      workspaceId,
      null,
      `select offer_record.project_id, variant.current_revision
         from offer as offer_record
         join offer_variant as variant
           on variant.workspace_id = offer_record.workspace_id
          and variant.offer_id = offer_record.id
        where offer_record.workspace_id = $1::uuid
          and offer_record.id = $2::uuid
          and variant.id = $3::uuid`,
      [workspaceId, ctx.offerId, ctx.variantId],
    );
    const row = basis.rows[0];
    if (!row) throw new Error("F3.1: Race-Basis fehlt.");

    const revisionClient = await testPool.connect();
    const signatureClient = await testPool.connect();
    const observer = await testPool.connect();
    let signaturePromise: Promise<{ rows: JsonResult[] }> | undefined;
    try {
      await revisionClient.query("begin");
      await signatureClient.query("begin");
      await revisionClient.query("set local statement_timeout = '8s'");
      await signatureClient.query("set local statement_timeout = '8s'");
      for (const client of [revisionClient, signatureClient]) {
        await client.query(
          `select pg_catalog.set_config('app.workspace_id', $1, true),
                  pg_catalog.set_config('app.actor_id', $2, true)`,
          [workspaceId, ctx.actorId],
        );
      }

      // Der echte Revision-Pfad hat nur den ersten kanonischen Vorlaeufer
      // gesperrt. Create muss am Project warten, bevor es Offer/Variant haelt;
      // andernfalls erzeugt der anschliessende echte Revision-Call den alten
      // Project↔Offer-Zyklus.
      await revisionClient.query(
        `select id from project
          where workspace_id = $1::uuid and id = $2::uuid
          for update`,
        [workspaceId, row.project_id],
      );
      const backend = await signatureClient.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid() as pid",
      );
      const backendPid = backend.rows[0]?.pid;
      if (!backendPid) throw new Error("F3.1: Signature-Backend fehlt.");
      signaturePromise = signatureClient.query<JsonResult>(
        `select public.create_signature_request(
           $1::uuid, $2::uuid, $3::uuid, 14, $4::bytea
         ) as result`,
        [workspaceId, ctx.offerId, ctx.variantId, randomBytes(32)],
      );
      await waitForBackendLock(observer, backendPid);

      const serviceCtx: ServiceCtx = {
        workspaceId,
        actor: ctx.actorId,
        role: "admin",
        capabilities: {},
        featureFlags: {},
      };
      const revised = await reviseOfferVariant(
        drizzle(revisionClient) as unknown as TenantTx,
        serviceCtx,
        {
          schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
          offerId: ctx.offerId,
          variantId: ctx.variantId,
          expectedRevision: row.current_revision,
          operations: [{
            operation: "set_variant_description",
            description: "Revision gewinnt den Create-Race",
          }],
        },
      );
      expect(revised.revision).toBe(row.current_revision + 1);
      await revisionClient.query("commit");

      const signature = await signaturePromise;
      expect(signature.rows[0]?.result).toMatchObject({
        status: "conflict",
        code: "variant_revision_changed",
      });
      await signatureClient.query("commit");
    } catch (error) {
      await revisionClient.query("rollback").catch(() => undefined);
      await signatureClient.query("rollback").catch(() => undefined);
      if (signaturePromise) await signaturePromise.catch(() => undefined);
      throw error;
    } finally {
      observer.release();
      signatureClient.release();
      revisionClient.release();
    }
  });

  it("F301-SIGN-04 haelt auch Direct-INSERT-vs.-Revision deadlockfrei", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const basis = await tenantQuery<{
      project_id: string;
      current_revision: number;
      variant_revision_id: string;
      artifact_sha256: Buffer;
    }>(
      workspaceId,
      null,
      `select offer_record.project_id, variant.current_revision,
              revision.id as variant_revision_id, issuance.artifact_sha256
         from offer as offer_record
         join offer_variant as variant
           on variant.workspace_id = offer_record.workspace_id
          and variant.offer_id = offer_record.id
         join offer_variant_revision as revision
           on revision.workspace_id = variant.workspace_id
          and revision.offer_id = variant.offer_id
          and revision.variant_id = variant.id
          and revision.revision = variant.current_revision
         join offer_issuance as issuance
           on issuance.workspace_id = variant.workspace_id
          and issuance.offer_id = variant.offer_id
          and issuance.variant_id = variant.id
          and issuance.variant_revision_id = revision.id
        where offer_record.workspace_id = $1::uuid
          and offer_record.id = $2::uuid
          and variant.id = $3::uuid
          and issuance.id = $4::uuid`,
      [workspaceId, ctx.offerId, ctx.variantId, ctx.issuanceId],
    );
    const row = basis.rows[0];
    if (!row) throw new Error("F3.1: Direct-Race-Basis fehlt.");

    const revisionClient = await testPool.connect();
    const directClient = await testPool.connect();
    const observer = await testPool.connect();
    let directPromise: Promise<unknown> | undefined;
    try {
      await revisionClient.query("begin");
      await directClient.query("begin");
      await revisionClient.query("set local statement_timeout = '8s'");
      await directClient.query("set local statement_timeout = '8s'");
      for (const client of [revisionClient, directClient]) {
        await client.query(
          `select pg_catalog.set_config('app.workspace_id', $1, true),
                  pg_catalog.set_config('app.actor_id', $2, true)`,
          [workspaceId, ctx.actorId],
        );
      }
      await revisionClient.query(
        `select id from project
          where workspace_id = $1::uuid and id = $2::uuid
          for update`,
        [workspaceId, row.project_id],
      );
      const backend = await directClient.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid() as pid",
      );
      const backendPid = backend.rows[0]?.pid;
      if (!backendPid) throw new Error("F3.1: Direct-Backend fehlt.");
      directPromise = directClient.query(
        `insert into signature_request (
           id, workspace_id, project_id, offer_id, variant_id,
           variant_revision_id, issuance_id, status, token_hash,
           expires_at, content_sha256, created_by
         ) values (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6::uuid, $7::uuid, 'pending', $8::bytea,
           pg_catalog.statement_timestamp() + interval '14 days', $9::bytea,
           $10::uuid
         )`,
        [
          randomUUID(), workspaceId, row.project_id, ctx.offerId, ctx.variantId,
          row.variant_revision_id, ctx.issuanceId, randomBytes(32),
          row.artifact_sha256, ctx.actorId,
        ],
      );
      await waitForBackendLock(observer, backendPid);

      const serviceCtx: ServiceCtx = {
        workspaceId,
        actor: ctx.actorId,
        role: "admin",
        capabilities: {},
        featureFlags: {},
      };
      await expect(reviseOfferVariant(
        drizzle(revisionClient) as unknown as TenantTx,
        serviceCtx,
        {
          schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
          offerId: ctx.offerId,
          variantId: ctx.variantId,
          expectedRevision: row.current_revision,
          operations: [{
            operation: "set_variant_description",
            description: "Revision gewinnt auch Direct-Race",
          }],
        },
      )).resolves.toMatchObject({ revision: row.current_revision + 1 });
      await revisionClient.query("commit");

      await expect(directPromise).rejects.toMatchObject({ code: "23514" });
      await directClient.query("rollback");
    } catch (error) {
      await revisionClient.query("rollback").catch(() => undefined);
      await directClient.query("rollback").catch(() => undefined);
      if (directPromise) await directPromise.catch(() => undefined);
      throw error;
    } finally {
      observer.release();
      directClient.release();
      revisionClient.release();
    }
  });

  it("F301-SIGN-05 haelt Signed/Customer-Revoke immutable, aber revisionslose Bundles schreibbar", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const revision = await tenantQuery<{ current_revision: number }>(
      workspaceId,
      null,
      `select current_revision from offer_variant
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, ctx.variantId],
    );
    const currentRevision = revision.rows[0]?.current_revision;
    if (!currentRevision) throw new Error("F3.1: Variantenrevision fehlt.");
    const created = await withAuthorizedTenantOn(
      testPool,
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
    const signed = await signSignatureByToken(testPool, {
      schemaVersion: SIGNATURE_REQUEST_SIGN_VERSION,
      token: created.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    });
    expect(signed.status).toBe("signed");

    await expect(withAuthorizedTenantOn(
      testPool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => reviseOfferVariant(tx, serviceCtx, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        expectedRevision: currentRevision,
        operations: [{ operation: "set_variant_description", description: "nach Signatur" }],
      }),
    )).rejects.toMatchObject({ name: "OfferBlockedError", code: "variant_signed" });

    await expect(tenantQuery(
      workspaceId,
      ctx.actorId,
      `update offer_variant set name = 'Direkte Signed-Umgehung', updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, ctx.variantId],
    )).rejects.toThrow(/signaturgebundener Inhalt ist gesperrt/u);

    const fork = await withAuthorizedTenantOn(
      testPool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => duplicateOfferVariant(tx, serviceCtx, {
        schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
        offerId: ctx.offerId,
        sourceVariantId: ctx.variantId,
        expectedSourceRevision: currentRevision,
        name: "Bearbeitbarer Fork",
      }),
    );
    expect(fork).toMatchObject({ offerId: ctx.offerId, revision: 1 });

    const paymentOptionId = randomUUID();
    await tenantQuery(
      workspaceId,
      ctx.actorId,
      `insert into payment_option (id, workspace_id, key, label, kind)
       values ($1::uuid, $2::uuid, 'purchase', 'Kauf', 'purchase')`,
      [paymentOptionId, workspaceId],
    );

    const bundleWrite = await tenantQuery<{
      optional_bundles: unknown;
      payment_option_id: string;
      is_primary: boolean;
    }>(
      workspaceId,
      ctx.actorId,
      `update offer_variant
          set optional_bundles = '[{"name":"Service","position":1}]'::jsonb,
              payment_option_id = $3::uuid,
              is_primary = false,
              updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid
        returning optional_bundles, payment_option_id::text, is_primary`,
      [workspaceId, ctx.variantId, paymentOptionId],
    );
    expect(bundleWrite.rows[0]).toEqual({
      optional_bundles: [{ name: "Service", position: 1 }],
      payment_option_id: paymentOptionId,
      is_primary: false,
    });

    const revoked = await revokeSignatureByCustomer(testPool, { token: created.token });
    expect(revoked.status).toBe("revoked_by_customer");
    await expect(withAuthorizedTenantOn(
      testPool,
      ctx.actorId,
      workspaceId,
      (tx, serviceCtx) => reviseOfferVariant(tx, serviceCtx, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        expectedRevision: currentRevision,
        operations: [{ operation: "set_variant_description", description: "nach Kundenwiderruf" }],
      }),
    )).rejects.toMatchObject({
      name: "OfferBlockedError",
      code: "variant_revoked_by_customer",
    });
    await expect(tenantQuery(
      workspaceId,
      ctx.actorId,
      `update offer_variant
          set description = 'Direkte Revoked-Umgehung', updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, ctx.variantId],
    )).rejects.toThrow(/signaturgebundener Inhalt ist gesperrt/u);
  });
});
