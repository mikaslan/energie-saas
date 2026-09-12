// F8-06-Angebot-Import-Seeder (DB- und E2E-gemeinsam, ohne Testrunner-Bindung).
//
// Baut per Tenant-Fixtures + Revise-Service + Stored Procedures einen
// ehrlichen Graphen: Angebot (revidiert) → PDF-Entwurf → Freigabe →
// Issuance → Signatur. Spiegel-Trigger verbieten Hand-Revisionen, darum
// laufen alle Aenderungen ueber den Revise-Service; Anzeige-Artefakte
// (PDF-Bytes) bleiben synthetisch, Siegel und Bindungen sind exakt.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { withTenantOn } from "@/lib/db/tenant";
import { generateSignatureToken } from "@/lib/integrations/offers/signature-contract";
import { tenantFixtures } from "./tenant-fixtures";

export type OfferGraph = {
  offerId: string;
  variantId: string;
  revisionId: string;
  projectId: string;
  contactId: string;
  offerNumber: string;
};

export type SeedScope = {
  workspaceId: string;
  adminId: string;
};

export const TENANT_LINE_NAME = "Freie Tenant-Fixture-Position";

export function assertUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("F8-06: keine UUID.");
  }
  return value;
}

export async function tenantQuery<Row = Record<string, unknown>>(
  pool: Pool,
  workspaceId: string,
  actorId: string | null,
  query: string,
  values: unknown[] = [],
): Promise<{ rows: Row[] }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId ?? ""]);
    const result = await client.query(query, values);
    await client.query("commit");
    return result as { rows: Row[] };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function readSnapshotField(
  pool: Pool,
  workspaceId: string,
  revisionId: string,
  path: string,
): Promise<string> {
  const result = await tenantQuery<{ value: string }>(
    pool, workspaceId, null,
    `select revision_snapshot#>>$2::text[] as value
       from offer_variant_revision
      where workspace_id = $1::uuid and id = $3::uuid`,
    [workspaceId, `{${path}}`, revisionId],
  );
  const value = result.rows[0]?.value;
  if (!value) throw new Error(`F8-06: Snapshot-Pfad ${path} fehlt.`);
  return value;
}

export async function seedOfferFixtures(pool: Pool, scope: SeedScope): Promise<OfferGraph> {
  await withTenantOn(pool, scope.workspaceId, async (tx) => {
    await tenantFixtures.offer?.(tx, scope.workspaceId);
  });
  return readCurrentGraph(pool, scope.workspaceId);
}

export async function seedPdfDraftFixture(pool: Pool, scope: SeedScope): Promise<void> {
  await withTenantOn(pool, scope.workspaceId, async (tx) => {
    await tenantFixtures.offer_pdf_draft?.(tx, scope.workspaceId);
  });
}

export async function readCurrentGraph(pool: Pool, workspaceId: string): Promise<OfferGraph> {
  const graph = await tenantQuery<{
    offer_id: string; variant_id: string; revision_id: string;
    project_id: string; contact_id: string; offer_number: string;
  }>(
    pool, workspaceId, null,
    `select offer_record.id as offer_id, variant.id as variant_id,
            revision.id as revision_id, offer_record.project_id,
            offer_record.contact_id, offer_record.offer_number
       from offer as offer_record
       join offer_variant as variant
         on variant.workspace_id = offer_record.workspace_id
        and variant.offer_id = offer_record.id
       join offer_variant_revision as revision
         on revision.workspace_id = variant.workspace_id
        and revision.variant_id = variant.id
        and revision.revision = variant.current_revision
      where offer_record.workspace_id = $1::uuid
      order by offer_record.created_at desc, offer_record.id desc
      limit 1`,
    [workspaceId],
  );
  const row = graph.rows[0];
  if (!row) throw new Error("F8-06: Offer-Fixture fehlt.");
  return {
    offerId: row.offer_id,
    variantId: row.variant_id,
    revisionId: row.revision_id,
    projectId: row.project_id,
    contactId: row.contact_id,
    offerNumber: row.offer_number,
  };
}

