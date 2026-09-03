import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { withTenantOn } from "../../lib/db/tenant";
import { tenantFixtures } from "../setup/tenant-fixtures";
import type { M201RuntimeState } from "./m2-01-fixture";

/**
 * M2-04 E-Signatur — Freigegebene-Ausstellungsfassung-Fixture.
 *
 * Port der Strict-Kette aus `tests/db/m204-e-signature-strict.test.ts`
 * (`buildApprovedIssuance`): Offer-Fixture → PDF-Draft → Angebotsprofil →
 * Empfänger → `prepare_offer_release_candidate` → Candidate-Approval →
 * `prepare_offer_issuance` → claim/finalize → 2× `approve_offer_issuance`.
 * Alle SECURITY-DEFINER-Produktfunktionen laufen unter app_owner; die
 * Tenant-/Actor-GUCs werden je Aufruf gesetzt (Muster `adminQuery`).
 *
 * Offer/Variante entstehen über `tenantFixtures.offer`/`offer_pdf_draft` aus
 * dem vorhandenen M2-01-Fixture-Bestand (project_catalog_resolution +
 * inbound_receipt) — es wird KEIN neuer Offer-Graph erfunden.
 */

export type M204ReleasedOffer = {
  offerId: string;
  variantId: string;
  issuanceId: string;
};

type JsonResult = QueryResultRow & { result: Record<string, unknown> };

