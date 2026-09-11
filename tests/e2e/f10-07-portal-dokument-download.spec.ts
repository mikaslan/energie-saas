import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { expect, test, type Download, type Page } from "playwright/test";

import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F10-07 Portal-Dokument-Download (My-Files-Rest) — Chromium-E2E.
 *
 * Durchgängig im isolierten Workspace (f101/f102 behaupten leere
 * Dokumente und dürfen nicht berührt werden): Lead → Projekt → Portal-Link
 * per UI → freigegebene Issuance per SQL-Seed (Replica-Rolle umgeht nur
 * FKs/Trigger, Checks bleiben aktiv) → Übersicht zeigt Download-Link →
 * Klick liefert exakt das versiegelte PDF (Header wie interner Pfad) →
 * unbekannte Issuance 404 ohne Orakel. Keine Browser-Fehler.
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
};

function state(): E2EState {
  const full = fixtureState();
  for (const key of ["databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F10-07-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const OFFER_NUMBER = "ANG-2026-000071";
const DOCUMENT_DATE = "2026-09-11";
const VALID_THROUGH = "2026-09-25";
const HEX_64_ZERO = "0".repeat(64);
const CANDIDATE_RENDERER_RECIPE =
  `offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-${HEX_64_ZERO}`;
const ISSUANCE_RENDERER_RECIPE =
  `offer-issuance-renderer-recipe.v1-linux-amd64-pw1.62.1-${HEX_64_ZERO}`;

function pdfBytes(): Buffer {
  return Buffer.from(`%PDF-1.4\n${"F1007-E2E-Beleg\n".repeat(6)}%%EOF\n`, "utf8");
}

async function seedApprovedIssuance(
  workspaceId: string,
  projectId: string,
  editorId: string,
): Promise<{ issuanceId: string; artifact: Buffer }> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const issuanceId = randomUUID();
    const artifact = pdfBytes();
    const artifactShaHex = createHash("sha256").update(artifact).digest("hex");
    const now = new Date().toISOString();
    const approvedAt = new Date(Date.now() - 3_600_000).toISOString();
    const ids = {
      offerId: randomUUID(),
      candidateId: randomUUID(),
      candidateApprovalId: randomUUID(),
      variantId: randomUUID(),
      variantRevisionId: randomUUID(),
      profileActivationId: randomUUID(),
      profileId: randomUUID(),
      profileRevisionId: randomUUID(),
      recipientId: randomUUID(),
      recipientRevisionId: randomUUID(),
      artifactVersion: randomUUID(),
      candidateArtifactVersion: randomUUID(),
      secondApproverId: randomUUID(),
    };
    const snapshot = {
      schemaVersion: "offer-issuance-input.v1",
      canonicalizationVersion: "offer-jcs.v1",
      templateVersion: "offer-issuance-template.v1",
      rendererRecipeVersion: ISSUANCE_RENDERER_RECIPE,
      artifactIntent: "offer_issuance_final",
      issuanceId,
      preparedAt: now,
      source: {
        workspaceId,
        projectId,
        offerId: ids.offerId,
        candidateId: ids.candidateId,
        candidateApprovalId: ids.candidateApprovalId,
        candidateApprovedAt: approvedAt,
        candidateArtifactVersion: ids.candidateArtifactVersion,
        candidateArtifactMimeType: "application/pdf",
        candidateArtifactSha256: HEX_64_ZERO,
        candidateArtifactSizeBytes: 175,
        candidateInputVersion: "offer-release-candidate-input.v1",
        candidateCanonicalizationVersion: "offer-jcs.v1",
        candidateTemplateVersion: "offer-release-candidate-template.v1",
        candidateRendererRecipeVersion: CANDIDATE_RENDERER_RECIPE,
        candidateInputSha256: HEX_64_ZERO,
        candidateApprovalVersion: "offer-release-candidate-approval.v1",
        candidateApprovalCommandVersion: "offer-release-approval-command.v1",
        variant: {
          id: ids.variantId,
          revisionId: ids.variantRevisionId,
          revision: 1,
          snapshotSha256: HEX_64_ZERO,
        },
        profile: {
          activationId: ids.profileActivationId,
          id: ids.profileId,
          revisionId: ids.profileRevisionId,
          revision: 1,
          snapshotSha256: HEX_64_ZERO,
        },
        recipient: {
          id: ids.recipientId,
          revisionId: ids.recipientRevisionId,
          revision: 1,
          snapshotSha256: HEX_64_ZERO,
        },
      },
      document: {
        offerNumber: OFFER_NUMBER,
        documentDate: DOCUMENT_DATE,
        validThrough: VALID_THROUGH,
        variant: { revision: 1 },
        profile: { revision: 1 },
        sections: [{}],
      },
    };
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Replica umgeht nur FKs/Trigger (unvermeidbar ohne Ketten-Setup);
      // alle Check-Constraints bleiben aktiv und werden geprüft.
      await client.query("set local session_replication_role = replica");
      await client.query(
        `insert into offer_issuance (
           id, workspace_id, project_id, offer_id, offer_number,
           candidate_id, candidate_approval_id, candidate_approved_by, candidate_approved_at,
           candidate_input_version, candidate_canonicalization_version,
           candidate_template_version, candidate_renderer_recipe_version,
           candidate_input_sha256, candidate_approval_version,
           candidate_approval_command_version, candidate_artifact_mime_type,
           candidate_artifact_sha256, candidate_artifact_size_bytes, candidate_artifact_version,
           variant_id, variant_revision_id, variant_revision, variant_snapshot_sha256,
           profile_activation_id, profile_id, profile_revision_id, profile_revision, profile_snapshot_sha256,
           recipient_id, recipient_revision_id, recipient_revision, recipient_snapshot_sha256,
           prepared_at, created_at, document_date, valid_through,
           artifact_intent, input_version, canonicalization_version, template_version, renderer_recipe_version,
           reservation_key, input_snapshot,
           input_sha256, has_zero_tax_treatment, state,
           artifact_mime_type, artifact_sha256, artifact_size_bytes, artifact_bytes, artifact_version,
           started_at, finished_at, created_by
         ) values (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text,
           $27::uuid, $28::uuid, $6::uuid, $7::timestamptz,
           'offer-release-candidate-input.v1', 'offer-jcs.v1',
           'offer-release-candidate-template.v1', $8::text,
           decode($9::text, 'hex'), 'offer-release-candidate-approval.v1',
           'offer-release-approval-command.v1', 'application/pdf',
           decode($9::text, 'hex'), 175, $10::uuid,
           $11::uuid, $12::uuid, 1, decode($9::text, 'hex'),
           $13::uuid, $14::uuid, $15::uuid, 1, decode($9::text, 'hex'),
           $16::uuid, $17::uuid, 1, decode($9::text, 'hex'),
           $18::timestamptz, $18::timestamptz, $19::date, $20::date,
           'offer_issuance_final', 'offer-issuance-input.v1', 'offer-jcs.v1',
           'offer-issuance-template.v1', $21::text,
           decode($9::text, 'hex'), $22::jsonb,
           pg_catalog.sha256(convert_to(public.canonicalize_offer_json_v1($22::jsonb), 'UTF8')),
           false, 'ready_for_approval',
           'application/pdf', decode($23::text, 'hex'), $24::integer, $25::bytea, $26::uuid,
           $18::timestamptz, $18::timestamptz, $6::uuid
         )`,
        [
          issuanceId, workspaceId, projectId, ids.offerId, OFFER_NUMBER,
          editorId, approvedAt, CANDIDATE_RENDERER_RECIPE, HEX_64_ZERO,
          ids.candidateArtifactVersion, ids.variantId, ids.variantRevisionId,
          ids.profileActivationId, ids.profileId, ids.profileRevisionId,
          ids.recipientId, ids.recipientRevisionId, now, DOCUMENT_DATE,
          VALID_THROUGH, ISSUANCE_RENDERER_RECIPE, JSON.stringify(snapshot),
          artifactShaHex, artifact.byteLength, artifact, ids.artifactVersion,
          ids.candidateId, ids.candidateApprovalId,
        ],
      );
      for (const approver of [editorId, ids.secondApproverId]) {
        await client.query(
          `insert into offer_issuance_approval (
             workspace_id, issuance_id, project_id, offer_id, candidate_id,
             candidate_approval_id, candidate_approved_by,
             artifact_intent, input_version, canonicalization_version,
             template_version, renderer_recipe_version,
             input_sha256, has_zero_tax_treatment,
             artifact_mime_type, artifact_sha256, artifact_size_bytes, artifact_version,
             approval_version, approval_command_version, approval_command,
             recipient_and_scope_reviewed, commercial_totals_reviewed,
             legal_profile_reviewed, final_pdf_for_archive_understood,
             approved_by
           ) values (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $12::uuid,
             $13::uuid, $5::uuid,
             'offer_issuance_final', 'offer-issuance-input.v1', 'offer-jcs.v1',
             'offer-issuance-template.v1', $6::text,
             decode($7::text, 'hex'), false,
             'application/pdf', decode($8::text, 'hex'), $9::integer, $10::uuid,
             'offer-issuance-approval.v1', 'offer-issuance-approval-command.v1',
             jsonb_build_object(
               'schemaVersion', 'offer-issuance-approval-command.v1',
               'issuanceId', $2::uuid::text,
               'recipientAndScopeReviewed', true,
               'commercialTotalsReviewed', true,
               'legalProfileReviewed', true,
               'finalPdfForArchiveUnderstood', true
             ),
             true, true, true, true,
             $11::uuid
           )`,
          [
            workspaceId, issuanceId, projectId, ids.offerId, editorId,
            ISSUANCE_RENDERER_RECIPE, HEX_64_ZERO, artifactShaHex,
            artifact.byteLength, ids.artifactVersion, approver,
            ids.candidateId, ids.candidateApprovalId,
          ],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { issuanceId, artifact };
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function otpFromPrivateDevMailLog(
  logPath: string,
  email: string,
  byteOffset: number,
): Promise<string> {
  const deadline = Date.now() + 12_000;
  const pattern = new RegExp(
    `\\[dev-mail\\] an ${escapeRegExp(email)}: Dein Login-Code\\s+Code: (\\d{6})`,
    "u",
  );
  while (Date.now() < deadline) {
    const log = readFileSync(logPath);
    const tail = log.subarray(Math.min(byteOffset, log.byteLength)).toString("utf8");
    const match = pattern.exec(tail);
    if (match) return match[1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.pathname).toBe("/login");
  expect(current.searchParams.get("next")).toBe(expectedPath);

  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset));
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST");
  try {
    await page.getByRole("button", { name: "Anmelden" }).click();
    expect((await signInResponsePromise).status()).toBe(200);
  } finally {
    if (await otpInput.isVisible().catch(() => false)) {
      await otpInput.fill("").catch(() => undefined);
    }
  }
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function bytesFromDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  if (stream === null) throw new Error("F10-07: Download-Stream fehlt.");
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("F10-07-E2E-01: Portal-Dokument herunterladen, 404 ohne Orakel", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);

  // 1) Projekt per manueller Anfrage (F1-11-Muster wie F1-12-E2E).
  await page.getByTestId("manual-lead-open").click();
  const leadForm = page.getByTestId("manual-lead-form");
  await leadForm.getByLabel("Name *").fill("E2E Dateien");
  await leadForm.getByLabel("Telefon").fill("0151 45678907");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const projectPath = new URL(page.url()).pathname;
  const projectId = projectPath.split("/").pop() ?? "";
  expect(projectId).toMatch(/^[0-9a-f-]{36}$/u);

  // 2) Portal-Link per UI (F10-06-Muster).
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  // 3) Freigegebene Issuance seeden (isolierter Workspace, keine
  // Nachbar-Berührung).
  const { issuanceId, artifact } = await seedApprovedIssuance(workspaceId, projectId, actorId);

  // 4) Übersicht zeigt Download-Link; Klick liefert das versiegelte PDF.
  await page.goto(tokenPath);
  const offerRow = page.locator("li", { hasText: `Angebot ${OFFER_NUMBER}` });
  await expect(offerRow).toBeVisible();
  const downloadLink = offerRow.getByRole("link", { name: "Herunterladen", exact: true });
  await expect(downloadLink).toHaveAttribute(
    "href",
    `${tokenPath}/dokumente/${issuanceId}?lang=de`,
  );
  const expectedFilename = `${OFFER_NUMBER}-Ausstellungsfassung.pdf`;
  const [downloadResponse, download] = await Promise.all([
    page.waitForResponse((response) =>
      response.request().method() === "GET"
      && new URL(response.url()).pathname === `${tokenPath}/dokumente/${issuanceId}`),
    page.waitForEvent("download"),
    downloadLink.click(),
  ]);
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe(expectedFilename);
  const downloadedBytes = await bytesFromDownload(download);
  expect(downloadedBytes.equals(artifact)).toBe(true);
  const headers = downloadResponse.headers();
  expect(downloadResponse.status()).toBe(200);
  expect(headers["content-type"]).toBe("application/pdf");
  expect(headers["content-length"]).toBe(String(artifact.byteLength));
  expect(headers["content-disposition"]).toBe(
    `attachment; filename="${expectedFilename}"; filename*=UTF-8''${encodeURIComponent(expectedFilename)}`,
  );
  expect(headers["cache-control"]).toBe("private, no-store, max-age=0");

  // 5) Unbekannte Issuance: 404 ohne Orakel (gleicher Endzustand wie
  // toter Link, keine Inhalte).
  const unknownResponse = await page.request.get(`${tokenPath}/dokumente/${randomUUID()}`);
  expect(unknownResponse.status()).toBe(404);

  expect(errors, "Browser-Konsole und Page-Errors des Downloads").toEqual([]);
});
