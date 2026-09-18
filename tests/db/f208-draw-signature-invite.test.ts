import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  hashPortalToken,
  PORTAL_INVITE_CREATE_VERSION,
  PORTAL_INVITE_WITHDRAW_VERSION,
} from "@/lib/integrations/portal/portal-contract";
import {
  SIGNATURE_PNG_MAX_BYTES,
  SIGNATURE_REQUEST_CREATE_VERSION,
} from "@/lib/integrations/offers/signature-contract";
import { createPortalInvite, withdrawPortalInvite } from "@/modules/portal";
import {
  createSignatureRequest,
  SignatureNotFoundError,
  SignatureValidationError,
  signSignatureByInviteToken,
  signSignatureDrawByInviteToken,
} from "@/modules/signatures";
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

// Welt wie F10-02c (Fixture → freigegebene Issuance + Invite + Request).
function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

async function buildDrawWorld(): Promise<{
  workspaceId: string;
  actorId: string;
  projectId: string;
  issuanceId: string;
  offerId: string;
  variantId: string;
  inviteToken: string;
  inviteId: string;
}> {
  const workspaceId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into public.workspace (id, name) values (${workspaceId}::uuid, 'F2-08-draw')
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
  if (!row) throw new Error("F2-08-draw: PDF-Entwurf fehlt.");

  await tenantQuery(workspaceId, null, `update project set phase = 'offer' where workspace_id = $1::uuid and id = $2::uuid`, [workspaceId, row.project_id]);
  await tenantQuery(workspaceId, null, `update membership set role = 'admin', capabilities = '{}'::jsonb where workspace_id = $1::uuid and user_id = $2::uuid`, [workspaceId, row.actor_id]);

  const sender = {
    legalName: "F208draw Energie GmbH", tradingName: "F208draw", representedBy: "F208draw Vertretung",
    address: { street: "Testweg", houseNumber: "1", postalCode: "10115", city: "Berlin", country: "DE" },
    email: "office@f208draw.invalid", phoneE164: "+493000000000", websiteHttpsUrl: "https://f208draw.invalid",
    registerCourt: "F208draw Registergericht", registerNumber: "HRB F208draw 1", vatId: "DE000000000",
  };
  const legalDocuments = {
    terms: { title: "Bedingungen", plainText: "Synthetische Bedingungen." },
    withdrawalInformation: { title: "Widerruf", plainText: "Synthetische Widerrufsinformation." },
    privacyNotice: { title: "Datenschutz", plainText: "Synthetischer Datenschutzhinweis." },
  };
  await tenantQuery(workspaceId, row.actor_id, `select public.revise_offer_release_profile($1::uuid, 0, 'F208draw Profil', $2::jsonb, $3::jsonb)`, [workspaceId, JSON.stringify(sender), JSON.stringify(legalDocuments)]);
  const profile = await tenantQuery<{ profile_id: string; profile_revision_id: string; profile_revision: number }>(workspaceId, null, `select profile.id as profile_id, revision.id as profile_revision_id, revision.revision as profile_revision from offer_release_profile as profile join offer_release_profile_revision as revision on revision.workspace_id = profile.workspace_id and revision.profile_id = profile.id and revision.revision = profile.current_revision where profile.workspace_id = $1::uuid limit 1`, [workspaceId]);
  await tenantQuery(workspaceId, row.actor_id, `select public.activate_offer_release_profile($1::uuid, $2::uuid, $3::uuid, $4::integer)`, [workspaceId, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision]);

  const billingAddress = { street: "Rechnungsweg", houseNumber: "8a", postalCode: "10999", city: "Berlin", country: "DE" };
  await tenantQuery(workspaceId, row.actor_id, `select public.revise_offer_recipient($1::uuid, $2::uuid, 0, 'F208draw Rechnungsempfaenger', 'F208draw Kundin GmbH', 'rechnung@f208draw.invalid', $3::jsonb, true)`, [workspaceId, row.offer_id, JSON.stringify(billingAddress)]);
  const recipient = await tenantQuery<{ recipient_revision_id: string; recipient_revision: number }>(workspaceId, null, `select revision.id as recipient_revision_id, revision.revision as recipient_revision from offer_recipient as recipient join offer_recipient_revision as revision on revision.workspace_id = recipient.workspace_id and revision.recipient_id = recipient.id and revision.revision = recipient.current_revision where recipient.workspace_id = $1::uuid and recipient.offer_id = $2::uuid limit 1`, [workspaceId, row.offer_id]);

  if (row.source_state !== "succeeded") {
    await tenantQuery(workspaceId, null, `update offer_pdf_draft set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`, [workspaceId, row.source_pdf_draft_id]);
    const sourceArtifact = Buffer.from(`%PDF-1.7\n${"f208draw-release-source".repeat(8)}\n%%EOF`, "utf8");
    await tenantQuery(workspaceId, null, `update offer_pdf_draft set state = 'succeeded', lease_token = null, lease_expires_at = null, artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea), finished_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $3::uuid and state = 'running'`, [workspaceId, sourceArtifact, row.source_pdf_draft_id]);
  }

  await tenantQuery(workspaceId, row.actor_id, `select public.prepare_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::uuid, $7::uuid, $8::integer, $9::uuid, $10::integer, ((clock_timestamp() at time zone 'Europe/Berlin')::date + 14)::date)`, [workspaceId, row.offer_id, row.variant_id, row.variant_revision, row.source_pdf_draft_id, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision, recipient.rows[0]?.recipient_revision_id, recipient.rows[0]?.recipient_revision]);
  const candidate = await tenantQuery<{ candidate_id: string }>(workspaceId, null, `select id as candidate_id from offer_release_candidate where workspace_id = $1::uuid and offer_id = $2::uuid order by created_at desc, id desc limit 1`, [workspaceId, row.offer_id]);

  await tenantQuery(workspaceId, null, `update offer_release_candidate set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`, [workspaceId, candidate.rows[0]?.candidate_id]);
  const candidateArtifact = Buffer.from(`%PDF-1.7\n${"f208draw-release-candidate".repeat(8)}\n%%EOF`, "utf8");
  const artifactVersion = randomUUID();
  await tenantQuery(workspaceId, null, `update offer_release_candidate set state = 'ready_for_approval', lease_token = null, lease_expires_at = null, artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea), artifact_version = $3::uuid, finished_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $4::uuid and state = 'running'`, [workspaceId, candidateArtifact, artifactVersion, candidate.rows[0]?.candidate_id]);
  await tenantQuery(workspaceId, row.actor_id, `select public.approve_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, true, true, true, null)`, [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id, artifactVersion]);

  const prepared = await tenantQuery<JsonResult>(workspaceId, row.actor_id, `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`, [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id]);
  const issuanceId = prepared.rows[0]?.result.issuanceId;
  if (typeof issuanceId !== "string") throw new Error("F2-08-draw: Reservation fehlt.");
  const lease = randomUUID();
  await tenantQuery(workspaceId, null, `select public.claim_offer_issuance_render($1::uuid, $2::uuid, $3::uuid, 120) as result`, [workspaceId, issuanceId, lease]);
  const artifact = Buffer.from(`%PDF-1.7\n${"f208draw-final-issuance".repeat(8)}\n%%EOF`, "utf8");
  await tenantQuery(workspaceId, null, `select public.finalize_offer_issuance_render_success($1::uuid, $2::uuid, $3::uuid, 1, $4::bytea) as result`, [workspaceId, issuanceId, lease, artifact]);

  const secondActor = randomUUID();
  await tenantQuery(workspaceId, null, `insert into public.user_identity (id, email) values ($1::uuid, $2::text)`, [secondActor, `f208draw-${secondActor}@example.invalid`]);
  await tenantQuery(workspaceId, null, `insert into public.membership (workspace_id, user_id, role, capabilities) values ($1::uuid, $2::uuid, 'admin', '{}'::jsonb)`, [workspaceId, secondActor]);

  const firstApproval = await tenantQuery<JsonResult>(workspaceId, row.actor_id, `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`, [workspaceId, issuanceId]);
  if (firstApproval.rows[0]?.result.status !== "approved") throw new Error("F2-08-draw: erste Freigabe fehlt.");
  const secondApproval = await tenantQuery<JsonResult>(workspaceId, secondActor, `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`, [workspaceId, issuanceId]);
  if (secondApproval.rows[0]?.result.status !== "approved") throw new Error("F2-08-draw: zweite Freigabe fehlt.");

  const invite = await withAuthorizedTenantOn(testPool, row.actor_id, workspaceId, (tx, ctx) =>
    createPortalInvite(tx, ctx as never, {
      schemaVersion: PORTAL_INVITE_CREATE_VERSION,
      workspaceId,
      projectId: row.project_id,
      ttlDays: 14,
    }) as never,
  ) as { token: string; inviteId: string };

  const created = await withAuthorizedTenantOn(testPool, row.actor_id, workspaceId, (tx, ctx) =>
    createSignatureRequest(tx, ctx as never, {
      schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
      workspaceId,
      offerId: row.offer_id,
      variantId: row.variant_id,
      ttlDays: 14,
    }) as never,
  ) as { requestId: string; issuanceId: string; status: string };
  if (created.status !== "pending") throw new Error("F2-08-draw: Request nicht pending.");

  return {
    workspaceId,
    actorId: row.actor_id,
    projectId: row.project_id,
    issuanceId: created.issuanceId,
    offerId: row.offer_id,
    variantId: row.variant_id,
    inviteToken: invite.token,
    inviteId: invite.inviteId,
  };
}