async function tenantFn<Row extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  workspaceId: string,
  actorId: string | null,
  text: string,
  values: unknown[] = [],
): Promise<import("pg").QueryResult<Row>> {
  const client = await pool.connect();
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

export async function seedM204ReleasedOffer(
  state: M201RuntimeState,
): Promise<M204ReleasedOffer> {
  const pool = new Pool({ connectionString: state.databaseUrl, max: 1 });
  try {
    const workspaceId = state.workspaceId;

    await withTenantOn(pool, workspaceId, async (tx) => {
      await tenantFixtures.offer?.(tx, workspaceId);
      await tenantFixtures.offer_pdf_draft?.(tx, workspaceId);
    });

    const source = await tenantFn<{
      source_pdf_draft_id: string;
      source_state: string;
      offer_id: string;
      variant_id: string;
      variant_revision_id: string;
      variant_revision: number;
      actor_id: string;
    }>(
      pool,
      workspaceId,
      null,
      `select draft.id as source_pdf_draft_id, draft.state as source_state, draft.offer_id,
              draft.variant_id, draft.variant_revision_id, draft.variant_revision,
              offer_record.created_by as actor_id
         from offer_pdf_draft as draft
         join offer as offer_record
           on offer_record.workspace_id = draft.workspace_id
          and offer_record.id = draft.offer_id
        where draft.workspace_id = $1::uuid
        order by draft.created_at desc, draft.id desc limit 1`,
      [workspaceId],
    );
    const row = source.rows[0];
    if (!row) throw new Error("M2-04: PDF-Entwurf fehlt im Offer-Fixture.");

    await tenantFn(
      pool,
      workspaceId,
      null,
      `update membership set role = 'admin', capabilities = '{}'::jsonb
        where workspace_id = $1::uuid and user_id = $2::uuid`,
      [workspaceId, row.actor_id],
    );

    const sender = {
      legalName: "M204 Energie GmbH",
      tradingName: "M204",
      representedBy: "M204 Vertretung",
      address: { street: "Testweg", houseNumber: "1", postalCode: "10115", city: "Berlin", country: "DE" },
      email: "office@m204.invalid",
      phoneE164: "+493000000000",
      websiteHttpsUrl: "https://m204.invalid",
      registerCourt: "M204 RG",
      registerNumber: "HRB M204",
      vatId: "DE000000000",
    };
    const legalDocuments = {
      terms: { title: "Bedingungen", plainText: "Synthetische Bedingungen." },
      withdrawalInformation: { title: "Widerruf", plainText: "Synthetische Widerrufsinformation." },
      privacyNotice: { title: "Datenschutz", plainText: "Synthetischer Datenschutzhinweis." },
    };
    await tenantFn(
      pool,
      workspaceId,
      row.actor_id,
      `select public.revise_offer_release_profile($1::uuid, 0, 'M204 Profil', $2::jsonb, $3::jsonb)`,
      [workspaceId, JSON.stringify(sender), JSON.stringify(legalDocuments)],
    );
    const profile = await tenantFn<{ profile_id: string; profile_revision_id: string; profile_revision: number }>(
      pool,
      workspaceId,
      null,
      `select profile.id as profile_id, revision.id as profile_revision_id, revision.revision as profile_revision
         from offer_release_profile as profile
         join offer_release_profile_revision as revision
           on revision.workspace_id = profile.workspace_id
          and revision.profile_id = profile.id
          and revision.revision = profile.current_revision
        where profile.workspace_id = $1::uuid limit 1`,
      [workspaceId],
    );
    await tenantFn(
      pool,
      workspaceId,
      row.actor_id,
      `select public.activate_offer_release_profile($1::uuid, $2::uuid, $3::uuid, $4::integer)`,
      [
        workspaceId,
        profile.rows[0]?.profile_id,
        profile.rows[0]?.profile_revision_id,
        profile.rows[0]?.profile_revision,
      ],
    );

    const billingAddress = { street: "Rechnungsweg", houseNumber: "8a", postalCode: "10999", city: "Berlin", country: "DE" };
    await tenantFn(
      pool,
      workspaceId,
      row.actor_id,
      `select public.revise_offer_recipient($1::uuid, $2::uuid, 0, 'M204 Rechnungsempfaenger', 'M204 Kundin GmbH', 'rechnung@m204.invalid', $3::jsonb, true)`,
      [workspaceId, row.offer_id, JSON.stringify(billingAddress)],
    );
    const recipient = await tenantFn<{ recipient_revision_id: string; recipient_revision: number }>(
      pool,
      workspaceId,
      null,
      `select revision.id as recipient_revision_id, revision.revision as recipient_revision
         from offer_recipient as recipient
         join offer_recipient_revision as revision
           on revision.workspace_id = recipient.workspace_id
          and revision.recipient_id = recipient.id
          and revision.revision = recipient.current_revision
        where recipient.workspace_id = $1::uuid and recipient.offer_id = $2::uuid limit 1`,
      [workspaceId, row.offer_id],
    );

    if (row.source_state !== "succeeded") {
      await tenantFn(
        pool,
        workspaceId,
        null,
        `update offer_pdf_draft set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(),
                lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(),
                updated_at = clock_timestamp()
          where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`,
        [workspaceId, row.source_pdf_draft_id],
      );
      const sourceArtifact = Buffer.from(`%PDF-1.7\n${"m204-release-source".repeat(8)}\n%%EOF`, "utf8");
      await tenantFn(
        pool,
        workspaceId,
        null,
        `update offer_pdf_draft set state = 'succeeded', lease_token = null, lease_expires_at = null,
                artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea),
                artifact_size_bytes = octet_length($2::bytea), finished_at = clock_timestamp(), updated_at = clock_timestamp()
          where workspace_id = $1::uuid and id = $3::uuid and state = 'running'`,
        [workspaceId, sourceArtifact, row.source_pdf_draft_id],
      );
    }

    await tenantFn(
      pool,
      workspaceId,
      row.actor_id,
      `select public.prepare_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::uuid, $7::uuid, $8::integer, $9::uuid, $10::integer, ((clock_timestamp() at time zone 'Europe/Berlin')::date + 14)::date)`,
      [
        workspaceId,
        row.offer_id,
        row.variant_id,
        row.variant_revision,
        row.source_pdf_draft_id,
        profile.rows[0]?.profile_id,
        profile.rows[0]?.profile_revision_id,
        profile.rows[0]?.profile_revision,
        recipient.rows[0]?.recipient_revision_id,
        recipient.rows[0]?.recipient_revision,
      ],
    );
    const candidate = await tenantFn<{ candidate_id: string }>(
      pool,
      workspaceId,
      null,
      `select id as candidate_id from offer_release_candidate
        where workspace_id = $1::uuid and offer_id = $2::uuid
        order by created_at desc, id desc limit 1`,
      [workspaceId, row.offer_id],
    );

    await tenantFn(
      pool,
      workspaceId,
      null,
      `update offer_release_candidate set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(),
              lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(),
              updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`,
      [workspaceId, candidate.rows[0]?.candidate_id],
    );
    const candidateArtifact = Buffer.from(`%PDF-1.7\n${"m204-release-candidate".repeat(8)}\n%%EOF`, "utf8");
    const artifactVersion = randomUUID();
    await tenantFn(
      pool,
      workspaceId,
      null,
      `update offer_release_candidate set state = 'ready_for_approval', lease_token = null, lease_expires_at = null,
              artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea),
              artifact_size_bytes = octet_length($2::bytea), artifact_version = $3::uuid, finished_at = clock_timestamp(),
              updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $4::uuid and state = 'running'`,
      [workspaceId, candidateArtifact, artifactVersion, candidate.rows[0]?.candidate_id],
    );
    await tenantFn(
      pool,
      workspaceId,
      row.actor_id,
      `select public.approve_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, true, true, true, null)`,
      [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id, artifactVersion],
    );

    const prepared = await tenantFn<JsonResult>(
      pool,
      workspaceId,
      row.actor_id,
      `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`,
      [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id],
    );
    const issuanceId = prepared.rows[0]?.result.issuanceId;
    if (typeof issuanceId !== "string") throw new Error("M2-04: Ausstellungsreservation fehlt.");
    const lease = randomUUID();
    await tenantFn(
      pool,
      workspaceId,
      null,
      `select public.claim_offer_issuance_render($1::uuid, $2::uuid, $3::uuid, 120) as result`,
      [workspaceId, issuanceId, lease],
    );
    const artifact = Buffer.from(`%PDF-1.7\n${"m204-final-issuance".repeat(8)}\n%%EOF`, "utf8");
    await tenantFn(
      pool,
      workspaceId,
      null,
      `select public.finalize_offer_issuance_render_success($1::uuid, $2::uuid, $3::uuid, 1, $4::bytea) as result`,
      [workspaceId, issuanceId, lease, artifact],
    );

    const secondActor = randomUUID();
    await pool.query("insert into public.user_identity (id, email) values ($1, $2)", [
      secondActor,
      `m204-${secondActor}@invalid`,
    ]);
    const mc = await pool.connect();
    try {
      await mc.query("begin");
      await mc.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
      await mc.query("insert into public.membership (workspace_id, user_id, role, capabilities) values ($1, $2, 'admin', '{}'::jsonb)", [workspaceId, secondActor]);
      await mc.query("commit");
    } finally {
      mc.release();
    }

    const firstApproval = await tenantFn<JsonResult>(
      pool,
      workspaceId,
      row.actor_id,
      `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`,
      [workspaceId, issuanceId],
    );
    if (firstApproval.rows[0]?.result.status !== "approved") {
      throw new Error(`M2-04: erste Ausstellungs-Freigabe fehlgeschlagen (${JSON.stringify(firstApproval.rows[0]?.result)}).`);
    }
    const secondApproval = await tenantFn<JsonResult>(
      pool,
      workspaceId,
      secondActor,
      `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`,
      [workspaceId, issuanceId],
    );
    if (secondApproval.rows[0]?.result.status !== "approved") {
      throw new Error(`M2-04: zweite Ausstellungs-Freigabe fehlgeschlagen (${JSON.stringify(secondApproval.rows[0]?.result)}).`);
    }

    return { offerId: row.offer_id, variantId: row.variant_id, issuanceId };
  } finally {
    await pool.end();
  }
}
