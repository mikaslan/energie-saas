import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { SIGNATURE_REQUEST_CREATE_VERSION } from "@/lib/integrations/offers/signature-contract";
import {
  PORTAL_INVITE_CREATE_VERSION,
  hashPortalToken,
} from "@/lib/integrations/portal/portal-contract";
import { createPortalInvite, resolvePortalByToken } from "@/modules/portal";
import { createSignatureRequest } from "@/modules/signatures";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

type JsonResult = QueryResultRow & { result: Record<string, unknown> };

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

// Uebernommen aus tests/db/m204-e-signature-service.test.ts
// (buildApprovedIssuance): Angebot -> PDF-Entwurf -> Profil/Empfaenger ->
// Kandidat -> Issuance -> 2/2 Freigaben. Einziger Unterschied: Labels.
async function buildApprovedIssuance(workspaceId: string): Promise<{
  issuanceId: string;
  offerId: string;
  variantId: string;
  variantRevisionId: string;
  actorId: string;
  projectId: string;
}> {
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into public.workspace (id, name) values (${workspaceId}::uuid, 'F10.2B')
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
  if (!row) throw new Error("F10.2B: PDF-Entwurf fehlt.");

  await tenantQuery(workspaceId, null, `update membership set role = 'admin', capabilities = '{}'::jsonb where workspace_id = $1::uuid and user_id = $2::uuid`, [workspaceId, row.actor_id]);

  const sender = {
    legalName: "F1003 Energie GmbH", tradingName: "F1003", representedBy: "F1003 Vertretung",
    address: { street: "Testweg", houseNumber: "1", postalCode: "10115", city: "Berlin", country: "DE" },
    email: "office@f1003.invalid", phoneE164: "+493000000000", websiteHttpsUrl: "https://f1003.invalid",
    registerCourt: "F1003 Registergericht", registerNumber: "HRB F1003 1", vatId: "DE000000000",
  };
  const legalDocuments = {
    terms: { title: "Bedingungen", plainText: "Synthetische Bedingungen." },
    withdrawalInformation: { title: "Widerruf", plainText: "Synthetische Widerrufsinformation." },
    privacyNotice: { title: "Datenschutz", plainText: "Synthetischer Datenschutzhinweis." },
  };
  await tenantQuery(workspaceId, row.actor_id, `select public.revise_offer_release_profile($1::uuid, 0, 'F1003 Profil', $2::jsonb, $3::jsonb)`, [workspaceId, JSON.stringify(sender), JSON.stringify(legalDocuments)]);
  const profile = await tenantQuery<{ profile_id: string; profile_revision_id: string; profile_revision: number }>(workspaceId, null, `select profile.id as profile_id, revision.id as profile_revision_id, revision.revision as profile_revision from offer_release_profile as profile join offer_release_profile_revision as revision on revision.workspace_id = profile.workspace_id and revision.profile_id = profile.id and revision.revision = profile.current_revision where profile.workspace_id = $1::uuid limit 1`, [workspaceId]);
  await tenantQuery(workspaceId, row.actor_id, `select public.activate_offer_release_profile($1::uuid, $2::uuid, $3::uuid, $4::integer)`, [workspaceId, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision]);

  const billingAddress = { street: "Rechnungsweg", houseNumber: "8a", postalCode: "10999", city: "Berlin", country: "DE" };
  await tenantQuery(workspaceId, row.actor_id, `select public.revise_offer_recipient($1::uuid, $2::uuid, 0, 'F1003 Rechnungsempfaenger', 'F1003 Kundin GmbH', 'rechnung@f1003.invalid', $3::jsonb, true)`, [workspaceId, row.offer_id, JSON.stringify(billingAddress)]);
  const recipient = await tenantQuery<{ recipient_revision_id: string; recipient_revision: number }>(workspaceId, null, `select revision.id as recipient_revision_id, revision.revision as recipient_revision from offer_recipient as recipient join offer_recipient_revision as revision on revision.workspace_id = recipient.workspace_id and revision.recipient_id = recipient.id and revision.revision = recipient.current_revision where recipient.workspace_id = $1::uuid and recipient.offer_id = $2::uuid limit 1`, [workspaceId, row.offer_id]);

  if (row.source_state !== "succeeded") {
    await tenantQuery(workspaceId, null, `update offer_pdf_draft set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`, [workspaceId, row.source_pdf_draft_id]);
    const sourceArtifact = Buffer.from(`%PDF-1.7\n${"f1003-release-source".repeat(8)}\n%%EOF`, "utf8");
    await tenantQuery(workspaceId, null, `update offer_pdf_draft set state = 'succeeded', lease_token = null, lease_expires_at = null, artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea), finished_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $3::uuid and state = 'running'`, [workspaceId, sourceArtifact, row.source_pdf_draft_id]);
  }

  await tenantQuery(workspaceId, row.actor_id, `select public.prepare_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::uuid, $7::uuid, $8::integer, $9::uuid, $10::integer, ((clock_timestamp() at time zone 'Europe/Berlin')::date + 14)::date)`, [workspaceId, row.offer_id, row.variant_id, row.variant_revision, row.source_pdf_draft_id, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision, recipient.rows[0]?.recipient_revision_id, recipient.rows[0]?.recipient_revision]);
  const candidate = await tenantQuery<{ candidate_id: string }>(workspaceId, null, `select id as candidate_id from offer_release_candidate where workspace_id = $1::uuid and offer_id = $2::uuid order by created_at desc, id desc limit 1`, [workspaceId, row.offer_id]);

  await tenantQuery(workspaceId, null, `update offer_release_candidate set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`, [workspaceId, candidate.rows[0]?.candidate_id]);
  const candidateArtifact = Buffer.from(`%PDF-1.7\n${"f1003-release-candidate".repeat(8)}\n%%EOF`, "utf8");
  const artifactVersion = randomUUID();
  await tenantQuery(workspaceId, null, `update offer_release_candidate set state = 'ready_for_approval', lease_token = null, lease_expires_at = null, artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea), artifact_version = $3::uuid, finished_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $4::uuid and state = 'running'`, [workspaceId, candidateArtifact, artifactVersion, candidate.rows[0]?.candidate_id]);
  await tenantQuery(workspaceId, row.actor_id, `select public.approve_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, true, true, true, null)`, [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id, artifactVersion]);

  const prepared = await tenantQuery<JsonResult>(workspaceId, row.actor_id, `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`, [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id]);
  const issuanceId = prepared.rows[0]?.result.issuanceId;
  if (typeof issuanceId !== "string") throw new Error("F10.2B: Reservation fehlt.");
  const lease = randomUUID();
  await tenantQuery(workspaceId, null, `select public.claim_offer_issuance_render($1::uuid, $2::uuid, $3::uuid, 120) as result`, [workspaceId, issuanceId, lease]);
  const artifact = Buffer.from(`%PDF-1.7\n${"f1003-final-issuance".repeat(8)}\n%%EOF`, "utf8");
  await tenantQuery(workspaceId, null, `select public.finalize_offer_issuance_render_success($1::uuid, $2::uuid, $3::uuid, 1, $4::bytea) as result`, [workspaceId, issuanceId, lease, artifact]);

  const secondActor = randomUUID();
  await tenantQuery(workspaceId, null, `insert into public.user_identity (id, email) values ($1::uuid, $2::text)`, [secondActor, `f1003-${secondActor}@example.invalid`]);
  await tenantQuery(workspaceId, null, `insert into public.membership (workspace_id, user_id, role, capabilities) values ($1::uuid, $2::uuid, 'admin', '{}'::jsonb)`, [workspaceId, secondActor]);

  const firstApproval = await tenantQuery<JsonResult>(workspaceId, row.actor_id, `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`, [workspaceId, issuanceId]);
  if (firstApproval.rows[0]?.result.status !== "approved") throw new Error("F10.2B: erste Freigabe fehlt.");
  const secondApproval = await tenantQuery<JsonResult>(workspaceId, secondActor, `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`, [workspaceId, issuanceId]);
  if (secondApproval.rows[0]?.result.status !== "approved") throw new Error("F10.2B: zweite Freigabe fehlt.");

  return {
    issuanceId,
    offerId: row.offer_id,
    variantId: row.variant_id,
    variantRevisionId: row.variant_revision_id,
    actorId: row.actor_id,
    projectId: row.project_id,
  };
}