// Freigabe-/Ausstellungs-Kette wie M2-04 (Stored Procedures, ehrliche
// Artefakt-Bytes): Profil + Empfaenger, PDF-Entwurf, Kandidat mit zwei
// Freigaben, Issuance mit zwei Freigaben.
export async function approveIssuanceChain(
  pool: Pool,
  scope: SeedScope,
  graph: OfferGraph,
): Promise<string> {
  const query = <Row = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
    actorId: string | null = null,
  ) => tenantQuery<Row>(pool, scope.workspaceId, actorId, text, values);
  await query(
    `update project set phase = 'offer' where workspace_id = $1::uuid and id = $2::uuid`,
    [scope.workspaceId, graph.projectId]);
  const sender = {
    legalName: "F806 Energie GmbH", tradingName: "F806", representedBy: "F806 Vertretung",
    address: { street: "Testweg", houseNumber: "6", postalCode: "10115", city: "Berlin", country: "DE" },
    email: "office@f806.invalid", phoneE164: "+493000000006", websiteHttpsUrl: "https://f806.invalid",
    registerCourt: "F806 Registergericht", registerNumber: "HRB F806 1", vatId: "DE000000006",
  };
  const legalDocuments = {
    terms: { title: "Bedingungen", plainText: "Synthetische Bedingungen." },
    withdrawalInformation: { title: "Widerruf", plainText: "Synthetische Widerrufsinformation." },
    privacyNotice: { title: "Datenschutz", plainText: "Synthetischer Datenschutzhinweis." },
  };
  await query(
    `select public.revise_offer_release_profile($1::uuid, 0, 'F806 Profil', $2::jsonb, $3::jsonb)`,
    [scope.workspaceId, JSON.stringify(sender), JSON.stringify(legalDocuments)], scope.adminId);
  const profile = await query<{ profile_id: string; profile_revision_id: string; profile_revision: number }>(
    `select profile.id as profile_id, revision.id as profile_revision_id, revision.revision as profile_revision
       from offer_release_profile as profile
       join offer_release_profile_revision as revision
         on revision.workspace_id = profile.workspace_id
        and revision.profile_id = profile.id
        and revision.revision = profile.current_revision
      where profile.workspace_id = $1::uuid limit 1`,
    [scope.workspaceId]);
  await query(
    `select public.activate_offer_release_profile($1::uuid, $2::uuid, $3::uuid, $4::integer)`,
    [scope.workspaceId, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision],
    scope.adminId);
  const billingAddress = { street: "Rechnungsweg", houseNumber: "6a", postalCode: "10999", city: "Berlin", country: "DE" };
  await query(
    `select public.revise_offer_recipient($1::uuid, $2::uuid, 0, 'F806 Rechnungsempfaenger', 'F806 Kundin GmbH', 'rechnung@f806.invalid', $3::jsonb, true)`,
    [scope.workspaceId, graph.offerId, JSON.stringify(billingAddress)], scope.adminId);
  const recipient = await query<{ recipient_revision_id: string; recipient_revision: number }>(
    `select revision.id as recipient_revision_id, revision.revision as recipient_revision
       from offer_recipient as recipient
       join offer_recipient_revision as revision
         on revision.workspace_id = recipient.workspace_id
        and revision.recipient_id = recipient.id
        and revision.revision = recipient.current_revision
      where recipient.workspace_id = $1::uuid and recipient.offer_id = $2::uuid limit 1`,
    [scope.workspaceId, graph.offerId]);
  const draft = await query<{ source_pdf_draft_id: string; source_state: string; variant_revision: number }>(
    `select draft.id as source_pdf_draft_id, draft.state as source_state, draft.variant_revision
       from offer_pdf_draft as draft
      where draft.workspace_id = $1::uuid and draft.offer_id = $2::uuid
      order by draft.created_at desc, draft.id desc limit 1`,
    [scope.workspaceId, graph.offerId]);
  const draftRow = draft.rows[0];
  if (!draftRow) throw new Error("F8-06: PDF-Entwurf fehlt.");
  if (draftRow.source_state !== "succeeded") {
    await query(
      `update offer_pdf_draft set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(),
              lease_expires_at = clock_timestamp() + interval '5 minutes',
              started_at = clock_timestamp(), updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`,
      [scope.workspaceId, draftRow.source_pdf_draft_id]);
    const sourceArtifact = Buffer.from(`%PDF-1.7\n${"f806-release-source".repeat(8)}\n%%EOF`, "utf8");
    await query(
      `update offer_pdf_draft set state = 'succeeded', lease_token = null, lease_expires_at = null,
              artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea,
              artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea),
              finished_at = clock_timestamp(), updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $3::uuid and state = 'running'`,
      [scope.workspaceId, sourceArtifact, draftRow.source_pdf_draft_id]);
  }
  // Gueltigkeitsfenster: 1..60 Tage ab heute (Europe/Berlin).
  const berlinToday = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const validDate = new Date(berlinToday.getTime() + 30 * 24 * 60 * 60 * 1000);
  const validUntil = `${validDate.getFullYear()}-${String(validDate.getMonth() + 1).padStart(2, "0")}-${String(validDate.getDate()).padStart(2, "0")}`;
  const preparedCandidate = await query<{ result: unknown }>(
    `select public.prepare_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::uuid, $7::uuid, $8::integer, $9::uuid, $10::integer, $11::date) as result`,
    [scope.workspaceId, graph.offerId, graph.variantId, draftRow.variant_revision, draftRow.source_pdf_draft_id,
      profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision,
      recipient.rows[0]?.recipient_revision_id, recipient.rows[0]?.recipient_revision, validUntil],
    scope.adminId);
  const preparedStatus = (preparedCandidate.rows[0]?.result as { status?: unknown } | undefined)?.status;
  if (preparedStatus !== "prepared") {
    throw new Error(`F8-06: Kandidat-Prepare scheiterte: ${JSON.stringify(preparedCandidate.rows[0]?.result)}`);
  }
  const candidate = await query<{ candidate_id: string }>(
    `select id as candidate_id from offer_release_candidate
      where workspace_id = $1::uuid and offer_id = $2::uuid
      order by created_at desc, id desc limit 1`,
    [scope.workspaceId, graph.offerId]);
  const candidateId = candidate.rows[0]?.candidate_id;
  if (!candidateId) throw new Error("F8-06: Kandidat fehlt.");
  await query(
    `update offer_release_candidate set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(),
            lease_expires_at = clock_timestamp() + interval '5 minutes',
            started_at = clock_timestamp(), updated_at = clock_timestamp()
      where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`,
    [scope.workspaceId, candidateId]);
  const candidateArtifact = Buffer.from(`%PDF-1.7\n${"f806-release-candidate".repeat(8)}\n%%EOF`, "utf8");
  const artifactVersion = randomUUID();
  await query(
    `update offer_release_candidate set state = 'ready_for_approval', lease_token = null, lease_expires_at = null,
            artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea,
            artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea),
            artifact_version = $3::uuid, finished_at = clock_timestamp(), updated_at = clock_timestamp()
      where workspace_id = $1::uuid and id = $4::uuid and state = 'running'`,
    [scope.workspaceId, candidateArtifact, artifactVersion, candidateId]);
  await query(
    `select public.approve_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, true, true, true, null)`,
    [scope.workspaceId, graph.offerId, candidateId, artifactVersion], scope.adminId);
  const prepared = await query<{ result: { issuanceId?: unknown } }>(
    `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`,
    [scope.workspaceId, graph.offerId, candidateId], scope.adminId);
  const issuanceId = prepared.rows[0]?.result.issuanceId;
  if (typeof issuanceId !== "string") throw new Error("F8-06: Reservation fehlt.");
  await query(
    `select public.claim_offer_issuance_render($1::uuid, $2::uuid, $3::uuid, 120) as result`,
    [scope.workspaceId, issuanceId, randomUUID()]);
  const artifact = Buffer.from(`%PDF-1.7\n${"f806-final-issuance".repeat(8)}\n%%EOF`, "utf8");
  const leaseRow = await query<{ lease: string }>(
    `select lease_token as lease from offer_issuance where workspace_id = $1::uuid and id = $2::uuid`,
    [scope.workspaceId, issuanceId]);
  await query(
    `select public.finalize_offer_issuance_render_success($1::uuid, $2::uuid, $3::uuid, 1, $4::bytea) as result`,
    [scope.workspaceId, issuanceId, leaseRow.rows[0]?.lease, artifact]);
  const secondAdminId = randomUUID();
  await query(
    `insert into public.user_identity (id, email) values ($1::uuid, $2::text)`,
    [secondAdminId, `f806-second-${secondAdminId}@example.invalid`]);
  await query(
    `insert into public.membership (id, workspace_id, user_id, role, capabilities)
      values ('${randomUUID()}'::uuid, $1::uuid, $2::uuid, 'admin', '{}'::jsonb)`,
    [scope.workspaceId, secondAdminId]);
  await query(
    `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`,
    [scope.workspaceId, issuanceId], scope.adminId);
  await query(
    `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`,
    [scope.workspaceId, issuanceId], secondAdminId);
  return issuanceId;
}

