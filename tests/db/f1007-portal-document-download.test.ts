import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import {
  OfferIssuanceNotFoundError,
  OfferIssuanceValidationError,
  readPortalDocumentArtifactByToken,
} from "@/modules/offers";
import { createPortalInvite } from "@/modules/portal";
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

// Uebernommen aus tests/db/f1003-portal-signature-status.test.ts
// (buildApprovedIssuance): Angebot -> PDF-Entwurf -> Profil/Empfaenger ->
// Kandidat -> Issuance -> 2/2 Freigaben. Rueckgabe zusaetzlich mit dem
// versiegelten Final-Artefakt (Byte-Vergleich im Download-Test).
async function buildApprovedIssuance(workspaceId: string): Promise<{
  issuanceId: string;
  offerId: string;
  variantId: string;
  variantRevisionId: string;
  actorId: string;
  projectId: string;
  artifact: Buffer;
}> {
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into public.workspace (id, name) values (${workspaceId}::uuid, 'F10.07')
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
  if (!row) throw new Error("F10.07: PDF-Entwurf fehlt.");

  await tenantQuery(workspaceId, null, `update project set phase = 'offer' where workspace_id = $1::uuid and id = $2::uuid`, [workspaceId, row.project_id]);

  await tenantQuery(workspaceId, null, `update membership set role = 'admin', capabilities = '{}'::jsonb where workspace_id = $1::uuid and user_id = $2::uuid`, [workspaceId, row.actor_id]);

  const sender = {
    legalName: "F1007 Energie GmbH", tradingName: "F1007", representedBy: "F1007 Vertretung",
    address: { street: "Testweg", houseNumber: "1", postalCode: "10115", city: "Berlin", country: "DE" },
    email: "office@f1007.invalid", phoneE164: "+493000000000", websiteHttpsUrl: "https://f1007.invalid",
    registerCourt: "F1007 Registergericht", registerNumber: "HRB F1007 1", vatId: "DE000000000",
  };
  const legalDocuments = {
    terms: { title: "Bedingungen", plainText: "Synthetische Bedingungen." },
    withdrawalInformation: { title: "Widerruf", plainText: "Synthetische Widerrufsinformation." },
    privacyNotice: { title: "Datenschutz", plainText: "Synthetischer Datenschutzhinweis." },
  };
  await tenantQuery(workspaceId, row.actor_id, `select public.revise_offer_release_profile($1::uuid, 0, 'F1007 Profil', $2::jsonb, $3::jsonb)`, [workspaceId, JSON.stringify(sender), JSON.stringify(legalDocuments)]);
  const profile = await tenantQuery<{ profile_id: string; profile_revision_id: string; profile_revision: number }>(workspaceId, null, `select profile.id as profile_id, revision.id as profile_revision_id, revision.revision as profile_revision from offer_release_profile as profile join offer_release_profile_revision as revision on revision.workspace_id = profile.workspace_id and revision.profile_id = profile.id and revision.revision = profile.current_revision where profile.workspace_id = $1::uuid limit 1`, [workspaceId]);
  await tenantQuery(workspaceId, row.actor_id, `select public.activate_offer_release_profile($1::uuid, $2::uuid, $3::uuid, $4::integer)`, [workspaceId, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision]);

  const billingAddress = { street: "Rechnungsweg", houseNumber: "8a", postalCode: "10999", city: "Berlin", country: "DE" };
  await tenantQuery(workspaceId, row.actor_id, `select public.revise_offer_recipient($1::uuid, $2::uuid, 0, 'F1007 Rechnungsempfaenger', 'F1007 Kundin GmbH', 'rechnung@f1007.invalid', $3::jsonb, true)`, [workspaceId, row.offer_id, JSON.stringify(billingAddress)]);
  const recipient = await tenantQuery<{ recipient_revision_id: string; recipient_revision: number }>(workspaceId, null, `select revision.id as recipient_revision_id, revision.revision as recipient_revision from offer_recipient as recipient join offer_recipient_revision as revision on revision.workspace_id = recipient.workspace_id and revision.recipient_id = recipient.id and revision.revision = recipient.current_revision where recipient.workspace_id = $1::uuid and recipient.offer_id = $2::uuid limit 1`, [workspaceId, row.offer_id]);

  if (row.source_state !== "succeeded") {
    await tenantQuery(workspaceId, null, `update offer_pdf_draft set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`, [workspaceId, row.source_pdf_draft_id]);
    const sourceArtifact = Buffer.from(`%PDF-1.7\n${"f1007-release-source".repeat(8)}\n%%EOF`, "utf8");
    await tenantQuery(workspaceId, null, `update offer_pdf_draft set state = 'succeeded', lease_token = null, lease_expires_at = null, artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea), finished_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $3::uuid and state = 'running'`, [workspaceId, sourceArtifact, row.source_pdf_draft_id]);
  }

  await tenantQuery(workspaceId, row.actor_id, `select public.prepare_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::uuid, $7::uuid, $8::integer, $9::uuid, $10::integer, ((clock_timestamp() at time zone 'Europe/Berlin')::date + 14)::date)`, [workspaceId, row.offer_id, row.variant_id, row.variant_revision, row.source_pdf_draft_id, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision, recipient.rows[0]?.recipient_revision_id, recipient.rows[0]?.recipient_revision]);
  const candidate = await tenantQuery<{ candidate_id: string }>(workspaceId, null, `select id as candidate_id from offer_release_candidate where workspace_id = $1::uuid and offer_id = $2::uuid order by created_at desc, id desc limit 1`, [workspaceId, row.offer_id]);

  await tenantQuery(workspaceId, null, `update offer_release_candidate set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`, [workspaceId, candidate.rows[0]?.candidate_id]);
  const candidateArtifact = Buffer.from(`%PDF-1.7\n${"f1007-release-candidate".repeat(8)}\n%%EOF`, "utf8");
  const artifactVersion = randomUUID();
  await tenantQuery(workspaceId, null, `update offer_release_candidate set state = 'ready_for_approval', lease_token = null, lease_expires_at = null, artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea), artifact_version = $3::uuid, finished_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $4::uuid and state = 'running'`, [workspaceId, candidateArtifact, artifactVersion, candidate.rows[0]?.candidate_id]);
  await tenantQuery(workspaceId, row.actor_id, `select public.approve_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, true, true, true, null)`, [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id, artifactVersion]);

  const prepared = await tenantQuery<JsonResult>(workspaceId, row.actor_id, `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`, [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id]);
  const issuanceId = prepared.rows[0]?.result.issuanceId;
  if (typeof issuanceId !== "string") throw new Error("F10.07: Reservation fehlt.");
  const lease = randomUUID();
  await tenantQuery(workspaceId, null, `select public.claim_offer_issuance_render($1::uuid, $2::uuid, $3::uuid, 120) as result`, [workspaceId, issuanceId, lease]);
  const artifact = Buffer.from(`%PDF-1.7\n${"f1007-final-issuance".repeat(8)}\n%%EOF`, "utf8");
  const finalized = await tenantQuery<JsonResult>(workspaceId, null, `select public.finalize_offer_issuance_render_success($1::uuid, $2::uuid, $3::uuid, 1, $4::bytea) as result`, [workspaceId, issuanceId, lease, artifact]);
  if (finalized.rows[0]?.result.status !== "ready_for_approval") throw new Error("F10.07: Finalisierung fehlt.");

  const secondActor = randomUUID();
  await tenantQuery(workspaceId, null, `insert into public.user_identity (id, email) values ($1::uuid, $2::text)`, [secondActor, `f1007-${secondActor}@example.invalid`]);
  await tenantQuery(workspaceId, null, `insert into public.membership (workspace_id, user_id, role, capabilities) values ($1::uuid, $2::uuid, 'admin', '{}'::jsonb)`, [workspaceId, secondActor]);

  const firstApproval = await tenantQuery<JsonResult>(workspaceId, row.actor_id, `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`, [workspaceId, issuanceId]);
  if (firstApproval.rows[0]?.result.status !== "approved") throw new Error("F10.07: erste Freigabe fehlt.");
  const secondApproval = await tenantQuery<JsonResult>(workspaceId, secondActor, `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`, [workspaceId, issuanceId]);
  if (secondApproval.rows[0]?.result.status !== "approved") throw new Error("F10.07: zweite Freigabe fehlt.");

  return {
    issuanceId,
    offerId: row.offer_id,
    variantId: row.variant_id,
    variantRevisionId: row.variant_revision_id,
    actorId: row.actor_id,
    projectId: row.project_id,
    artifact,
  };
}

