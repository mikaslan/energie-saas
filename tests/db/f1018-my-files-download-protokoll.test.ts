import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import type { QueryResultRow } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f1018-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  PORTAL_INVITE_CREATE_VERSION,
  PORTAL_INVITE_WITHDRAW_VERSION,
} from "@/lib/integrations/portal/portal-contract";
import { readPortalDocumentArtifactByToken } from "@/modules/offers";
import { createPortalInvite, getPortalStatus, withdrawPortalInvite } from "@/modules/portal";
import {
  ProjectFileNotFoundError,
  readPortalProjectFileByToken,
  setProjectFileVisibility,
  uploadProjectFile,
} from "@/modules/project-files";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

/**
 * F10-18 My-Files-Download-Protokoll (Katalog F10.7) — DB-Vertrag D-01..D-06
 * (issuance NULLABLE + project_file_id + CHECK genau-eine + FK + Index +
 * Download-Insert in der F10-17-Kapsel, 0183). Fixture-Muster F1017
 * (seedFixture), Issuance-Muster F1012 (buildApprovedIssuance).
 */

const PDF_MINIMAL = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n",
  "utf8",
);

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

// Uebernommen aus tests/db/f1012-portal-download-protokoll.test.ts
// (buildApprovedIssuance): Angebot -> PDF-Entwurf -> Profil/Empfaenger ->
// Kandidat -> Issuance -> 2/2 Freigaben.
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
      insert into public.workspace (id, name) values (${workspaceId}::uuid, 'F10.18')
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
  if (!row) throw new Error("F10.18: PDF-Entwurf fehlt.");

  await tenantQuery(workspaceId, null, `update project set phase = 'offer' where workspace_id = $1::uuid and id = $2::uuid`, [workspaceId, row.project_id]);

  await tenantQuery(workspaceId, null, `update membership set role = 'admin', capabilities = '{}'::jsonb where workspace_id = $1::uuid and user_id = $2::uuid`, [workspaceId, row.actor_id]);

  const sender = {
    legalName: "F1018 Energie GmbH", tradingName: "F1018", representedBy: "F1018 Vertretung",
    address: { street: "Testweg", houseNumber: "1", postalCode: "10115", city: "Berlin", country: "DE" },
    email: "office@f1018.invalid", phoneE164: "+493000000000", websiteHttpsUrl: "https://f1018.invalid",
    registerCourt: "F1018 Registergericht", registerNumber: "HRB F1018 1", vatId: "DE000000000",
  };
  const legalDocuments = {
    terms: { title: "Bedingungen", plainText: "Synthetische Bedingungen." },
    withdrawalInformation: { title: "Widerruf", plainText: "Synthetische Widerrufsinformation." },
    privacyNotice: { title: "Datenschutz", plainText: "Synthetischer Datenschutzhinweis." },
  };
  await tenantQuery(workspaceId, row.actor_id, `select public.revise_offer_release_profile($1::uuid, 0, 'F1018 Profil', $2::jsonb, $3::jsonb)`, [workspaceId, JSON.stringify(sender), JSON.stringify(legalDocuments)]);
  const profile = await tenantQuery<{ profile_id: string; profile_revision_id: string; profile_revision: number }>(workspaceId, null, `select profile.id as profile_id, revision.id as profile_revision_id, revision.revision as profile_revision from offer_release_profile as profile join offer_release_profile_revision as revision on revision.workspace_id = profile.workspace_id and revision.profile_id = profile.id and revision.revision = profile.current_revision where profile.workspace_id = $1::uuid limit 1`, [workspaceId]);
  await tenantQuery(workspaceId, row.actor_id, `select public.activate_offer_release_profile($1::uuid, $2::uuid, $3::uuid, $4::integer)`, [workspaceId, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision]);

  const billingAddress = { street: "Rechnungsweg", houseNumber: "8a", postalCode: "10999", city: "Berlin", country: "DE" };
  await tenantQuery(workspaceId, row.actor_id, `select public.revise_offer_recipient($1::uuid, $2::uuid, 0, 'F1018 Rechnungsempfaenger', 'F1018 Kundin GmbH', 'rechnung@f1018.invalid', $3::jsonb, true)`, [workspaceId, row.offer_id, JSON.stringify(billingAddress)]);
  const recipient = await tenantQuery<{ recipient_revision_id: string; recipient_revision: number }>(workspaceId, null, `select revision.id as recipient_revision_id, revision.revision as recipient_revision from offer_recipient as recipient join offer_recipient_revision as revision on revision.workspace_id = recipient.workspace_id and revision.recipient_id = recipient.id and revision.revision = recipient.current_revision where recipient.workspace_id = $1::uuid and recipient.offer_id = $2::uuid limit 1`, [workspaceId, row.offer_id]);

  if (row.source_state !== "succeeded") {
    await tenantQuery(workspaceId, null, `update offer_pdf_draft set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`, [workspaceId, row.source_pdf_draft_id]);
    const sourceArtifact = Buffer.from(`%PDF-1.7\n${"f1018-release-source".repeat(8)}\n%%EOF`, "utf8");
    await tenantQuery(workspaceId, null, `update offer_pdf_draft set state = 'succeeded', lease_token = null, lease_expires_at = null, artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea), finished_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $3::uuid and state = 'running'`, [workspaceId, sourceArtifact, row.source_pdf_draft_id]);
  }

  await tenantQuery(workspaceId, row.actor_id, `select public.prepare_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::uuid, $7::uuid, $8::integer, $9::uuid, $10::integer, ((clock_timestamp() at time zone 'Europe/Berlin')::date + 14)::date)`, [workspaceId, row.offer_id, row.variant_id, row.variant_revision, row.source_pdf_draft_id, profile.rows[0]?.profile_id, profile.rows[0]?.profile_revision_id, profile.rows[0]?.profile_revision, recipient.rows[0]?.recipient_revision_id, recipient.rows[0]?.recipient_revision]);
  const candidate = await tenantQuery<{ candidate_id: string }>(workspaceId, null, `select id as candidate_id from offer_release_candidate where workspace_id = $1::uuid and offer_id = $2::uuid order by created_at desc, id desc limit 1`, [workspaceId, row.offer_id]);

  await tenantQuery(workspaceId, null, `update offer_release_candidate set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`, [workspaceId, candidate.rows[0]?.candidate_id]);
  const candidateArtifact = Buffer.from(`%PDF-1.7\n${"f1018-release-candidate".repeat(8)}\n%%EOF`, "utf8");
  const artifactVersion = randomUUID();
  await tenantQuery(workspaceId, null, `update offer_release_candidate set state = 'ready_for_approval', lease_token = null, lease_expires_at = null, artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea), artifact_size_bytes = octet_length($2::bytea), artifact_version = $3::uuid, finished_at = clock_timestamp(), updated_at = clock_timestamp() where workspace_id = $1::uuid and id = $4::uuid and state = 'running'`, [workspaceId, candidateArtifact, artifactVersion, candidate.rows[0]?.candidate_id]);
  await tenantQuery(workspaceId, row.actor_id, `select public.approve_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, true, true, true, null)`, [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id, artifactVersion]);

  const prepared = await tenantQuery<JsonResult>(workspaceId, row.actor_id, `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`, [workspaceId, row.offer_id, candidate.rows[0]?.candidate_id]);
  const issuanceId = prepared.rows[0]?.result.issuanceId;
  if (typeof issuanceId !== "string") throw new Error("F10.18: Reservation fehlt.");
  const lease = randomUUID();
  await tenantQuery(workspaceId, null, `select public.claim_offer_issuance_render($1::uuid, $2::uuid, $3::uuid, 120) as result`, [workspaceId, issuanceId, lease]);
  const artifact = Buffer.from(`%PDF-1.7\n${"f1018-final-issuance".repeat(8)}\n%%EOF`, "utf8");
  const finalized = await tenantQuery<JsonResult>(workspaceId, null, `select public.finalize_offer_issuance_render_success($1::uuid, $2::uuid, $3::uuid, 1, $4::bytea) as result`, [workspaceId, issuanceId, lease, artifact]);
  if (finalized.rows[0]?.result.status !== "ready_for_approval") throw new Error("F10.18: Finalisierung fehlt.");

  const secondActor = randomUUID();
  await tenantQuery(workspaceId, null, `insert into public.user_identity (id, email) values ($1::uuid, $2::text)`, [secondActor, `f1018-${secondActor}@example.invalid`]);
  await tenantQuery(workspaceId, null, `insert into public.membership (workspace_id, user_id, role, capabilities) values ($1::uuid, $2::uuid, 'admin', '{}'::jsonb)`, [workspaceId, secondActor]);

  const firstApproval = await tenantQuery<JsonResult>(workspaceId, row.actor_id, `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`, [workspaceId, issuanceId]);
  if (firstApproval.rows[0]?.result.status !== "approved") throw new Error("F10.18: erste Freigabe fehlt.");
  const secondApproval = await tenantQuery<JsonResult>(workspaceId, secondActor, `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`, [workspaceId, issuanceId]);
  if (secondApproval.rows[0]?.result.status !== "approved") throw new Error("F10.18: zweite Freigabe fehlt.");

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

