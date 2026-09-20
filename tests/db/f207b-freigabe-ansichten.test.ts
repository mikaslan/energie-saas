/**
 * F2-07b · Freigabe-Ansichten — DB-Anteile (RED, Lane 7).
 *
 * PFLICHT-Spec: docs/spec/F2-07b-freigabe-ansichten.md (alle 5 Ansichten +
 * DTO-Whitelists). Fixture-Muster: tests/db/m203b1-offer-issuance-database.test.ts
 * (Candidate/Issuance/Approval/Withdrawal via versiegelte M2-03b1-RPCs).
 *
 * RED-Prinzip: Jeder Test fordert ZUERST seinen Reader aus
 * `@/modules/offers/release-views` an (Signatur-Vorschlag analog
 * `listOfferIssuances`: `(tx, ctx, { workspaceId, offerId, ... })`).
 * Das Modul existiert nicht → der Import schlägt fehl und die Assertion
 * `toBeTypeOf("function")` belegt den fehlenden Reader (kein Setup-Fehler:
 * sämtliches DB-Setup läuft erst NACH der Reader-Assertion).
 */
import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type { TenantTx } from "@/lib/db/types";
import { withTenantOn } from "@/lib/db/tenant";
import {
  hashOfferReleaseCandidateInput,
  type OfferReleaseCandidateInputV1,
} from "@/lib/integrations/offers/release-contract";
import type { ServiceCtx } from "@/lib/permissions";
import { m203b1Artifact, m203b1CandidateInput } from "../helpers/m203b1-offer-issuance-fixture";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

type JsonResult = QueryResultRow & { result: Record<string, unknown> };

/** RED-Vertragsvorschlag: ein Reader je Ansicht, DTOs strikt PII-frei. */
const READER_MODULE = "@/modules/offers/release-views";
const READER_CHRONIK = "listOfferReleaseChronik";
const READER_LEDGER = "listOfferApprovalLedger";
const READER_WITHDRAWALS = "listOfferIssuanceWithdrawals";
const READER_PRUEFPUNKTE = "listOfferPruefpunkteProtokoll";

type ReaderFn = (tx: TenantTx, ctx: ServiceCtx, key: Record<string, string>) => Promise<unknown[]>;

async function requireReader(testId: string, exportName: string): Promise<ReaderFn> {
  let mod: Record<string, unknown> = {};
  try {
    mod = (await import("@/modules/offers/release-views")) as Record<string, unknown>;
  } catch {
    mod = {};
  }
  const reader = mod[exportName];
  expect(
    reader,
    `RED (${testId}): Reader '${exportName}' fehlt — Modul '${READER_MODULE}' existiert nicht (F2-07b GREEN noch offen).`,
  ).toBeTypeOf("function");
  return reader as ReaderFn;
}