describe("F10.2 Slice B Signatur-Status (PostgreSQL)", () => {
  it("F1003-DB-01: ohne Request none, pending nach Anlage, signed mit Datum", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);

    const invite = await withAuthorizedTenantOn(
      testPool, ctx.actorId, workspaceId,
      (tx, serviceCtx) => createPortalInvite(tx, serviceCtx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId,
        projectId: ctx.projectId,
        ttlDays: 14,
      }),
    );

    const plain = await resolvePortalByToken(testPool, { token: invite.token });
    expect(plain.documents).toHaveLength(1);
    expect(plain.documents[0]!.signatureStatus).toBe("none");
    expect(plain.documents[0]!.signedAt).toBeNull();

    await withAuthorizedTenantOn(testPool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );

    const pending = await resolvePortalByToken(testPool, { token: invite.token });
    expect(pending.documents[0]!.signatureStatus).toBe("pending");
    expect(pending.documents[0]!.signedAt).toBeNull();

    // Signatur direkt auf Zeilenebene (Service-Pfad ist M2-04-geprüft).
    await tenantQuery(workspaceId, null, `update signature_request set status = 'signed', signer_name = 'F1003 Kundin', signed_variant_id = variant_id, signed_at = '2026-09-03T10:00:00+02:00'::timestamptz where workspace_id = $1::uuid and issuance_id = $2::uuid`, [workspaceId, ctx.issuanceId]);

    const signed = await resolvePortalByToken(testPool, { token: invite.token });
    expect(signed.documents[0]!.signatureStatus).toBe("signed");
    expect(signed.documents[0]!.signedAt).toBe("2026-09-03T08:00:00.000Z");
  });

  it("F1003-DB-02: Roh-JSON enthält nie signer_name/Token/Grund", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    await withAuthorizedTenantOn(testPool, ctx.actorId, workspaceId, (tx, serviceCtx) =>
      createSignatureRequest(tx, serviceCtx, {
        schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
        workspaceId,
        offerId: ctx.offerId,
        variantId: ctx.variantId,
        ttlDays: 14,
      }),
    );
    await tenantQuery(workspaceId, null, `update signature_request set status = 'signed', signer_name = 'F1003 Kundin', signed_variant_id = variant_id, signed_at = clock_timestamp() where workspace_id = $1::uuid and issuance_id = $2::uuid`, [workspaceId, ctx.issuanceId]);

    const invite = await withAuthorizedTenantOn(
      testPool, ctx.actorId, workspaceId,
      (tx, serviceCtx) => createPortalInvite(tx, serviceCtx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId,
        projectId: ctx.projectId,
        ttlDays: 14,
      }),
    );
    // Roh-JSON direkt aus der DEFINER-Funktion (ungeparst): kein
    // signer_name, kein Token(-Hash), kein Widerrufsgrund.
    const tokenHash = hashPortalToken(invite.token);
    if (tokenHash === null) throw new Error("F10.2B: Token-Hash fehlt.");
    const raw = await tenantQuery<{ payload: string }>(
      workspaceId, null,
      `select public.resolve_portal_public_view($1::bytea)::text as payload`,
      [tokenHash],
    );
    const serialized = String(raw.rows[0]?.payload ?? "");
    expect(serialized).toMatch(/"status":\s*"ok"/);
    expect(serialized).not.toMatch(/signer/i);
    expect(serialized).not.toMatch(/token_hash|withdrawal_reason|withdrawn_by/i);
  });
});