// Uebernommen aus tests/db/f1017-portal-my-files.test.ts (seedFixture):
// Workspace + Editor/Viewer/Extern + Kontakt/Standort/Projekt.
type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  projectId: string;
};

async function seedFixture(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1018.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1018.test`}),
             (${externalId}::uuid, ${`extern-${externalId}@f1018.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
              'viewer', '{"external_only": true}'::jsonb)
    `);
  });
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F10', 'Fixture',
        ${`${contactId}@f1018.test`}, ${`${contactId}@f1018.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${`${label} Site`})
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             ${label}, 'fixture'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
        and intake_column.board_id = board.id
        and intake_column.is_intake = true
        and intake_column.archived_at is null
      where board.workspace_id = ${workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null
    `);
  });
  return { workspaceId, editorId, viewerId, externalId, projectId };
}

async function createInvite(
  workspaceId: string,
  actorId: string,
  projectId: string,
): Promise<{ token: string; inviteId: string }> {
  const invite = await withAuthorizedTenantOn(
    testPool, actorId, workspaceId,
    (tx, serviceCtx) => createPortalInvite(tx, serviceCtx, {
      schemaVersion: PORTAL_INVITE_CREATE_VERSION,
      workspaceId,
      projectId,
      ttlDays: 14,
    }),
  );
  return { token: invite.token, inviteId: invite.inviteId };
}

type DownloadRow = {
  portal_invite_id: string;
  issuance_id: string | null;
  project_file_id: string | null;
};

async function downloadRows(workspaceId: string): Promise<DownloadRow[]> {
  const result = await tenantQuery<DownloadRow>(
    workspaceId,
    null,
    `select portal_invite_id, issuance_id, project_file_id
       from portal_download_log where workspace_id = $1::uuid
       order by downloaded_at, id`,
    [workspaceId],
  );
  return result.rows;
}

async function downloadCount(workspaceId: string): Promise<number> {
  return (await downloadRows(workspaceId)).length;
}

async function uploadVisibleFile(fx: Fixture, filename: string): Promise<string> {
  const { fileId } = await withAuthorizedTenantOn(
    testPool, fx.editorId, fx.workspaceId,
    (tx, ctx) => uploadProjectFile(tx, ctx, {
      projectId: fx.projectId,
      bytes: PDF_MINIMAL,
      filename,
      contentType: "application/pdf",
    }),
  );
  await withAuthorizedTenantOn(
    testPool, fx.editorId, fx.workspaceId,
    (tx, ctx) => setProjectFileVisibility(tx, ctx, {
      projectId: fx.projectId,
      fileId,
      visible: true,
    }),
  );
  return fileId;
}

describe("F10-18 My-Files-Download-Protokoll (PostgreSQL + LocalStorage)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture(`F1018 ${randomUUID()}`);
  });

  it("D-01: sichtbarer Download schreibt genau eine Datei-Zeile, 2 Downloads → 2 Zeilen", async () => {
    const fileId = await uploadVisibleFile(fixture, "Plan.pdf");
    const { token } = await createInvite(fixture.workspaceId, fixture.editorId, fixture.projectId);

    expect(await downloadCount(fixture.workspaceId)).toBe(0);
    const first = await readPortalProjectFileByToken(testPool, { token, fileId });
    expect(first.bytes.equals(PDF_MINIMAL)).toBe(true);
    await readPortalProjectFileByToken(testPool, { token, fileId });

    const rows = await downloadRows(fixture.workspaceId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.project_file_id).toBe(fileId);
      expect(row.issuance_id).toBeNull();
    }
    expect(rows[1]!.portal_invite_id).toBe(rows[0]!.portal_invite_id);
  });

  it("D-02: Fehlschlaege schreiben nichts (unsichtbar, fremd, tot, entzogen)", async () => {
    const fileId = await uploadVisibleFile(fixture, "Plan.pdf");
    const { token, inviteId } = await createInvite(fixture.workspaceId, fixture.editorId, fixture.projectId);

    // Unsichtbar: als gaebe es sie nicht (kein Orakel).
    const { fileId: hiddenId } = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "intern.pdf",
        contentType: "application/pdf",
      }),
    );
    await expect(readPortalProjectFileByToken(testPool, { token, fileId: hiddenId }))
      .rejects.toBeInstanceOf(ProjectFileNotFoundError);
    // Fremde Datei, fremdes Projekt-Token, unbekanntes Token.
    await expect(readPortalProjectFileByToken(testPool, { token, fileId: randomUUID() }))
      .rejects.toBeInstanceOf(ProjectFileNotFoundError);
    const other = await seedFixture(`F1018-fremd ${randomUUID()}`);
    const { token: otherToken } = await createInvite(other.workspaceId, other.editorId, other.projectId);
    await expect(readPortalProjectFileByToken(testPool, { token: otherToken, fileId }))
      .rejects.toBeInstanceOf(ProjectFileNotFoundError);
    await expect(readPortalProjectFileByToken(testPool, { token: "toter-token-f1018", fileId }))
      .rejects.toBeInstanceOf(ProjectFileNotFoundError);
    expect(await downloadCount(fixture.workspaceId)).toBe(0);
    expect(await downloadCount(other.workspaceId)).toBe(0);

    // Zurueckgezogen: echter Withdraw via Service → NotFound, keine Zeile.
    // (Ablauf ist nicht simulierbar: expires_at ist trigger-geschuetzt
    // immutable — 0056-Guard — und faellt in denselben Fail-closed-Zweig
    // `status <> 'active' OR expires_at <= mutation_time`.)
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, serviceCtx) => withdrawPortalInvite(tx, serviceCtx, {
        schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
        workspaceId: fixture.workspaceId,
        inviteId,
        reason: "user_request",
      }),
    );
    await expect(readPortalProjectFileByToken(testPool, { token, fileId }))
      .rejects.toBeInstanceOf(ProjectFileNotFoundError);
    expect(await downloadCount(fixture.workspaceId)).toBe(0);
  });

  it("D-03: CHECK genau-eine (beide NULL / beide gesetzt → 23514) + FK", async () => {
    const fileId = await uploadVisibleFile(fixture, "Plan.pdf");
    const { inviteId } = await createInvite(fixture.workspaceId, fixture.editorId, fixture.projectId);

    // Beide NULL → kein Target, kein Protokoll.
    await expect(tenantQuery(
      fixture.workspaceId, null,
      `insert into portal_download_log (workspace_id, portal_invite_id)
       values ($1::uuid, $2::uuid)`,
      [fixture.workspaceId, inviteId],
    )).rejects.toMatchObject({ code: "23514" });
    // Beide gesetzt → Mischzeile verboten.
    await expect(tenantQuery(
      fixture.workspaceId, null,
      `insert into portal_download_log (workspace_id, portal_invite_id, issuance_id, project_file_id)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [fixture.workspaceId, inviteId, randomUUID(), fileId],
    )).rejects.toMatchObject({ code: "23514" });
    // Nichtexistente Datei → FK-Verletzung.
    await expect(tenantQuery(
      fixture.workspaceId, null,
      `insert into portal_download_log (workspace_id, portal_invite_id, project_file_id)
       values ($1::uuid, $2::uuid, $3::uuid)`,
      [fixture.workspaceId, inviteId, randomUUID()],
    )).rejects.toMatchObject({ code: "23503" });
    expect(await downloadCount(fixture.workspaceId)).toBe(0);
  });

  it("D-04: getPortalStatus downloadCount = Angebots- + My-Files-Downloads (Misch-Summe)", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const { fileId } = await withAuthorizedTenantOn(
      testPool, ctx.actorId, workspaceId,
      (tx, serviceCtx) => uploadProjectFile(tx, serviceCtx, {
        projectId: ctx.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    await withAuthorizedTenantOn(
      testPool, ctx.actorId, workspaceId,
      (tx, serviceCtx) => setProjectFileVisibility(tx, serviceCtx, {
        projectId: ctx.projectId,
        fileId,
        visible: true,
      }),
    );
    const { token } = await createInvite(workspaceId, ctx.actorId, ctx.projectId);

    await readPortalDocumentArtifactByToken(testPool, { token, issuanceId: ctx.issuanceId });
    await readPortalProjectFileByToken(testPool, { token, fileId });

    const rows = await downloadRows(workspaceId);
    expect(rows).toHaveLength(2);
    const issuanceRows = rows.filter((row) => row.issuance_id === ctx.issuanceId);
    const fileRows = rows.filter((row) => row.project_file_id === fileId);
    expect(issuanceRows).toHaveLength(1);
    expect(issuanceRows[0]!.project_file_id).toBeNull();
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]!.issuance_id).toBeNull();

    const status = await withAuthorizedTenantOn(
      testPool, ctx.actorId, workspaceId,
      (tx, serviceCtx) => getPortalStatus(tx, serviceCtx, {
        workspaceId,
        projectId: ctx.projectId,
      }),
    );
    expect(status.active?.downloadCount).toBe(2);
  });

  it("D-05: Angebots-Regression — Issuance-Download schreibt weiterhin issuance-Zeile", async () => {
    const workspaceId = randomUUID();
    const ctx = await buildApprovedIssuance(workspaceId);
    const { token } = await createInvite(workspaceId, ctx.actorId, ctx.projectId);

    const artifact = await readPortalDocumentArtifactByToken(testPool, {
      token,
      issuanceId: ctx.issuanceId,
    });
    expect(artifact.bytes.equals(ctx.artifact)).toBe(true);

    const rows = await downloadRows(workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.issuance_id).toBe(ctx.issuanceId);
    expect(rows[0]!.project_file_id).toBeNull();
  });

  it("D-06: RLS — fremder Workspace liest keine My-Files-Log-Zeilen", async () => {
    const fileId = await uploadVisibleFile(fixture, "Plan.pdf");
    const { token } = await createInvite(fixture.workspaceId, fixture.editorId, fixture.projectId);
    await readPortalProjectFileByToken(testPool, { token, fileId });
    expect(await downloadCount(fixture.workspaceId)).toBe(1);

    const other = await seedFixture(`F1018-rls ${randomUUID()}`);
    const foreign = await tenantQuery<{ portal_invite_id: string }>(
      other.workspaceId,
      null,
      `select portal_invite_id from portal_download_log`,
    );
    expect(foreign.rows).toHaveLength(0);
  });
});