async function tenantQuery<Row extends QueryResultRow = QueryResultRow>(
  workspaceId: string,
  actorId: string | null,
  query: string,
  values: unknown[] = [],
): Promise<QueryResult<Row>> {
  const client = await testPool.connect();
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

function ctxFor(
  role: ServiceCtx["role"],
  workspaceId: string,
  actor: string,
  capabilities: ServiceCtx["capabilities"] = {},
): ServiceCtx {
  return { workspaceId, actor, role, capabilities, featureFlags: {} };
}

const PROFILE_SENDER = {
  legalName: "F207b Testenergie GmbH",
  tradingName: null,
  representedBy: "Mara Muster",
  address: {
    street: "Sonnenallee",
    houseNumber: "17",
    postalCode: "10115",
    city: "Berlin",
    country: "DE",
  },
  email: "office@f207b.invalid",
  phoneE164: "+49301234567",
  websiteHttpsUrl: "https://f207b.invalid",
  registerCourt: "Amtsgericht Berlin",
  registerNumber: "HRB 12345",
  vatId: "DE123456789",
};

const LEGAL_DOCUMENTS = {
  terms: { title: "Bedingungen", plainText: "F207B_PRIVATE_TERMS" },
  withdrawalInformation: { title: "Widerruf", plainText: "F207B_PRIVATE_WITHDRAWAL" },
  privacyNotice: { title: "Datenschutz", plainText: "F207B_PRIVATE_PRIVACY" },
};

const BILLING_ADDRESS = {
  street: "Rechnungsweg",
  houseNumber: "8a",
  postalCode: "10999",
  city: "Berlin",
  country: "DE",
};

type OfferBinding = {
  workspaceId: string;
  offerId: string;
  offerNumber: string;
  projectId: string;
  actorId: string;
};

async function setupOfferBinding(): Promise<OfferBinding> {
  const workspaceId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into public.workspace (id, name)
      values (${workspaceId}::uuid, 'F2-07b Freigabe-Ansichten')
    `);
    const offerFactory = tenantFixtures.offer;
    const pdfFactory = tenantFixtures.offer_pdf_draft;
    if (!offerFactory || !pdfFactory) throw new Error("Offer-Fixture fehlt.");
    await offerFactory(tx, workspaceId);
    await pdfFactory(tx, workspaceId);
  });
  const bindingRows = await tenantQuery<OfferBinding & { offer_id: string }>(
    workspaceId,
    null,
    `select offer_record.id as offer_id, offer_record.offer_number as "offerNumber",
            offer_record.project_id as "projectId", offer_record.created_by as "actorId"
       from public.offer as offer_record
      where offer_record.workspace_id = $1::uuid
      order by offer_record.id
      limit 1`,
    [workspaceId],
  );
  const row = bindingRows.rows[0];
  if (!row) throw new Error("Offer-Bindung fehlt.");
  await tenantQuery(
    workspaceId,
    null,
    `update public.membership
        set role = 'admin', capabilities = '{}'::jsonb
      where workspace_id = $1::uuid and user_id = $2::uuid`,
    [workspaceId, row.actorId],
  );
  return {
    workspaceId,
    offerId: row.offer_id,
    offerNumber: row.offerNumber,
    projectId: row.projectId,
    actorId: row.actorId,
  };
}

type ReleaseSource = {
  profile: Record<string, unknown>;
  activation: Record<string, unknown>;
  recipient: Record<string, unknown>;
  draft: {
    id: string;
    variant_id: string;
    variant_revision_id: string;
    variant_revision: number;
    variant_snapshot_sha256: Buffer;
    input_sha256: Buffer;
  };
};

async function setupReleaseSource(binding: OfferBinding): Promise<ReleaseSource> {
  const { workspaceId, offerId, actorId } = binding;
  const profileRows = await tenantQuery<JsonResult>(
    workspaceId,
    actorId,
    `select public.revise_offer_release_profile(
       $1::uuid, 0, 'F207b Angebotsprofil', $2::jsonb, $3::jsonb
     ) as result`,
    [workspaceId, JSON.stringify(PROFILE_SENDER), JSON.stringify(LEGAL_DOCUMENTS)],
  );
  const profile = profileRows.rows[0]?.result;
  if (profile?.status !== "revised") throw new Error("Profilrevision fehlt.");
  const activationRows = await tenantQuery<JsonResult>(
    workspaceId,
    actorId,
    `select public.activate_offer_release_profile(
       $1::uuid, $2::uuid, $3::uuid, 1
     ) as result`,
    [workspaceId, profile.profileId, profile.profileRevisionId],
  );
  const activation = activationRows.rows[0]?.result;
  if (activation?.status !== "activated") throw new Error("Profilaktivierung fehlt.");
  const recipientRows = await tenantQuery<JsonResult>(
    workspaceId,
    actorId,
    `select public.revise_offer_recipient(
       $1::uuid, $2::uuid, 0, 'Ria Rechnung', 'Testkundin GmbH',
       'ria@f207b.invalid', $3::jsonb, true
     ) as result`,
    [workspaceId, offerId, JSON.stringify(BILLING_ADDRESS)],
  );
  const recipient = recipientRows.rows[0]?.result;
  if (recipient?.status !== "revised") throw new Error("Empfaengerrevision fehlt.");
  const draftRows = await tenantQuery<ReleaseSource["draft"]>(
    workspaceId,
    actorId,
    `select id, variant_id, variant_revision_id, variant_revision,
            variant_snapshot_sha256, input_sha256
       from public.offer_pdf_draft
      where workspace_id = $1::uuid and offer_id = $2::uuid`,
    [workspaceId, offerId],
  );
  const draft = draftRows.rows[0];
  if (!draft) throw new Error("PDF-Quellstand fehlt.");
  const draftLease = randomUUID();
  await tenantQuery(
    workspaceId,
    null,
    `update public.offer_pdf_draft
        set state = 'running', attempt_count = 1, lease_token = $2::uuid,
            lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes',
            started_at = pg_catalog.clock_timestamp(),
            updated_at = pg_catalog.clock_timestamp()
      where workspace_id = $1::uuid and id = $3::uuid`,
    [workspaceId, draftLease, draft.id],
  );
  await tenantQuery(
    workspaceId,
    null,
    `update public.offer_pdf_draft
        set state = 'succeeded', lease_token = null, lease_expires_at = null,
            artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea,
            artifact_sha256 = pg_catalog.sha256($2::bytea),
            artifact_size_bytes = pg_catalog.octet_length($2::bytea),
            finished_at = pg_catalog.clock_timestamp(),
            updated_at = pg_catalog.clock_timestamp()
      where workspace_id = $1::uuid and id = $3::uuid`,
    [workspaceId, m203b1Artifact(0x63).bytes, draft.id],
  );
  return { profile, activation, recipient, draft };
}

async function insertApprovedCandidate(
  binding: OfferBinding,
  source: ReleaseSource,
  taxRateBps: 0 | 1900,
): Promise<{ candidateId: string; approvalId: string }> {
  const { workspaceId, offerId, projectId, offerNumber, actorId } = binding;
  const { profile, activation, recipient, draft } = source;
  const clockRows = await tenantQuery<{
    prepared_at: string;
    document_date: string;
    valid_through: string;
  }>(
    workspaceId,
    null,
    `select public._m203a_offer_release_instant(
              pg_catalog.date_trunc('milliseconds', pg_catalog.statement_timestamp())
            ) as prepared_at,
            (pg_catalog.statement_timestamp() at time zone 'Europe/Berlin')::date::text
              as document_date,
            ((pg_catalog.statement_timestamp() at time zone 'Europe/Berlin')::date
              + 30)::text as valid_through`,
  );
  const clock = clockRows.rows[0];
  if (!clock) throw new Error("DB-Zeit fehlt.");
  const candidateInput = m203b1CandidateInput(taxRateBps) as OfferReleaseCandidateInputV1;
  candidateInput.preparedAt = clock.prepared_at;
  candidateInput.documentDate = clock.document_date;
  candidateInput.validThrough = clock.valid_through;
  candidateInput.offerNumber = offerNumber;
  candidateInput.variant.revision = draft.variant_revision;
  candidateInput.profile.revision = Number(profile.revision);
  const candidateInputSha = Buffer.from(
    hashOfferReleaseCandidateInput(candidateInput),
    "hex",
  );
  const candidateId = randomUUID();
  const candidateApprovalId = randomUUID();
  const candidateArtifactVersion = randomUUID();
  const candidateArtifact = m203b1Artifact(0x64).bytes;
  const candidateArtifactSha = createHash("sha256").update(candidateArtifact).digest();
  const zeroTax = taxRateBps === 0;
  await tenantQuery(
    workspaceId,
    null,
    `insert into public.offer_release_candidate (
       id, workspace_id, project_id, offer_id, offer_number,
       variant_id, variant_revision_id, variant_revision, variant_snapshot_sha256,
       source_pdf_draft_id, source_pdf_draft_state,
       source_pdf_draft_input_sha256, source_pdf_draft_mime_type,
       source_pdf_draft_artifact_sha256, source_pdf_draft_size_bytes,
       profile_id, profile_revision_id, profile_revision,
       profile_snapshot_sha256, profile_activation_id, recipient_id,
       recipient_revision_id, recipient_revision, recipient_snapshot_sha256,
       prepared_at, document_date, valid_through, input_version,
       canonicalization_version, template_version, renderer_recipe_version,
       publication_status, reservation_key, input_snapshot, input_sha256,
       has_zero_tax_treatment, state, attempt_count, next_attempt_at,
       artifact_mime_type, artifact_sha256, artifact_size_bytes,
       artifact_bytes, artifact_version, created_by, created_at, updated_at,
       started_at, finished_at
     )
     select $2::uuid, $1::uuid, $3::uuid, $4::uuid, offer_record.offer_number,
            $5::uuid, $6::uuid, $7::integer, $8::bytea,
            draft.id, 'succeeded', draft.input_sha256, 'application/pdf',
            draft.artifact_sha256, draft.artifact_size_bytes,
            $9::uuid, $10::uuid, $11::integer, $12::bytea, $13::uuid,
            $14::uuid, $15::uuid, $16::integer, $17::bytea,
            $18::timestamptz, $19::date, $20::date,
            'offer-release-candidate-input.v1', 'offer-jcs.v1',
            'offer-release-candidate-template.v1',
            'offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac',
            'not_issued', $21::bytea, $22::jsonb, $23::bytea, $30::boolean,
            'ready_for_approval', 1, $18::timestamptz,
            'application/pdf', $24::bytea, $25::integer, $26::bytea,
            $27::uuid, $28::uuid, $18::timestamptz, $18::timestamptz,
            $18::timestamptz, $18::timestamptz
       from public.offer as offer_record
       join public.offer_pdf_draft as draft
         on draft.workspace_id = offer_record.workspace_id and draft.id = $29::uuid
      where offer_record.workspace_id = $1::uuid and offer_record.id = $4::uuid`,
    [
      workspaceId, candidateId, projectId, offerId,
      draft.variant_id, draft.variant_revision_id, draft.variant_revision,
      draft.variant_snapshot_sha256, profile.profileId, profile.profileRevisionId,
      profile.revision, Buffer.from(String(profile.snapshotSha256), "hex"),
      activation.activationId, recipient.recipientId, recipient.recipientRevisionId,
      recipient.revision, Buffer.from(String(recipient.snapshotSha256), "hex"),
      clock.prepared_at, clock.document_date, clock.valid_through,
      createHash("sha256").update(candidateId).digest(), JSON.stringify(candidateInput), candidateInputSha,
      candidateArtifactSha, candidateArtifact.length, candidateArtifact,
      candidateArtifactVersion, actorId, draft.id, zeroTax,
    ],
  );
  const candidateApprovalCommand: Record<string, unknown> = {
    schemaVersion: "offer-release-approval-command.v1",
    workspaceId,
    offerId,
    candidateId,
    expectedArtifactVersion: candidateArtifactVersion,
    recipientBillingReviewed: true,
    commercialContentReviewed: true,
    activeProfileReviewed: true,
    notIssuedStatusUnderstood: true,
    ...(zeroTax ? { zeroTaxTreatmentReviewed: true } : {}),
  };
  await tenantQuery(
    workspaceId,
    null,
    `insert into public.offer_release_candidate_approval (
       id, workspace_id, candidate_id, project_id, offer_id,
       variant_id, variant_revision_id, variant_revision, variant_snapshot_sha256,
       source_pdf_draft_id, source_pdf_draft_input_sha256,
       source_pdf_draft_artifact_sha256, profile_activation_id, profile_id,
       profile_revision_id, profile_revision, profile_snapshot_sha256,
       recipient_id, recipient_revision_id, recipient_revision,
       recipient_snapshot_sha256, input_version, canonicalization_version,
       template_version, renderer_recipe_version, input_sha256,
       publication_status, has_zero_tax_treatment, artifact_mime_type,
       artifact_sha256, artifact_size_bytes, artifact_version,
       approval_version, approval_command_version, approval_command,
       recipient_billing_reviewed, commercial_content_reviewed,
       active_profile_reviewed, not_issued_status_understood,
       zero_tax_treatment_reviewed, approved_by, approved_at
     )
     select $3::uuid, candidate.workspace_id, candidate.id,
            candidate.project_id, candidate.offer_id, candidate.variant_id,
            candidate.variant_revision_id, candidate.variant_revision,
            candidate.variant_snapshot_sha256, candidate.source_pdf_draft_id,
            candidate.source_pdf_draft_input_sha256,
            candidate.source_pdf_draft_artifact_sha256,
            candidate.profile_activation_id, candidate.profile_id,
            candidate.profile_revision_id, candidate.profile_revision,
            candidate.profile_snapshot_sha256, candidate.recipient_id,
            candidate.recipient_revision_id, candidate.recipient_revision,
            candidate.recipient_snapshot_sha256, candidate.input_version,
            candidate.canonicalization_version, candidate.template_version,
            candidate.renderer_recipe_version, candidate.input_sha256,
            candidate.publication_status, candidate.has_zero_tax_treatment,
            candidate.artifact_mime_type, candidate.artifact_sha256,
            candidate.artifact_size_bytes, candidate.artifact_version,
            'offer-release-candidate-approval.v1',
            'offer-release-approval-command.v1', $4::jsonb,
            true, true, true, true, $6::boolean, $5::uuid,
            pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())
       from public.offer_release_candidate as candidate
      where candidate.workspace_id = $1::uuid and candidate.id = $2::uuid`,
    [
      workspaceId, candidateId, candidateApprovalId,
      JSON.stringify(candidateApprovalCommand), actorId, zeroTax ? true : null,
    ],
  );
  return { candidateId, approvalId: candidateApprovalId };
}

async function prepareAndRenderIssuance(
  binding: OfferBinding,
  candidateId: string,
  fill: number,
): Promise<string> {
  const { workspaceId, offerId } = binding;
  const prepared = await tenantQuery<JsonResult>(
    workspaceId,
    binding.actorId,
    `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`,
    [workspaceId, offerId, candidateId],
  );
  const issuanceId = String(prepared.rows[0]?.result.issuanceId);
  if (!issuanceId || prepared.rows[0]?.result.status !== "prepared") {
    throw new Error("Issuance-Reservation fehlt.");
  }
  const leaseToken = randomUUID();
  const claim = await tenantQuery<JsonResult>(
    workspaceId,
    null,
    `select public.claim_offer_issuance_render(
       $1::uuid, $2::uuid, $3::uuid, 120
     ) as result`,
    [workspaceId, issuanceId, leaseToken],
  );
  if (claim.rows[0]?.result.status !== "claimed") {
    throw new Error("Render-Claim fehlt.");
  }
  const finalized = await tenantQuery<JsonResult>(
    workspaceId,
    null,
    `select public.finalize_offer_issuance_render_success(
       $1::uuid, $2::uuid, $3::uuid, 1, $4::bytea
     ) as result`,
    [workspaceId, issuanceId, leaseToken, m203b1Artifact(fill).bytes],
  );
  if (finalized.rows[0]?.result.status !== "ready_for_approval") {
    throw new Error(`Render-Finalize fehlt: ${JSON.stringify(finalized.rows[0]?.result)}`);
  }
  return issuanceId;
}

async function approveIssuance(
  binding: OfferBinding,
  issuanceId: string,
  actorId: string,
  zeroTax: boolean,
): Promise<Record<string, unknown> | undefined> {
  const rows = await tenantQuery<JsonResult>(
    binding.workspaceId,
    actorId,
    `select public.approve_offer_issuance(
       $1::uuid, $2::uuid, true, true, true, true, $3::boolean
     ) as result`,
    [binding.workspaceId, issuanceId, zeroTax ? true : null],
  );
  return rows.rows[0]?.result;
}

async function addMembership(
  workspaceId: string,
  role: "admin" | "editor" | "viewer",
): Promise<string> {
  const userId = randomUUID();
  await tenantQuery(
    workspaceId,
    null,
    `insert into public.user_identity (id, email)
     values ($1::uuid, $2::text)`,
    [userId, `f207b-${role}-${userId}@example.invalid`],
  );
  await tenantQuery(
    workspaceId,
    null,
    `insert into public.membership (workspace_id, user_id, role, capabilities)
     values ($1::uuid, $2::uuid, $3::text, '{}'::jsonb)`,
    [workspaceId, userId, role],
  );
  return userId;
}

const CHRONIK_EVENT_TYPES = [
  "offer.release_candidate_requested",
  "offer.release_candidate_approved_not_issued",
  "offer.issuance_requested",
  "offer.issuance_first_approval_recorded",
  "offer.issuance_approved_for_archive_not_issued",
  "offer.issuance_withdrawn_before_archive",
] as const;

describe("F2-07b Freigabe-Ansichten (DB)", () => {
  it("F207B-CHRONIK-01: Chronik ist vollständig, sortiert, replay-frei und offer-scharf", async () => {
    const listChronik = await requireReader("F207B-CHRONIK-01", READER_CHRONIK);
    const binding = await setupOfferBinding();
    const { workspaceId, offerId } = binding;
    const foreignOfferId = randomUUID();
    const base = Date.now();
    const shuffled = [...CHRONIK_EVENT_TYPES].reverse();
    for (const [index, eventType] of shuffled.entries()) {
      await tenantQuery(
        workspaceId,
        null,
        `insert into public.domain_events
           (workspace_id, aggregate_type, aggregate_id, event_type,
            actor, payload, occurred_at)
         values ($1::uuid, 'offer', $2::uuid, $3::text,
            'actor-pii-sentinel',
            pg_catalog.jsonb_build_object('offerId', $2::uuid),
            pg_catalog.to_timestamp($4::double precision))`,
        [workspaceId, offerId, eventType, (base + (shuffled.length - 1 - index) * 60_000) / 1000],
      );
    }
    await tenantQuery(
      workspaceId,
      null,
      `insert into public.domain_events
         (workspace_id, aggregate_type, aggregate_id, event_type,
          actor, payload, occurred_at)
       values ($1::uuid, 'offer', $2::uuid,
          'offer.issuance_requested_replayed', 'system', '{}'::jsonb,
          pg_catalog.to_timestamp($3::double precision))`,
      [workspaceId, offerId, (base + 999_999) / 1000],
    );
    await tenantQuery(
      workspaceId,
      null,
      `insert into public.domain_events
         (workspace_id, aggregate_type, aggregate_id, event_type,
          actor, payload, occurred_at)
       values ($1::uuid, 'offer', $2::uuid, 'offer.issuance_requested',
          'system', '{}'::jsonb, pg_catalog.to_timestamp($3::double precision))`,
      [workspaceId, foreignOfferId, (base + 500_000) / 1000],
    );
    const entries = await withTenantOn(testPool, workspaceId, (tx) =>
      listChronik(tx, ctxFor("viewer", workspaceId, binding.actorId), {
        workspaceId,
        offerId,
      }),
    );
    expect(entries).toHaveLength(6);
    const rows = entries as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.eventType)).toEqual([...shuffled].reverse());
    const stamps = rows.map((row) => new Date(String(row.occurredAt)).getTime());
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    for (const row of rows) {
      expect(row).not.toHaveProperty("actor");
      expect(row).not.toHaveProperty("payload");
      expect(JSON.stringify(row)).not.toContain("actor-pii-sentinel");
    }
  });

  it("F207B-LEDGER-01: Ordinale 1/2 und 2/2 nach approved_at, id — kein Sprung auf 2/2", async () => {
    const listLedger = await requireReader("F207B-LEDGER-01", READER_LEDGER);
    const binding = await setupOfferBinding();
    const source = await setupReleaseSource(binding);
    const { candidateId } = await insertApprovedCandidate(binding, source, 1900);
    const issuanceId = await prepareAndRenderIssuance(binding, candidateId, 0x65);
    const secondActor = await addMembership(binding.workspaceId, "admin");
    const readLedger = () =>
      withTenantOn(testPool, binding.workspaceId, (tx) =>
        listLedger(tx, ctxFor("viewer", binding.workspaceId, binding.actorId), {
          workspaceId: binding.workspaceId,
          offerId: binding.offerId,
          issuanceId,
        }),
      );
    const first = await approveIssuance(binding, issuanceId, binding.actorId, false);
    expect(first).toMatchObject({ status: "approved", approvalCount: 1 });
    const afterFirst = (await readLedger()) as Array<Record<string, unknown>>;
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ ordinal: 1, total: 2 });
    const replay = await approveIssuance(binding, issuanceId, binding.actorId, false);
    expect(replay).toMatchObject({ approvalCount: 1, replayed: true });
    expect(await readLedger()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await approveIssuance(binding, issuanceId, secondActor, false);
    expect(second).toMatchObject({ status: "approved", approvalCount: 2 });
    const ledger = (await readLedger()) as Array<Record<string, unknown>>;
    expect(ledger).toHaveLength(2);
    expect(ledger.map((row) => row.ordinal)).toEqual([1, 2]);
    expect(ledger.map((row) => row.total)).toEqual([2, 2]);
    expect(String(ledger[0]?.ordinalLabel)).toContain("Erste");
    expect(String(ledger[1]?.ordinalLabel)).toContain("Zweite");
    const firstAt = new Date(String(ledger[0]?.approvedAt)).getTime();
    const secondAt = new Date(String(ledger[1]?.approvedAt)).getTime();
    expect(secondAt).toBeGreaterThanOrEqual(firstAt);
    const stored = await tenantQuery<{ approved_at: string; id: string }>(
      binding.workspaceId,
      null,
      `select approved_at::text as approved_at, id::text as id
         from public.offer_issuance_approval
        where workspace_id = $1::uuid and issuance_id = $2::uuid
        order by approved_at, id`,
      [binding.workspaceId, issuanceId],
    );
    expect(stored.rows).toHaveLength(2);
    expect(new Date(String(ledger[0]?.approvedAt)).getTime()).toBe(
      new Date(stored.rows[0]?.approved_at ?? "").getTime(),
    );
    expect(new Date(String(ledger[1]?.approvedAt)).getTime()).toBe(
      new Date(stored.rows[1]?.approved_at ?? "").getTime(),
    );
    for (const row of ledger) {
      expect(row).not.toHaveProperty("approved_by");
      expect(row).not.toHaveProperty("approvedBy");
      expect(row).not.toHaveProperty("approval_command");
      expect(row).not.toHaveProperty("approvalCommand");
      expect(JSON.stringify(row)).not.toContain(binding.actorId);
      expect(JSON.stringify(row)).not.toContain(secondActor);
    }
  });

  it("F207B-WITHDRAW-01: alle Withdrawals offer-weit mit deutschem Label; Ledger bleibt sichtbar", async () => {
    const listWithdrawals = await requireReader("F207B-WITHDRAW-01", READER_WITHDRAWALS);
    const listLedger = await requireReader("F207B-WITHDRAW-01", READER_LEDGER);
    const binding = await setupOfferBinding();
    const source = await setupReleaseSource(binding);
    const first = await insertApprovedCandidate(binding, source, 1900);
    const issuanceId = await prepareAndRenderIssuance(binding, first.candidateId, 0x65);
    const secondActor = await addMembership(binding.workspaceId, "admin");
    await approveIssuance(binding, issuanceId, binding.actorId, false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await approveIssuance(binding, issuanceId, secondActor, false);
    const withdrawn = await tenantQuery<JsonResult>(
      binding.workspaceId,
      secondActor,
      `select public.withdraw_offer_issuance($1::uuid, $2::uuid, 'content_error')
         as result`,
      [binding.workspaceId, issuanceId],
    );
    expect(withdrawn.rows[0]?.result).toMatchObject({ status: "withdrawn" });
    const other = await insertApprovedCandidate(binding, source, 1900);
    const otherIssuanceId = await prepareAndRenderIssuance(binding, other.candidateId, 0x66);
    const otherWithdrawn = await tenantQuery<JsonResult>(
      binding.workspaceId,
      binding.actorId,
      `select public.withdraw_offer_issuance($1::uuid, $2::uuid, 'recipient_error')
         as result`,
      [binding.workspaceId, otherIssuanceId],
    );
    expect(otherWithdrawn.rows[0]?.result).toMatchObject({ status: "withdrawn" });
    const history = (await withTenantOn(testPool, binding.workspaceId, (tx) =>
      listWithdrawals(tx, ctxFor("editor", binding.workspaceId, binding.actorId), {
        workspaceId: binding.workspaceId,
        offerId: binding.offerId,
      }),
    )) as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    const byCode = new Map(history.map((row) => [row.reasonCode, row]));
    expect(byCode.get("content_error")).toMatchObject({
      issuanceId,
      reasonCode: "content_error",
      reasonLabel: "Inhaltlicher Fehler",
    });
    expect(byCode.get("recipient_error")).toMatchObject({
      issuanceId: otherIssuanceId,
      reasonCode: "recipient_error",
      reasonLabel: "Empfängerfehler",
    });
    const stamps = history.map((row) => new Date(String(row.withdrawnAt)).getTime());
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
    for (const row of history) {
      expect(row).not.toHaveProperty("withdrawn_by");
      expect(row).not.toHaveProperty("withdrawnBy");
      expect(row).not.toHaveProperty("withdrawal_command");
      expect(row).not.toHaveProperty("withdrawalCommand");
    }
    const ledgerAfterWithdraw = await withTenantOn(testPool, binding.workspaceId, (tx) =>
      listLedger(tx, ctxFor("viewer", binding.workspaceId, binding.actorId), {
        workspaceId: binding.workspaceId,
        offerId: binding.offerId,
        issuanceId,
      }),
    );
    expect(ledgerAfterWithdraw).toHaveLength(2);
  });

  it("F207B-PRUEF-01: exakt die gespeicherten Prüfpunkte; 0-%-Punkt nur bei Zero-Tax", async () => {
    const listPruefpunkte = await requireReader("F207B-PRUEF-01", READER_PRUEFPUNKTE);
    const binding = await setupOfferBinding();
    const source = await setupReleaseSource(binding);
    const plain = await insertApprovedCandidate(binding, source, 1900);
    const zeroTax = await insertApprovedCandidate(binding, source, 0);
    const plainIssuance = await prepareAndRenderIssuance(binding, plain.candidateId, 0x65);
    const zeroTaxIssuance = await prepareAndRenderIssuance(binding, zeroTax.candidateId, 0x67);
    const secondActor = await addMembership(binding.workspaceId, "admin");
    await approveIssuance(binding, plainIssuance, binding.actorId, false);
    await approveIssuance(binding, plainIssuance, secondActor, false);
    await approveIssuance(binding, zeroTaxIssuance, binding.actorId, true);
    await approveIssuance(binding, zeroTaxIssuance, secondActor, true);
    const readProtocol = (offerId: string) =>
      withTenantOn(testPool, binding.workspaceId, (tx) =>
        listPruefpunkte(tx, ctxFor("viewer", binding.workspaceId, binding.actorId), {
          workspaceId: binding.workspaceId,
          offerId,
        }),
      );
    const protocol = (await readProtocol(binding.offerId)) as Array<{
      scope: string;
      scopeId: string;
      hasZeroTaxTreatment: boolean;
      points: Array<{ key: string; label: string; checked: boolean }>;
    }>;
    const byScopeId = new Map(protocol.map((entry) => [`${entry.scope}:${entry.scopeId}`, entry]));
    const plainCandidate = byScopeId.get(`candidate:${plain.candidateId}`);
    const zeroCandidate = byScopeId.get(`candidate:${zeroTax.candidateId}`);
    expect(plainCandidate?.points.filter((point) => point.checked)).toHaveLength(4);
    expect(plainCandidate?.points.some((point) => point.key === "zeroTaxTreatmentReviewed")).toBe(false);
    expect(zeroCandidate?.points.filter((point) => point.checked)).toHaveLength(5);
    expect(
      zeroCandidate?.points.find((point) => point.key === "zeroTaxTreatmentReviewed"),
    ).toMatchObject({ checked: true });
    for (const issuanceId of [plainIssuance, zeroTaxIssuance]) {
      const stored = await tenantQuery<{
        recipient_and_scope_reviewed: boolean;
        commercial_totals_reviewed: boolean;
        legal_profile_reviewed: boolean;
        final_pdf_for_archive_understood: boolean;
        zero_tax_treatment_reviewed: boolean | null;
        has_zero_tax_treatment: boolean;
      }>(
        binding.workspaceId,
        null,
        `select recipient_and_scope_reviewed, commercial_totals_reviewed,
                legal_profile_reviewed, final_pdf_for_archive_understood,
                zero_tax_treatment_reviewed, has_zero_tax_treatment
           from public.offer_issuance_approval
          where workspace_id = $1::uuid and issuance_id = $2::uuid
          order by approved_at, id
          limit 1`,
        [binding.workspaceId, issuanceId],
      );
      const approval = stored.rows[0];
      if (!approval) throw new Error("Freigabe fehlt.");
      const expected: Record<string, boolean | null> = {
        recipientAndScopeReviewed: approval.recipient_and_scope_reviewed,
        commercialTotalsReviewed: approval.commercial_totals_reviewed,
        legalProfileReviewed: approval.legal_profile_reviewed,
        finalPdfForArchiveUnderstood: approval.final_pdf_for_archive_understood,
        zeroTaxTreatmentReviewed: approval.zero_tax_treatment_reviewed,
      };
      const entries = protocol.filter(
        (entry) => entry.scope === "issuance" && entry.scopeId === issuanceId,
      );
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.hasZeroTaxTreatment).toBe(approval.has_zero_tax_treatment);
        for (const point of entry.points) {
          expect(point.checked).toBe(expected[point.key] ?? null);
          expect(point.label.trim().length).toBeGreaterThan(0);
        }
        const keys = entry.points.map((point) => point.key);
        expect(keys).toContain("recipientAndScopeReviewed");
        expect(keys).toContain("commercialTotalsReviewed");
        expect(keys).toContain("legalProfileReviewed");
        expect(keys).toContain("finalPdfForArchiveUnderstood");
        expect(keys.includes("zeroTaxTreatmentReviewed")).toBe(
          approval.has_zero_tax_treatment,
        );
      }
    }
    expect(JSON.stringify(protocol)).not.toContain(binding.actorId);
    expect(JSON.stringify(protocol)).not.toContain(secondActor);
  });

  it("F207B-RBAC-01: Viewer/Editor/Admin lesen; External/Cross-Tenant/external_only blockiert", async () => {
    const listChronik = await requireReader("F207B-RBAC-01", READER_CHRONIK);
    const binding = await setupOfferBinding();
    const { workspaceId, offerId } = binding;
    await tenantQuery(
      workspaceId,
      null,
      `insert into public.domain_events
         (workspace_id, aggregate_type, aggregate_id, event_type,
          actor, payload, occurred_at)
       values ($1::uuid, 'offer', $2::uuid, 'offer.issuance_requested',
          'system', '{}'::jsonb, pg_catalog.clock_timestamp())`,
      [workspaceId, offerId],
    );
    const viewer = await addMembership(workspaceId, "viewer");
    const editor = await addMembership(workspaceId, "editor");
    for (const [role, actor] of [
      ["viewer", viewer],
      ["editor", editor],
      ["admin", binding.actorId],
    ] as const) {
      const entries = await withTenantOn(testPool, workspaceId, (tx) =>
        listChronik(tx, ctxFor(role, workspaceId, actor), { workspaceId, offerId }),
      );
      expect(entries).toHaveLength(1);
    }
    await expect(
      withTenantOn(testPool, workspaceId, (tx) =>
        listChronik(
          tx,
          ctxFor("viewer", workspaceId, viewer, { external_only: true }),
          { workspaceId, offerId },
        ),
      ),
    ).rejects.toThrow();
    const foreignWorkspace = randomUUID();
    await expect(
      withTenantOn(testPool, workspaceId, (tx) =>
        listChronik(tx, ctxFor("admin", foreignWorkspace, binding.actorId), {
          workspaceId,
          offerId,
        }),
      ),
    ).rejects.toThrow();
  });
});