describe("F2.8 Portal-Draw-Signatur per Invite (PostgreSQL)", () => {
  it("F208-DB-01: Zeichnen per Invite signiert (draw + PNG-Artefakt), Double-sign ist Replay-ok", async () => {
    const world = await buildDrawWorld();
    const png = pngBytes();

    const signed = await signSignatureDrawByInviteToken(testPool, {
      token: world.inviteToken,
      issuanceId: world.issuanceId,
      artifactMimeType: "image/png",
      artifactBytes: png,
    });
    expect(signed.status).toBe("signed");
    expect(signed.attestationId).toMatch(/^[0-9a-f-]{36}$/u);

    const replay = await signSignatureDrawByInviteToken(testPool, {
      token: world.inviteToken,
      issuanceId: world.issuanceId,
      artifactMimeType: "image/png",
      artifactBytes: png,
    });
    expect(replay.status).toBe("already_signed");

    const stored = await tenantQuery<{
      mode: string;
      artifact_mime_type: string;
      artifact_size_bytes: number;
    }>(
      world.workspaceId, world.actorId,
      `select attestation.mode, attestation.artifact_mime_type, attestation.artifact_size_bytes
         from signature_attestation as attestation
         join signature_request as request_record
           on request_record.workspace_id = attestation.workspace_id
          and request_record.id = attestation.signature_request_id
        where request_record.workspace_id = $1::uuid and request_record.issuance_id = $2::uuid`,
      [world.workspaceId, world.issuanceId],
    );
    expect(stored.rows[0]?.mode).toBe("draw");
    expect(stored.rows[0]?.artifact_mime_type).toBe("image/png");
    expect(stored.rows[0]?.artifact_size_bytes).toBe(png.byteLength);
  });

  it("F208-DB-02: falsche PNG-Magic, falscher MIME-Typ und Uebergroesse scheitern fail-closed", async () => {
    const world = await buildDrawWorld();

    await expect(
      signSignatureDrawByInviteToken(testPool, {
        token: world.inviteToken,
        issuanceId: world.issuanceId,
        artifactMimeType: "image/png",
        artifactBytes: Buffer.from("kein-png", "utf8"),
      }),
    ).rejects.toBeInstanceOf(SignatureValidationError);

    await expect(
      signSignatureDrawByInviteToken(testPool, {
        token: world.inviteToken,
        issuanceId: world.issuanceId,
        artifactMimeType: "image/jpeg",
        artifactBytes: pngBytes(),
      }),
    ).rejects.toBeInstanceOf(SignatureValidationError);

    const oversized = Buffer.concat([pngBytes(), Buffer.alloc(SIGNATURE_PNG_MAX_BYTES, 0)]);
    await expect(
      signSignatureDrawByInviteToken(testPool, {
        token: world.inviteToken,
        issuanceId: world.issuanceId,
        artifactMimeType: "image/png",
        artifactBytes: oversized,
      }),
    ).rejects.toBeInstanceOf(SignatureValidationError);
  });

  it("F208-DB-04: abgelaufener/entzogener Invite und abgelaufener Request fallen auf NotFound", async () => {
    const expired = await buildDrawWorld();
    // Ablauf per Trigger-Disable altern (m204-Praezedenz): Guard bleibt
    // danach aktiv, nur die Uhrkante wird verschoben.
    const ageing = await testPool.connect();
    try {
      await ageing.query("begin");
      await ageing.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', $2, true)`,
        [expired.workspaceId, expired.actorId],
      );
      await ageing.query("alter table portal_invite disable trigger portal_invite_mutation_guard");
      const aged = await ageing.query(
        `update portal_invite
            set created_at = clock_timestamp() - interval '2 minutes',
                expires_at = clock_timestamp() - interval '1 minute'
          where workspace_id = $1::uuid and id = $2::uuid`,
        [expired.workspaceId, expired.inviteId],
      );
      expect(aged.rowCount, "Invite gealtert").toBe(1);
      await ageing.query("alter table portal_invite enable trigger portal_invite_mutation_guard");
      await ageing.query("commit");
    } finally {
      ageing.release();
    }
    await expect(
      signSignatureDrawByInviteToken(testPool, {
        token: expired.inviteToken,
        issuanceId: expired.issuanceId,
        artifactMimeType: "image/png",
        artifactBytes: pngBytes(),
      }),
    ).rejects.toBeInstanceOf(SignatureNotFoundError);

    const withdrawn = await buildDrawWorld();
    await withAuthorizedTenantOn(testPool, withdrawn.actorId, withdrawn.workspaceId, (tx, ctx) =>
      withdrawPortalInvite(tx, ctx as never, {
        schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
        workspaceId: withdrawn.workspaceId,
        inviteId: withdrawn.inviteId,
        reason: "superseded",
      }) as never,
    );
    await expect(
      signSignatureDrawByInviteToken(testPool, {
        token: withdrawn.inviteToken,
        issuanceId: withdrawn.issuanceId,
        artifactMimeType: "image/png",
        artifactBytes: pngBytes(),
      }),
    ).rejects.toBeInstanceOf(SignatureNotFoundError);

    const stale = await buildDrawWorld();
    const ageingRequest = await testPool.connect();
    try {
      await ageingRequest.query("begin");
      await ageingRequest.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', $2, true)`,
        [stale.workspaceId, stale.actorId],
      );
      await ageingRequest.query("alter table signature_request disable trigger signature_request_mutation_guard");
      await ageingRequest.query("alter table signature_request disable trigger signature_request_terminal_integrity");
      const staled = await ageingRequest.query(
        `update signature_request
            set created_at = clock_timestamp() - interval '2 minutes',
                expires_at = clock_timestamp() - interval '1 minute'
          where workspace_id = $1::uuid and issuance_id = $2::uuid`,
        [stale.workspaceId, stale.issuanceId],
      );
      expect(staled.rowCount, "Request gealtert").toBe(1);
      await ageingRequest.query("alter table signature_request enable trigger signature_request_terminal_integrity");
      await ageingRequest.query("alter table signature_request enable trigger signature_request_mutation_guard");
      await ageingRequest.query("commit");
    } finally {
      ageingRequest.release();
    }
    await expect(
      signSignatureDrawByInviteToken(testPool, {
        token: stale.inviteToken,
        issuanceId: stale.issuanceId,
        artifactMimeType: "image/png",
        artifactBytes: pngBytes(),
      }),
    ).rejects.toBeInstanceOf(SignatureNotFoundError);
  });

  it("F208-DB-05: Cross-Mode-Replay ist ok, Erstmodus gewinnt (kein zweites Artefakt)", async () => {
    // DECIDED (Review P2-3): modusblindes already_signed der Terminalkante,
    // Attestierung bleibt Erstmodus — kein Konflikt, kein Ueberschreiben.
    const clickFirst = await buildDrawWorld();
    await signSignatureByInviteToken(testPool, {
      token: clickFirst.inviteToken,
      issuanceId: clickFirst.issuanceId,
    });
    const replayDraw = await signSignatureDrawByInviteToken(testPool, {
      token: clickFirst.inviteToken,
      issuanceId: clickFirst.issuanceId,
      artifactMimeType: "image/png",
      artifactBytes: pngBytes(),
    });
    expect(replayDraw.status).toBe("already_signed");
    const keptClick = await tenantQuery<{ mode: string; artifact_bytes: Buffer | null }>(
      clickFirst.workspaceId, clickFirst.actorId,
      `select attestation.mode, attestation.artifact_bytes from signature_attestation as attestation
         join signature_request as request_record
           on request_record.workspace_id = attestation.workspace_id
          and request_record.id = attestation.signature_request_id
        where request_record.workspace_id = $1::uuid and request_record.issuance_id = $2::uuid`,
      [clickFirst.workspaceId, clickFirst.issuanceId],
    );
    expect(keptClick.rows[0]?.mode).toBe("click");
    expect(keptClick.rows[0]?.artifact_bytes).toBeNull();

    const drawFirst = await buildDrawWorld();
    await signSignatureDrawByInviteToken(testPool, {
      token: drawFirst.inviteToken,
      issuanceId: drawFirst.issuanceId,
      artifactMimeType: "image/png",
      artifactBytes: pngBytes(),
    });
    const replayClick = await signSignatureByInviteToken(testPool, {
      token: drawFirst.inviteToken,
      issuanceId: drawFirst.issuanceId,
    });
    expect(replayClick.status).toBe("already_signed");
    const keptDraw = await tenantQuery<{ mode: string }>(
      drawFirst.workspaceId, drawFirst.actorId,
      `select attestation.mode from signature_attestation as attestation
         join signature_request as request_record
           on request_record.workspace_id = attestation.workspace_id
          and request_record.id = attestation.signature_request_id
        where request_record.workspace_id = $1::uuid and request_record.issuance_id = $2::uuid`,
      [drawFirst.workspaceId, drawFirst.issuanceId],
    );
    expect(keptDraw.rows[0]?.mode).toBe("draw");
  });

  it("F208-DB-06: direkter Kapselaufruf mit falschem Envelope liefert fail-soft validation_error", async () => {
    const world = await buildDrawWorld();
    const tokenHash = hashPortalToken(world.inviteToken);
    expect(tokenHash).not.toBeNull();
    const direct = await tenantQuery<JsonResult>(
      world.workspaceId, null,
      `select public.sign_signature_draw_by_invite($1::bytea, $2::uuid, $3::text, $4::bytea) as result`,
      [tokenHash, world.issuanceId, "image/png", Buffer.from("kein-png", "utf8")],
    );
    expect(direct.rows[0]?.result.status).toBe("validation_error");
    const wrongMime = await tenantQuery<JsonResult>(
      world.workspaceId, null,
      `select public.sign_signature_draw_by_invite($1::bytea, $2::uuid, $3::text, $4::bytea) as result`,
      [tokenHash, world.issuanceId, "image/jpeg", pngBytes()],
    );
    expect(wrongMime.rows[0]?.result.status).toBe("validation_error");
  });

  it("F208-DB-03: fremde Issuance und toter Invite fallen uniform auf NotFound", async () => {
    const world = await buildDrawWorld();
    const png = pngBytes();

    await expect(
      signSignatureDrawByInviteToken(testPool, {
        token: world.inviteToken,
        issuanceId: randomUUID(),
        artifactMimeType: "image/png",
        artifactBytes: png,
      }),
    ).rejects.toBeInstanceOf(SignatureNotFoundError);
    await expect(
      signSignatureDrawByInviteToken(testPool, {
        token: "kein-echter-invite-token",
        issuanceId: world.issuanceId,
        artifactMimeType: "image/png",
        artifactBytes: png,
      }),
    ).rejects.toBeInstanceOf(SignatureNotFoundError);
  });
});