async function inviteToken(workspaceId: string, actorId: string, projectId: string): Promise<string> {
  const invite = await withAuthorizedTenantOn(
    testPool, actorId, workspaceId,
    (tx, serviceCtx) => createPortalInvite(tx, serviceCtx, {
      schemaVersion: PORTAL_INVITE_CREATE_VERSION,
      workspaceId,
      projectId,
      ttlDays: 14,
    }),
  );
  return invite.token;
}

describe("F10-07 Portal-Dokument-Download (PostgreSQL)", () => {
  it("F1007-DB-01: freigegebene Issuance liefert exaktes Final-Artefakt", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const token = await inviteToken(workspaceId, ctx.actorId, ctx.projectId);

    const artifact = await readPortalDocumentArtifactByToken(testPool, {
      token,
      issuanceId: ctx.issuanceId,
    });
    expect(artifact.issuanceId).toBe(ctx.issuanceId);
    expect(artifact.mimeType).toBe("application/pdf");
    expect(artifact.sizeBytes).toBe(ctx.artifact.byteLength);
    expect(artifact.bytes.equals(ctx.artifact)).toBe(true);
    expect(artifact.filename.endsWith("-Ausstellungsfassung.pdf")).toBe(true);
    expect(artifact.filename).toContain(artifact.offerNumber);
  });

  it("F1007-DB-02: Rueckzug und Fremdprojekt bleiben fail-closed (NotFound)", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const token = await inviteToken(workspaceId, ctx.actorId, ctx.projectId);

    await tenantQuery<JsonResult>(workspaceId, ctx.actorId, `select public.withdraw_offer_issuance($1::uuid, $2::uuid, 'content_error') as result`, [workspaceId, ctx.issuanceId]);
    await expect(readPortalDocumentArtifactByToken(testPool, {
      token,
      issuanceId: ctx.issuanceId,
    })).rejects.toBeInstanceOf(OfferIssuanceNotFoundError);

    const foreign = await buildApprovedIssuance(randomUUID());
    await expect(readPortalDocumentArtifactByToken(testPool, {
      token,
      issuanceId: foreign.issuanceId,
    })).rejects.toBeInstanceOf(OfferIssuanceNotFoundError);
  });

  it("F1007-DB-03: toter Token und unbekannte Issuance ohne Orakel (NotFound)", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const token = await inviteToken(workspaceId, ctx.actorId, ctx.projectId);

    await expect(readPortalDocumentArtifactByToken(testPool, {
      token: "toter-token-f1007",
      issuanceId: ctx.issuanceId,
    })).rejects.toBeInstanceOf(OfferIssuanceNotFoundError);
    await expect(readPortalDocumentArtifactByToken(testPool, {
      token,
      issuanceId: randomUUID(),
    })).rejects.toBeInstanceOf(OfferIssuanceNotFoundError);
  });

  it("F1007-DB-04: halbe Freigabe (1/2) ist nicht projiziert (NotFound)", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const token = await inviteToken(workspaceId, ctx.actorId, ctx.projectId);

    // Zustand mitten im Freigabefluss (exakt eine Approval-Zeile):
    // Projektion verlangt 2/2, also NotFound. Guard transaktional
    // ausblenden (Fixture-Muster), danach wiederherstellen.
    const client = await testPool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
      await client.query("alter table offer_issuance_approval disable trigger offer_issuance_approval_mutation_guard");
      await client.query(`delete from offer_issuance_approval where ctid = (select ctid from offer_issuance_approval where workspace_id = $1::uuid and issuance_id = $2::uuid limit 1)`, [workspaceId, ctx.issuanceId]);
      await client.query("alter table offer_issuance_approval enable trigger offer_issuance_approval_mutation_guard");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await expect(readPortalDocumentArtifactByToken(testPool, {
      token,
      issuanceId: ctx.issuanceId,
    })).rejects.toBeInstanceOf(OfferIssuanceNotFoundError);
  });

  it("F1007-DB-05: deformierte Eingaben sind ValidationError", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const token = await inviteToken(workspaceId, ctx.actorId, ctx.projectId);

    await expect(readPortalDocumentArtifactByToken(testPool, {
      token: "",
      issuanceId: ctx.issuanceId,
    })).rejects.toBeInstanceOf(OfferIssuanceValidationError);
    await expect(readPortalDocumentArtifactByToken(testPool, {
      token,
      issuanceId: "keine-uuid",
    })).rejects.toBeInstanceOf(OfferIssuanceValidationError);
  });
});
