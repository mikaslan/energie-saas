import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { withTenantOn } from "@/lib/db/tenant";
import {
  hashOfferReleaseCandidateInput,
  type OfferReleaseCandidateInputV1,
} from "@/lib/integrations/offers/release-contract";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";
import { superuserPool } from "../setup/superuser-db";
import { m203b1Artifact, m203b1CandidateInput } from "../helpers/m203b1-offer-issuance-fixture";

type JsonResult = QueryResultRow & { result: Record<string, unknown> };

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

async function waitForBackendLock(backendPid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await superuserPool().query<{ waiting: boolean }>(`
      select pg_catalog.cardinality(pg_catalog.pg_blocking_pids($1)) > 0 as waiting
    `, [backendPid]);
    if (activity.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Erwarteter PostgreSQL-Lock-Wait blieb aus.");
}

const PROFILE_SENDER = {
  legalName: "M203b1 Testenergie GmbH",
  tradingName: null,
  representedBy: "Mara Muster",
  address: {
    street: "Sonnenallee",
    houseNumber: "17",
    postalCode: "10115",
    city: "Berlin",
    country: "DE",
  },
  email: "office@m203b1.invalid",
  phoneE164: "+49301234567",
  websiteHttpsUrl: "https://m203b1.invalid",
  registerCourt: "Amtsgericht Berlin",
  registerNumber: "HRB 12345",
  vatId: "DE123456789",
};

const LEGAL_DOCUMENTS = {
  terms: { title: "Bedingungen", plainText: "M203B1_PRIVATE_TERMS" },
  withdrawalInformation: { title: "Widerruf", plainText: "M203B1_PRIVATE_WITHDRAWAL" },
  privacyNotice: { title: "Datenschutz", plainText: "M203B1_PRIVATE_PRIVACY" },
};

const BILLING_ADDRESS = {
  street: "Rechnungsweg",
  houseNumber: "8a",
  postalCode: "10999",
  city: "Berlin",
  country: "DE",
};

describe("M2-03b1 offer issuance database", () => {
  it("durchlaeuft Reservation, Render-CAS, 2/2-Freigabe und terminalen Rueckzug", async () => {
    const workspaceId = randomUUID();
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into public.workspace (id, name)
        values (${workspaceId}::uuid, 'M2-03b1 DB-Vertrag')
      `);
      const offerFactory = tenantFixtures.offer;
      const pdfFactory = tenantFixtures.offer_pdf_draft;
      if (!offerFactory || !pdfFactory) throw new Error("Offer-Fixture fehlt.");
      await offerFactory(tx, workspaceId);
      await pdfFactory(tx, workspaceId);
    });

    const bindingRows = await tenantQuery<{
      offer_id: string;
      offer_number: string;
      project_id: string;
      actor_id: string;
    }>(
      workspaceId,
      null,
      `select offer_record.id as offer_id,
              offer_record.offer_number,
              offer_record.project_id,
              offer_record.created_by as actor_id
         from public.offer as offer_record
        where offer_record.workspace_id = $1::uuid
        order by offer_record.id
        limit 1`,
      [workspaceId],
    );
    const binding = bindingRows.rows[0];
    if (!binding) throw new Error("Offer-Bindung fehlt.");
    await tenantQuery(
      workspaceId,
      null,
      `update public.membership
          set role = 'admin', capabilities = '{}'::jsonb
        where workspace_id = $1::uuid and user_id = $2::uuid`,
      [workspaceId, binding.actor_id],
    );

    const profileRows = await tenantQuery<JsonResult>(
      workspaceId,
      binding.actor_id,
      `select public.revise_offer_release_profile(
         $1::uuid, 0, 'M203b1 Angebotsprofil', $2::jsonb, $3::jsonb
       ) as result`,
      [workspaceId, JSON.stringify(PROFILE_SENDER), JSON.stringify(LEGAL_DOCUMENTS)],
    );
    const profile = profileRows.rows[0]?.result;
    if (profile?.status !== "revised") throw new Error("Profilrevision fehlt.");
    const activationRows = await tenantQuery<JsonResult>(
      workspaceId,
      binding.actor_id,
      `select public.activate_offer_release_profile(
         $1::uuid, $2::uuid, $3::uuid, 1
       ) as result`,
      [workspaceId, profile.profileId, profile.profileRevisionId],
    );
    const activation = activationRows.rows[0]?.result;
    if (activation?.status !== "activated") throw new Error("Profilaktivierung fehlt.");
    const recipientRows = await tenantQuery<JsonResult>(
      workspaceId,
      binding.actor_id,
      `select public.revise_offer_recipient(
         $1::uuid, $2::uuid, 0, 'Ria Rechnung', 'Testkundin GmbH',
         'ria@m203b1.invalid', $3::jsonb, true
       ) as result`,
      [workspaceId, binding.offer_id, JSON.stringify(BILLING_ADDRESS)],
    );
    const recipient = recipientRows.rows[0]?.result;
    if (recipient?.status !== "revised") throw new Error("Empfaengerrevision fehlt.");

    const draftRows = await tenantQuery<{
      id: string;
      variant_id: string;
      variant_revision_id: string;
      variant_revision: number;
      variant_snapshot_sha256: Buffer;
      input_sha256: Buffer;
    }>(
      workspaceId,
      binding.actor_id,
      `select id, variant_id, variant_revision_id, variant_revision,
              variant_snapshot_sha256, input_sha256
         from public.offer_pdf_draft
        where workspace_id = $1::uuid and offer_id = $2::uuid`,
      [workspaceId, binding.offer_id],
    );
    const draft = draftRows.rows[0];
    if (!draft) throw new Error("PDF-Quellstand fehlt.");
    const draftArtifact = m203b1Artifact(0x63).bytes;
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
      [workspaceId, draftArtifact, draft.id],
    );
    const sealedDraftRows = await tenantQuery<{
      artifact_sha256: Buffer;
      artifact_size_bytes: number;
    }>(
      workspaceId,
      null,
      `select artifact_sha256, artifact_size_bytes
         from public.offer_pdf_draft
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, draft.id],
    );
    const sealedDraft = sealedDraftRows.rows[0];
    if (!sealedDraft) throw new Error("Versiegelter Draft fehlt.");

    const clockRows = await tenantQuery<{
      prepared_at: string;
      document_date: string;
      valid_through: string;
    }>(
      workspaceId,
      null,
      `select public._m203a_offer_release_instant(
                pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())
              ) as prepared_at,
              (pg_catalog.clock_timestamp() at time zone 'Europe/Berlin')::date::text
                as document_date,
              ((pg_catalog.clock_timestamp() at time zone 'Europe/Berlin')::date
                + 30)::text as valid_through`,
    );
    const clock = clockRows.rows[0];
    if (!clock) throw new Error("DB-Zeit fehlt.");
    const candidateInput = m203b1CandidateInput() as OfferReleaseCandidateInputV1;
    candidateInput.preparedAt = clock.prepared_at;
    candidateInput.documentDate = clock.document_date;
    candidateInput.validThrough = clock.valid_through;
    candidateInput.offerNumber = binding.offer_number;
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
              'not_issued', $21::bytea, $22::jsonb, $23::bytea, false,
              'ready_for_approval', 1, $18::timestamptz,
              'application/pdf', $24::bytea, $25::integer, $26::bytea,
              $27::uuid, $28::uuid, $18::timestamptz, $18::timestamptz,
              $18::timestamptz, $18::timestamptz
         from public.offer as offer_record
         join public.offer_pdf_draft as draft
           on draft.workspace_id = offer_record.workspace_id and draft.id = $29::uuid
        where offer_record.workspace_id = $1::uuid and offer_record.id = $4::uuid`,
      [
        workspaceId, candidateId, binding.project_id, binding.offer_id,
        draft.variant_id, draft.variant_revision_id, draft.variant_revision,
        draft.variant_snapshot_sha256, profile.profileId, profile.profileRevisionId,
        profile.revision, Buffer.from(String(profile.snapshotSha256), "hex"),
        activation.activationId, recipient.recipientId, recipient.recipientRevisionId,
        recipient.revision, Buffer.from(String(recipient.snapshotSha256), "hex"),
        clock.prepared_at, clock.document_date, clock.valid_through,
        Buffer.alloc(32, 0x51), JSON.stringify(candidateInput), candidateInputSha,
        candidateArtifactSha, candidateArtifact.length, candidateArtifact,
        candidateArtifactVersion, binding.actor_id, draft.id,
      ],
    );
    const candidateApprovalCommand = {
      schemaVersion: "offer-release-approval-command.v1",
      workspaceId,
      offerId: binding.offer_id,
      candidateId,
      expectedArtifactVersion: candidateArtifactVersion,
      recipientBillingReviewed: true,
      commercialContentReviewed: true,
      activeProfileReviewed: true,
      notIssuedStatusUnderstood: true,
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
              true, true, true, true, null, $5::uuid,
              pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())
         from public.offer_release_candidate as candidate
        where candidate.workspace_id = $1::uuid and candidate.id = $2::uuid`,
      [
        workspaceId, candidateId, candidateApprovalId,
        JSON.stringify(candidateApprovalCommand), binding.actor_id,
      ],
    );

    const raceCandidateId = randomUUID();
    const raceCandidateApprovalId = randomUUID();
    await tenantQuery(
      workspaceId,
      null,
      `insert into public.offer_release_candidate
       select (pg_catalog.jsonb_populate_record(
         null::public.offer_release_candidate,
         pg_catalog.to_jsonb(source_candidate)
           || pg_catalog.jsonb_build_object(
             'id', $3::uuid,
             'reservation_key', pg_catalog.sha256(pg_catalog.convert_to(
               $3::uuid::text, 'UTF8'
             ))
           )
       )).*
         from public.offer_release_candidate as source_candidate
        where source_candidate.workspace_id = $1::uuid
          and source_candidate.id = $2::uuid`,
      [workspaceId, candidateId, raceCandidateId],
    );
    await tenantQuery(
      workspaceId,
      null,
      `insert into public.offer_release_candidate_approval
       select (pg_catalog.jsonb_populate_record(
         null::public.offer_release_candidate_approval,
         pg_catalog.to_jsonb(source_approval)
           || pg_catalog.jsonb_build_object(
             'id', $4::uuid,
             'candidate_id', $3::uuid,
             'approval_command', pg_catalog.jsonb_set(
               source_approval.approval_command,
               '{candidateId}',
               pg_catalog.to_jsonb($3::uuid::text),
               false
             )
           )
       )).*
         from public.offer_release_candidate_approval as source_approval
        where source_approval.workspace_id = $1::uuid
          and source_approval.candidate_id = $2::uuid`,
      [workspaceId, candidateId, raceCandidateId, raceCandidateApprovalId],
    );

    const prepare = () => tenantQuery<JsonResult>(
      workspaceId,
      binding.actor_id,
      `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`,
      [workspaceId, binding.offer_id, candidateId],
    );
    const preparedRace = await Promise.all([prepare(), prepare()]);
    const prepared = preparedRace.map((row) => row.rows[0]?.result);
    expect(prepared.map((row) => row?.replayed).sort()).toEqual([false, true]);
    expect(new Set(prepared.map((row) => row?.issuanceId)).size).toBe(1);
    const reservationIssuanceId = String(prepared[0]?.issuanceId);
    expect(prepared[0]).toMatchObject({
      status: "prepared",
      workspaceId,
      offerId: binding.offer_id,
      candidateId,
      state: "queued",
      approvalCount: 0,
      derivedState: "queued",
    });

    let racedPrepareResult: Record<string, unknown> | undefined;
    const profileWriter = await superuserPool().connect();
    const prepareClient = await testPool.connect();
    let profileDriftCommitted = false;
    try {
      await profileWriter.query("begin");
      await profileWriter.query("set local session_replication_role = replica");
      await profileWriter.query(
        `update public.offer_release_profile
            set current_revision = current_revision + 1,
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, profile.profileId],
      );

      // Ein exakter Replay darf trotz gehaltenem Profile-Head-Lock nicht warten.
      await prepareClient.query("begin");
      await prepareClient.query("set local statement_timeout = '1s'");
      await prepareClient.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', $2, true)`,
        [workspaceId, binding.actor_id],
      );
      const concurrentReplay = await prepareClient.query<JsonResult>(
        `select public.prepare_offer_issuance(
           $1::uuid, $2::uuid, $3::uuid
         ) as result`,
        [workspaceId, binding.offer_id, candidateId],
      );
      expect(concurrentReplay.rows[0]?.result).toMatchObject({
        issuanceId: reservationIssuanceId,
        replayed: true,
      });
      await prepareClient.query("commit");

      await prepareClient.query("begin");
      await prepareClient.query("set local statement_timeout = '5s'");
      await prepareClient.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', $2, true)`,
        [workspaceId, binding.actor_id],
      );
      const backendRows = await prepareClient.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid() as pid",
      );
      const backendPid = backendRows.rows[0]?.pid;
      if (!backendPid) throw new Error("Prepare-Backend fehlt.");
      const blockedPrepare = prepareClient.query<JsonResult>(
        `select public.prepare_offer_issuance(
           $1::uuid, $2::uuid, $3::uuid
         ) as result`,
        [workspaceId, binding.offer_id, raceCandidateId],
      );
      await waitForBackendLock(backendPid);
      await profileWriter.query("commit");
      profileDriftCommitted = true;
      racedPrepareResult = (await blockedPrepare).rows[0]?.result;
      await prepareClient.query("commit");
    } catch (error) {
      await prepareClient.query("rollback").catch(() => undefined);
      await profileWriter.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      if (profileDriftCommitted) {
        await profileWriter.query("begin");
        await profileWriter.query("set local session_replication_role = replica");
        await profileWriter.query(
          `update public.offer_release_profile
              set current_revision = $3::integer,
                  updated_at = pg_catalog.clock_timestamp()
            where workspace_id = $1::uuid and id = $2::uuid`,
          [workspaceId, profile.profileId, profile.revision],
        );
        await profileWriter.query("commit");
      }
      prepareClient.release();
      profileWriter.release();
    }
    expect(racedPrepareResult).toEqual({
      status: "conflict",
      code: "candidate_source_changed",
    });
    const racedReservation = await tenantQuery<{ issuance_count: number }>(
      workspaceId,
      null,
      `select pg_catalog.count(*)::integer as issuance_count
         from public.offer_issuance
        where workspace_id = $1::uuid and candidate_id = $2::uuid`,
      [workspaceId, raceCandidateId],
    );
    expect(racedReservation.rows).toEqual([{ issuance_count: 0 }]);

    const cloneQueuedIssuance = (cloneId: string) => tenantQuery(
      workspaceId,
      null,
      `insert into public.offer_issuance
       select (pg_catalog.jsonb_populate_record(
         null::public.offer_issuance,
         pg_catalog.to_jsonb(source_row)
           || pg_catalog.jsonb_build_object(
             'id', $3::uuid,
             'reservation_key', pg_catalog.sha256(pg_catalog.convert_to(
               $3::uuid::text, 'UTF8'
             )),
             'input_snapshot', changed.input_snapshot,
             'input_sha256', pg_catalog.sha256(pg_catalog.convert_to(
               public.canonicalize_offer_json_v1(changed.input_snapshot),
               'UTF8'
             ))
           )
       )).*
         from public.offer_issuance as source_row
         cross join lateral (
           select pg_catalog.jsonb_set(
             source_row.input_snapshot,
             '{issuanceId}',
             pg_catalog.to_jsonb($3::uuid::text),
             false
           ) as input_snapshot
         ) as changed
        where source_row.workspace_id = $1::uuid
          and source_row.id = $2::uuid`,
      [workspaceId, reservationIssuanceId, cloneId],
    );
    const issuanceId = randomUUID();
    const rejectedIssuanceId = randomUUID();
    const recoveryIssuanceId = randomUUID();
    const corruptedIssuanceId = randomUUID();
    for (const cloneId of [
      issuanceId,
      rejectedIssuanceId,
      recoveryIssuanceId,
      corruptedIssuanceId,
    ]) await cloneQueuedIssuance(cloneId);

    const earlyWithdrawalRows = await tenantQuery<JsonResult>(
      workspaceId,
      binding.actor_id,
      `select public.withdraw_offer_issuance($1::uuid, $2::uuid, 'content_error')
         as result`,
      [workspaceId, reservationIssuanceId],
    );
    expect(earlyWithdrawalRows.rows[0]?.result).toMatchObject({
      status: "withdrawn",
      approvalCount: 0,
      derivedState: "withdrawn_before_archive",
    });
    const earlyReplay = await prepare();
    expect(earlyReplay.rows[0]?.result).toMatchObject({
      status: "prepared",
      issuanceId: reservationIssuanceId,
      state: "queued",
      derivedState: "withdrawn_before_archive",
      replayed: true,
    });
    const earlyDispatch = await tenantQuery(
      workspaceId,
      null,
      `select * from public._m203b1_offer_issuance_dispatch_state(
         $1::uuid, $2::uuid
       )`,
      [workspaceId, reservationIssuanceId],
    );
    expect(earlyDispatch.rows).toEqual([]);

    // Ein weiterer versiegelter Teststand derselben fachlichen Quelle belegt
    // den terminalen Workerpfad, ohne den erfolgreichen Hauptpfad zu opfern.
    const rejectedLeaseToken = randomUUID();
    const rejectedClaim = await tenantQuery<JsonResult>(
      workspaceId,
      null,
      `select public.claim_offer_issuance_render(
         $1::uuid, $2::uuid, $3::uuid, 120
       ) as result`,
      [workspaceId, rejectedIssuanceId, rejectedLeaseToken],
    );
    expect(rejectedClaim.rows[0]?.result).toMatchObject({
      status: "claimed",
      issuanceId: rejectedIssuanceId,
      attemptCount: 1,
    });
    const promotedCandidateRows = await tenantQuery<JsonResult>(
      workspaceId,
      null,
      `select public.finalize_offer_issuance_render_success(
         $1::uuid, $2::uuid, $3::uuid, 1, $4::bytea
       ) as result`,
      [workspaceId, rejectedIssuanceId, rejectedLeaseToken, candidateArtifact],
    );
    expect(promotedCandidateRows.rows[0]?.result).toEqual({
      status: "conflict",
      code: "renderer_nondeterministic",
    });
    const rejectedFailure = await tenantQuery<JsonResult>(
      workspaceId,
      null,
      `select public.finalize_offer_issuance_render_failure(
         $1::uuid, $2::uuid, $3::uuid, 1,
         'renderer_nondeterministic', false
       ) as result`,
      [workspaceId, rejectedIssuanceId, rejectedLeaseToken],
    );
    expect(rejectedFailure.rows[0]?.result).toMatchObject({
      status: "failed_final",
      attemptCount: 1,
      errorCode: "renderer_nondeterministic",
    });
    const rejectedState = await tenantQuery<{
      state: string;
      error_code: string;
      error_retryable: boolean;
      artifact_bytes: Buffer | null;
    }>(
      workspaceId,
      null,
      `select state, error_code, error_retryable, artifact_bytes
         from public.offer_issuance
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, rejectedIssuanceId],
    );
    expect(rejectedState.rows).toEqual([{
      state: "failed_final",
      error_code: "renderer_nondeterministic",
      error_retryable: false,
      artifact_bytes: null,
    }]);

    const makeRetryDue = async () => {
      const admin = await superuserPool().connect();
      try {
        await admin.query("begin");
        await admin.query("set local session_replication_role = replica");
        await admin.query(
          `update public.offer_issuance
              set next_attempt_at = pg_catalog.clock_timestamp() - interval '1 second'
            where workspace_id = $1::uuid and id = $2::uuid`,
          [workspaceId, recoveryIssuanceId],
        );
        await admin.query("commit");
      } catch (error) {
        await admin.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        admin.release();
      }
    };
    for (const attemptCount of [1, 2]) {
      const recoveryLease = randomUUID();
      const recoveryClaim = await tenantQuery<JsonResult>(
        workspaceId,
        null,
        `select public.claim_offer_issuance_render(
           $1::uuid, $2::uuid, $3::uuid, 120
         ) as result`,
        [workspaceId, recoveryIssuanceId, recoveryLease],
      );
      expect(recoveryClaim.rows[0]?.result).toMatchObject({
        status: "claimed",
        attemptCount,
      });
      const retryFailure = await tenantQuery<JsonResult>(
        workspaceId,
        null,
        `select public.finalize_offer_issuance_render_failure(
           $1::uuid, $2::uuid, $3::uuid, $4::integer,
           'browser_unavailable', true
         ) as result`,
        [workspaceId, recoveryIssuanceId, recoveryLease, attemptCount],
      );
      expect(retryFailure.rows[0]?.result).toMatchObject({
        status: "retry_wait",
        attemptCount,
      });
      await makeRetryDue();
    }
    const thirdLease = randomUUID();
    const thirdClaim = await tenantQuery<JsonResult>(
      workspaceId,
      null,
      `select public.claim_offer_issuance_render(
         $1::uuid, $2::uuid, $3::uuid, 120
       ) as result`,
      [workspaceId, recoveryIssuanceId, thirdLease],
    );
    expect(thirdClaim.rows[0]?.result).toMatchObject({
      status: "claimed",
      attemptCount: 3,
    });
    const immediateSentinelState = await tenantQuery<{
      domain_state: string;
      domain_attempt_count: number;
      domain_lease_expires_at: Date;
    }>(
      workspaceId,
      null,
      `select * from public._m203b1_offer_issuance_dispatch_state(
         $1::uuid, $2::uuid
       )`,
      [workspaceId, recoveryIssuanceId],
    );
    expect(immediateSentinelState.rows).toHaveLength(1);
    expect(immediateSentinelState.rows[0]).toMatchObject({
      domain_state: "running",
      domain_attempt_count: 3,
    });
    expect((immediateSentinelState.rows[0]?.domain_attempt_count ?? 0) + 1).toBe(4);
    expect(immediateSentinelState.rows[0]?.domain_lease_expires_at)
      .toBeInstanceOf(Date);

    const leaseAdmin = await superuserPool().connect();
    try {
      await leaseAdmin.query("begin");
      await leaseAdmin.query("set local session_replication_role = replica");
      await leaseAdmin.query(
        `update public.offer_issuance
            set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, recoveryIssuanceId],
      );
      await leaseAdmin.query("commit");
    } catch (error) {
      await leaseAdmin.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      leaseAdmin.release();
    }
    const sentinelClaim = await tenantQuery<JsonResult>(
      workspaceId,
      null,
      `select public.claim_offer_issuance_render(
         $1::uuid, $2::uuid, $3::uuid, 120
       ) as result`,
      [workspaceId, recoveryIssuanceId, randomUUID()],
    );
    expect(sentinelClaim.rows[0]?.result).toMatchObject({
      status: "failed_final",
      attemptCount: 3,
      errorCode: "lease_expired",
    });
    const consumedSentinel = await tenantQuery<JsonResult>(
      workspaceId,
      null,
      `select public.claim_offer_issuance_render(
         $1::uuid, $2::uuid, $3::uuid, 120
       ) as result`,
      [workspaceId, recoveryIssuanceId, randomUUID()],
    );
    expect(consumedSentinel.rows[0]?.result).toEqual({ status: "not_claimable" });
    const recoveredState = await tenantQuery<{
      state: string;
      attempt_count: number;
      error_code: string;
      error_retryable: boolean;
    }>(
      workspaceId,
      null,
      `select state, attempt_count, error_code, error_retryable
         from public.offer_issuance
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, recoveryIssuanceId],
    );
    expect(recoveredState.rows).toEqual([{
      state: "failed_final",
      attempt_count: 3,
      error_code: "lease_expired",
      error_retryable: false,
    }]);

    let corruptedClaimResult: Record<string, unknown> | undefined;
    const corruptionAdmin = await superuserPool().connect();
    try {
      await corruptionAdmin.query("begin");
      const constraintRows = await corruptionAdmin.query<{ definition: string }>(
        `select pg_catalog.pg_get_constraintdef(constraint_row.oid) as definition
           from pg_catalog.pg_constraint as constraint_row
          where constraint_row.conrelid = 'public.offer_issuance'::regclass
            and constraint_row.conname = 'offer_issuance_input_hash_ck'`,
      );
      const constraintDefinition = constraintRows.rows[0]?.definition;
      if (!constraintDefinition) throw new Error("Issuance-Hashconstraint fehlt.");
      await corruptionAdmin.query(
        "alter table public.offer_issuance drop constraint offer_issuance_input_hash_ck",
      );
      await corruptionAdmin.query("set local session_replication_role = replica");
      await corruptionAdmin.query(
        `update public.offer_issuance
            set input_sha256 = $3::bytea
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, corruptedIssuanceId, Buffer.alloc(32, 0x7f)],
      );
      await corruptionAdmin.query("set local session_replication_role = origin");
      await corruptionAdmin.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true)",
        [workspaceId],
      );
      const corruptedClaim = await corruptionAdmin.query<JsonResult>(
        `select public.claim_offer_issuance_render(
           $1::uuid, $2::uuid, $3::uuid, 120
         ) as result`,
        [workspaceId, corruptedIssuanceId, randomUUID()],
      );
      corruptedClaimResult = corruptedClaim.rows[0]?.result;
      await corruptionAdmin.query("set local session_replication_role = replica");
      await corruptionAdmin.query(
        `update public.offer_issuance
            set input_sha256 = pg_catalog.sha256(pg_catalog.convert_to(
              public.canonicalize_offer_json_v1(input_snapshot), 'UTF8'
            ))
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, corruptedIssuanceId],
      );
      await corruptionAdmin.query("set local session_replication_role = origin");
      await corruptionAdmin.query(
        `alter table public.offer_issuance
           add constraint offer_issuance_input_hash_ck ${constraintDefinition}`,
      );
      await corruptionAdmin.query("commit");
    } catch (error) {
      await corruptionAdmin.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      corruptionAdmin.release();
    }
    expect(corruptedClaimResult).toMatchObject({
      status: "failed_final",
      attemptCount: 1,
      errorCode: "invalid_input",
    });
    const corruptedState = await tenantQuery<{
      state: string;
      error_code: string;
      error_retryable: boolean;
    }>(
      workspaceId,
      null,
      `select state, error_code, error_retryable
         from public.offer_issuance
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, corruptedIssuanceId],
    );
    expect(corruptedState.rows).toEqual([{
      state: "failed_final",
      error_code: "invalid_input",
      error_retryable: false,
    }]);
    const corruptedReplay = await tenantQuery<JsonResult>(
      workspaceId,
      null,
      `select public.claim_offer_issuance_render(
         $1::uuid, $2::uuid, $3::uuid, 120
       ) as result`,
      [workspaceId, corruptedIssuanceId, randomUUID()],
    );
    expect(corruptedReplay.rows[0]?.result).toEqual({ status: "not_claimable" });

    const leaseToken = randomUUID();
    const claimRows = await tenantQuery<JsonResult>(
      workspaceId,
      null,
      `select public.claim_offer_issuance_render(
         $1::uuid, $2::uuid, $3::uuid, 120
       ) as result`,
      [workspaceId, issuanceId, leaseToken],
    );
    expect(claimRows.rows[0]?.result).toMatchObject({
      status: "claimed",
      workspaceId,
      issuanceId,
      leaseToken,
      attemptCount: 1,
    });
    const finalArtifact = m203b1Artifact(0x65);
    const successRows = await tenantQuery<JsonResult>(
      workspaceId,
      null,
      `select public.finalize_offer_issuance_render_success(
         $1::uuid, $2::uuid, $3::uuid, 1, $4::bytea
       ) as result`,
      [workspaceId, issuanceId, leaseToken, finalArtifact.bytes],
    );
    expect(successRows.rows[0]?.result).toMatchObject({
      status: "ready_for_approval",
      attemptCount: 1,
      replayed: false,
    });

    let driftedApprovalResult: Record<string, unknown> | undefined;
    const recipientWriter = await superuserPool().connect();
    const approvalClient = await testPool.connect();
    let recipientDriftCommitted = false;
    try {
      await recipientWriter.query("begin");
      await recipientWriter.query("set local session_replication_role = replica");
      await recipientWriter.query(
        `update public.offer_recipient
            set current_revision = current_revision + 1,
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, recipient.recipientId],
      );

      await approvalClient.query("begin");
      await approvalClient.query("set local statement_timeout = '5s'");
      await approvalClient.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', $2, true)`,
        [workspaceId, binding.actor_id],
      );
      const backendRows = await approvalClient.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid() as pid",
      );
      const backendPid = backendRows.rows[0]?.pid;
      if (!backendPid) throw new Error("Approval-Backend fehlt.");
      const blockedApproval = approvalClient.query<JsonResult>(
        `select public.approve_offer_issuance(
           $1::uuid, $2::uuid, true, true, true, true, null
         ) as result`,
        [workspaceId, issuanceId],
      );
      await waitForBackendLock(backendPid);
      await recipientWriter.query("commit");
      recipientDriftCommitted = true;
      driftedApprovalResult = (await blockedApproval).rows[0]?.result;
      await approvalClient.query("commit");
    } catch (error) {
      await approvalClient.query("rollback").catch(() => undefined);
      await recipientWriter.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      if (recipientDriftCommitted) {
        await recipientWriter.query("begin");
        await recipientWriter.query("set local session_replication_role = replica");
        await recipientWriter.query(
          `update public.offer_recipient
              set current_revision = $3::integer,
                  updated_at = pg_catalog.clock_timestamp()
            where workspace_id = $1::uuid and id = $2::uuid`,
          [workspaceId, recipient.recipientId, recipient.revision],
        );
        await recipientWriter.query("commit");
      }
      approvalClient.release();
      recipientWriter.release();
    }
    expect(driftedApprovalResult).toEqual({
      status: "conflict",
      code: "issuance_source_changed",
    });
    const approvalsAfterDrift = await tenantQuery<{ approval_count: number }>(
      workspaceId,
      null,
      `select pg_catalog.count(*)::integer as approval_count
         from public.offer_issuance_approval
        where workspace_id = $1::uuid and issuance_id = $2::uuid`,
      [workspaceId, issuanceId],
    );
    expect(approvalsAfterDrift.rows).toEqual([{ approval_count: 0 }]);

    const secondActor = randomUUID();
    await tenantQuery(
      workspaceId,
      null,
      `insert into public.user_identity (id, email)
       values ($1::uuid, $2::text)`,
      [secondActor, `m203b1-${secondActor}@example.invalid`],
    );
    await tenantQuery(
      workspaceId,
      null,
      `insert into public.membership (workspace_id, user_id, role, capabilities)
       values ($1::uuid, $2::uuid, 'admin', '{}'::jsonb)`,
      [workspaceId, secondActor],
    );
    const readOnlyActor = randomUUID();
    await tenantQuery(
      workspaceId,
      null,
      `insert into public.user_identity (id, email)
       values ($1::uuid, $2::text)`,
      [readOnlyActor, `m203b1-viewer-${readOnlyActor}@example.invalid`],
    );
    await tenantQuery(
      workspaceId,
      null,
      `insert into public.membership (workspace_id, user_id, role, capabilities)
       values ($1::uuid, $2::uuid, 'viewer', '{}'::jsonb)`,
      [workspaceId, readOnlyActor],
    );
    const editorWithoutApprovalCapability = randomUUID();
    await tenantQuery(
      workspaceId,
      null,
      `insert into public.user_identity (id, email)
       values ($1::uuid, $2::text)`,
      [
        editorWithoutApprovalCapability,
        `m203b1-editor-${editorWithoutApprovalCapability}@example.invalid`,
      ],
    );
    await tenantQuery(
      workspaceId,
      null,
      `insert into public.membership (workspace_id, user_id, role, capabilities)
       values ($1::uuid, $2::uuid, 'editor', '{}'::jsonb)`,
      [workspaceId, editorWithoutApprovalCapability],
    );
    const approvalSurface = (actorId: string) => tenantQuery<{
      viewer_has_approved: boolean;
      can_current_actor_approve: boolean;
      approval_count: number;
    }>(
      workspaceId,
      actorId,
      `select viewer_has_approved, can_current_actor_approve, approval_count
         from public.read_offer_issuance_status($1::uuid, $2::uuid, $3::uuid)`,
      [workspaceId, binding.offer_id, issuanceId],
    );
    await expect(approvalSurface(binding.actor_id)).resolves.toMatchObject({ rows: [{
      viewer_has_approved: false,
      can_current_actor_approve: true,
      approval_count: 0,
    }] });
    await expect(approvalSurface(readOnlyActor)).resolves.toMatchObject({ rows: [{
      viewer_has_approved: false,
      can_current_actor_approve: false,
      approval_count: 0,
    }] });
    await expect(approvalSurface(editorWithoutApprovalCapability)).resolves.toMatchObject({ rows: [{
      viewer_has_approved: false,
      can_current_actor_approve: false,
      approval_count: 0,
    }] });
    const approve = (actorId: string) => tenantQuery<JsonResult>(
      workspaceId,
      actorId,
      `select public.approve_offer_issuance(
         $1::uuid, $2::uuid, true, true, true, true, null
       ) as result`,
      [workspaceId, issuanceId],
    );
    const firstApproval = await approve(binding.actor_id);
    expect(firstApproval.rows[0]?.result).toMatchObject({
      status: "approved",
      approvalCount: 1,
      derivedState: "approval_pending",
      approvedBy: binding.actor_id,
      replayed: false,
    });
    await expect(approvalSurface(binding.actor_id)).resolves.toMatchObject({ rows: [{
      viewer_has_approved: true,
      can_current_actor_approve: false,
      approval_count: 1,
    }] });
    await expect(approvalSurface(secondActor)).resolves.toMatchObject({ rows: [{
      viewer_has_approved: false,
      can_current_actor_approve: true,
      approval_count: 1,
    }] });
    const firstApproverSurface = await tenantQuery<{ surface: Record<string, unknown> }>(
      workspaceId,
      binding.actor_id,
      `select pg_catalog.to_jsonb(status_row) as surface
         from public.read_offer_issuance_status($1::uuid, $2::uuid, $3::uuid)
              as status_row`,
      [workspaceId, binding.offer_id, issuanceId],
    );
    expect(firstApproverSurface.rows[0]?.surface).toMatchObject({
      viewer_has_approved: true,
      can_current_actor_approve: false,
    });
    expect(firstApproverSurface.rows[0]?.surface).not.toHaveProperty("approved_by");
    expect(firstApproverSurface.rows[0]?.surface).not.toHaveProperty("actor_id");
    expect(JSON.stringify(firstApproverSurface.rows[0]?.surface)).not.toContain(
      binding.actor_id,
    );
    const firstReplay = await approve(binding.actor_id);
    expect(firstReplay.rows[0]?.result).toMatchObject({
      approvalCount: 1,
      replayed: true,
    });
    const secondApproval = await approve(secondActor);
    expect(secondApproval.rows[0]?.result).toMatchObject({
      status: "approved",
      approvalCount: 2,
      derivedState: "approved_for_archive_not_issued",
      approvedBy: secondActor,
    });
    await expect(approvalSurface(secondActor)).resolves.toMatchObject({ rows: [{
      viewer_has_approved: true,
      can_current_actor_approve: false,
      approval_count: 2,
    }] });

    const artifactRows = await tenantQuery<{
      derived_state: string;
      approval_count: number;
      artifact_bytes: Buffer;
    }>(
      workspaceId,
      binding.actor_id,
      `select derived_state, approval_count, artifact_bytes
         from public.read_offer_issuance_artifact($1::uuid, $2::uuid, $3::uuid)`,
      [workspaceId, binding.offer_id, issuanceId],
    );
    expect(artifactRows.rows).toHaveLength(1);
    expect(artifactRows.rows[0]?.derived_state).toBe("approved_for_archive_not_issued");
    expect(artifactRows.rows[0]?.approval_count).toBe(2);
    expect(artifactRows.rows[0]?.artifact_bytes).toEqual(finalArtifact.bytes);
    const editorArtifactRows = await tenantQuery<{
      can_current_actor_approve: boolean;
      artifact_bytes: Buffer;
    }>(
      workspaceId,
      editorWithoutApprovalCapability,
      `select can_current_actor_approve, artifact_bytes
         from public.read_offer_issuance_artifact($1::uuid, $2::uuid, $3::uuid)`,
      [workspaceId, binding.offer_id, issuanceId],
    );
    expect(editorArtifactRows.rows).toEqual([{
      can_current_actor_approve: false,
      artifact_bytes: finalArtifact.bytes,
    }]);

    const withdrawalRows = await tenantQuery<JsonResult>(
      workspaceId,
      secondActor,
      `select public.withdraw_offer_issuance($1::uuid, $2::uuid, 'content_error')
         as result`,
      [workspaceId, issuanceId],
    );
    expect(withdrawalRows.rows[0]?.result).toMatchObject({
      status: "withdrawn",
      approvalCount: 2,
      derivedState: "withdrawn_before_archive",
      reasonCode: "content_error",
      replayed: false,
    });
    const withdrawnStatus = await tenantQuery<{
      derived_state: string;
      approval_count: number;
      withdrawal_reason_code: string;
    }>(
      workspaceId,
      binding.actor_id,
      `select derived_state, approval_count, withdrawal_reason_code
         from public.read_offer_issuance_status($1::uuid, $2::uuid, $3::uuid)`,
      [workspaceId, binding.offer_id, issuanceId],
    );
    expect(withdrawnStatus.rows).toEqual([{
      derived_state: "withdrawn_before_archive",
      approval_count: 2,
      withdrawal_reason_code: "content_error",
    }]);
    const blockedApproval = await approve(secondActor);
    expect(blockedApproval.rows[0]?.result).toEqual({
      status: "conflict",
      code: "withdrawn_before_archive",
    });
    await expect(tenantQuery(
      randomUUID(),
      binding.actor_id,
      `select public.read_offer_issuance_status($1::uuid, $2::uuid, $3::uuid)`,
      [workspaceId, binding.offer_id, issuanceId],
    )).rejects.toMatchObject({ code: "42501" });

    let replayAfterDrift: Record<string, unknown> | undefined;
    let otherCandidateAfterDrift: Record<string, unknown> | undefined;
    const driftAdmin = await superuserPool().connect();
    try {
      await driftAdmin.query("begin");
      const constraintRows = await driftAdmin.query<{ definition: string }>(
        `select pg_catalog.pg_get_constraintdef(constraint_row.oid) as definition
           from pg_catalog.pg_constraint as constraint_row
          where constraint_row.conrelid = 'public.offer_release_candidate'::regclass
            and constraint_row.conname = 'offer_release_candidate_input_ck'`,
      );
      const constraintDefinition = constraintRows.rows[0]?.definition;
      if (!constraintDefinition) throw new Error("Candidate-Inputconstraint fehlt.");
      await driftAdmin.query(
        `alter table public.offer_release_candidate
           drop constraint offer_release_candidate_input_ck`,
      );
      await driftAdmin.query("set local session_replication_role = replica");
      await driftAdmin.query(
        `update public.offer_release_candidate
            set prepared_at = pg_catalog.date_trunc(
                  'milliseconds', pg_catalog.clock_timestamp() - interval '2 days'
                ),
                created_at = pg_catalog.date_trunc(
                  'milliseconds', pg_catalog.clock_timestamp() - interval '2 days'
                ),
                updated_at = pg_catalog.date_trunc(
                  'milliseconds', pg_catalog.clock_timestamp() - interval '2 days'
                ),
                document_date = (
                  pg_catalog.clock_timestamp() at time zone 'Europe/Berlin'
                )::date - 2,
                valid_through = (
                  pg_catalog.clock_timestamp() at time zone 'Europe/Berlin'
                )::date - 1
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, candidateId],
      );
      await driftAdmin.query(
        `update public.offer_recipient
            set current_revision = current_revision + 1,
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, recipient.recipientId],
      );
      await driftAdmin.query("set local session_replication_role = origin");
      await driftAdmin.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', $2, true)`,
        [workspaceId, binding.actor_id],
      );
      const exactReplay = await driftAdmin.query<JsonResult>(
        `select public.prepare_offer_issuance(
           $1::uuid, $2::uuid, $3::uuid
         ) as result`,
        [workspaceId, binding.offer_id, candidateId],
      );
      replayAfterDrift = exactReplay.rows[0]?.result;
      const otherCandidate = await driftAdmin.query<JsonResult>(
        `select public.prepare_offer_issuance(
           $1::uuid, $2::uuid, $3::uuid
         ) as result`,
        [workspaceId, binding.offer_id, randomUUID()],
      );
      otherCandidateAfterDrift = otherCandidate.rows[0]?.result;
      await driftAdmin.query("set local session_replication_role = replica");
      await driftAdmin.query(
        `update public.offer_release_candidate
            set prepared_at = $3::timestamptz,
                created_at = $3::timestamptz,
                updated_at = $3::timestamptz,
                document_date = $4::date,
                valid_through = $5::date
          where workspace_id = $1::uuid and id = $2::uuid`,
        [
          workspaceId,
          candidateId,
          clock.prepared_at,
          clock.document_date,
          clock.valid_through,
        ],
      );
      await driftAdmin.query(
        `update public.offer_recipient
            set current_revision = $3::integer,
                updated_at = pg_catalog.clock_timestamp()
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, recipient.recipientId, recipient.revision],
      );
      await driftAdmin.query("set local session_replication_role = origin");
      await driftAdmin.query(
        `alter table public.offer_release_candidate
           add constraint offer_release_candidate_input_ck ${constraintDefinition}`,
      );
      await driftAdmin.query("commit");
    } catch (error) {
      await driftAdmin.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      driftAdmin.release();
    }
    expect(replayAfterDrift).toMatchObject({
      status: "prepared",
      issuanceId: reservationIssuanceId,
      state: "queued",
      derivedState: "withdrawn_before_archive",
      replayed: true,
    });
    expect(otherCandidateAfterDrift).toEqual({ status: "not_found" });

    const graphRows = await tenantQuery<{
      contact_id: string;
      graph_ids: Record<string, unknown>;
    }>(
      workspaceId,
      null,
      `select offer_record.contact_id,
              public.build_inactive_lead_erasure_graph(
                $1::uuid, offer_record.contact_id
              ) as graph_ids
         from public.offer as offer_record
        where offer_record.workspace_id = $1::uuid
          and offer_record.id = $2::uuid`,
      [workspaceId, binding.offer_id],
    );
    const erasureBinding = graphRows.rows[0];
    if (!erasureBinding) throw new Error("Issuance-Erasuregraph fehlt.");
    expect(erasureBinding.graph_ids).toMatchObject({
      offerIssuanceIds: [
        reservationIssuanceId,
        issuanceId,
        rejectedIssuanceId,
        recoveryIssuanceId,
        corruptedIssuanceId,
      ].sort(),
      offerIssuanceApprovalIds: expect.arrayContaining([
        firstApproval.rows[0]?.result.approvalId,
        secondApproval.rows[0]?.result.approvalId,
      ]),
      offerIssuanceWithdrawalIds: [
        earlyWithdrawalRows.rows[0]?.result.withdrawalId,
        withdrawalRows.rows[0]?.result.withdrawalId,
      ].sort(),
    });
    await expect(tenantQuery(
      workspaceId,
      null,
      `delete from public.offer_issuance
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, issuanceId],
    )).rejects.toThrow(/Erasurevertrag/u);

    // Die generische Offer-Fixture laesst ihren vorgelagerten Calculation-Job
    // absichtlich mit aktiver Lease stehen. Fuer diesen Erasure-Replay muss nur
    // diese fremde Fixture-Lease ablaufen; die Issuance selbst ist terminal.
    const fixtureAdmin = await superuserPool().connect();
    try {
      await fixtureAdmin.query("begin");
      await fixtureAdmin.query("set local session_replication_role = replica");
      await fixtureAdmin.query(
        `update public.project_calculation_job
            set lease_expires_at = pg_catalog.statement_timestamp()
              - interval '1 minute'
          where workspace_id = $1::uuid`,
        [workspaceId],
      );
      await fixtureAdmin.query("commit");
    } catch (error) {
      await fixtureAdmin.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      fixtureAdmin.release();
    }

    const erasureOperationId = randomUUID();
    await tenantQuery(
      workspaceId,
      null,
      `insert into public.erasure_operation_locator (operation_id, scope_id)
       values ($1::uuid, $2::uuid)`,
      [erasureOperationId, workspaceId],
    );
    await tenantQuery(
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
                      pg_catalog.timestamptz_send(graph_hash.eligible_at), 'hex'
                    ),
                    pg_catalog.encode(
                      pg_catalog.timestamptz_send(graph_hash.erased_at), 'hex'
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
        erasureBinding.contact_id,
        JSON.stringify(erasureBinding.graph_ids),
      ],
    );
    const erasedRows = await tenantQuery<{ operation_id: string }>(
      workspaceId,
      null,
      `select public.erase_inactive_lead(
         $1::uuid, $2::uuid, $3::uuid
       ) as operation_id`,
      [workspaceId, erasureBinding.contact_id, erasureOperationId],
    );
    expect(erasedRows.rows).toEqual([{ operation_id: erasureOperationId }]);
    const erasedIssuanceRows = await tenantQuery<{
      issuance_count: number;
      approval_count: number;
      withdrawal_count: number;
    }>(
      workspaceId,
      null,
      `select
         (select pg_catalog.count(*)::int from public.offer_issuance
           where workspace_id = $1::uuid) as issuance_count,
         (select pg_catalog.count(*)::int from public.offer_issuance_approval
           where workspace_id = $1::uuid) as approval_count,
         (select pg_catalog.count(*)::int from public.offer_issuance_withdrawal
           where workspace_id = $1::uuid) as withdrawal_count`,
      [workspaceId],
    );
    expect(erasedIssuanceRows.rows).toEqual([{
      issuance_count: 0,
      approval_count: 0,
      withdrawal_count: 0,
    }]);
  });
});