export function berlinPlus14(): string {
  const berlinToday = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const due = new Date(berlinToday.getTime() + 14 * 24 * 60 * 60 * 1000);
  return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
}

// Signatur rein prozedural (E2E-sicher, kein Service-Import):
// Request anlegen + per Klick signieren. Audit/Events der Service-Kapsel
// entfallen im Arrange bewusst — sie sind nicht Gegenstand des Imports.
export async function createSignatureRequestDirect(
  pool: Pool,
  scope: SeedScope,
  graph: OfferGraph,
): Promise<{ token: string }> {
  const { token, tokenHash } = generateSignatureToken();
  const created = await tenantQuery<{ result: { status?: unknown; requestId?: unknown } }>(
    pool, scope.workspaceId, scope.adminId,
    `select public.create_signature_request($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::bytea) as result`,
    [scope.workspaceId, graph.offerId, graph.variantId, 14, tokenHash],
  );
  if (created.rows[0]?.result.status !== "pending") {
    throw new Error(`F8-06: Signatur-Request scheiterte: ${JSON.stringify(created.rows[0]?.result)}`);
  }
  return { token };
}

export async function signByTokenDirect(
  pool: Pool,
  scope: SeedScope,
  token: string,
): Promise<void> {
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(Buffer.from(token, "base64url")).digest();
  const signed = await tenantQuery<{ result: { status?: unknown } }>(
    pool, scope.workspaceId, null,
    `select public.sign_signature_by_token($1::bytea, 'click', null, null) as result`,
    [tokenHash],
  );
  if (signed.rows[0]?.result.status !== "signed") {
    throw new Error(`F8-06: Signieren scheiterte: ${JSON.stringify(signed.rows[0]?.result)}`);
  }
}

// Durchgaengiger Arrange ohne Service-Imports: Fixtures → Freigabe →
// Issuance → Signatur. Revision bleibt Tenant-Stand (eine Zeile).
export async function seedSignedGraphDirect(
  pool: Pool,
  scope: SeedScope,
): Promise<{ graph: OfferGraph }> {
  const graph = await seedOfferFixtures(pool, scope);
  await seedPdfDraftFixture(pool, scope);
  await approveIssuanceChain(pool, scope, graph);
  const { token } = await createSignatureRequestDirect(pool, scope, graph);
  await signByTokenDirect(pool, scope, token);
  return { graph };
}
