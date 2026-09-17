import { createHash, randomUUID } from "node:crypto";

import {
  state as fixtureState,
} from "./m1-11g-fixture";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

// F10-07-Fixture (extrahiert aus f10-07-portal-dokument-download.spec.ts,
// byte-identische Logik): freigegebene Issuance per SQL-Seed. Replica-Rolle
// umgeht nur FKs/Trigger, Checks bleiben aktiv. Genutzt von F10-07 und
// DASH-VG-38 (Portal mit befuellten Dokumentzeilen).

export type F1007E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
};

export function state(): F1007E2EState {
  const full = fixtureState();
  for (const key of ["databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F10-07-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as F1007E2EState;
}

export const OFFER_NUMBER = "ANG-2026-000071";
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

export async function seedApprovedIssuance(
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
