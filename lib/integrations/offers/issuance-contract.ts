import { createHash } from "node:crypto";
import { z } from "zod";

import {
  OFFER_CANONICALIZATION_VERSION,
  canonicalizeOfferJson,
  type OfferContractResult,
} from "./contract";
import {
  OFFER_RELEASE_APPROVAL_COMMAND_VERSION,
  OFFER_RELEASE_CANDIDATE_APPROVAL_VERSION,
  OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
  OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
  OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
  hashOfferReleaseCandidateInput,
  offerReleaseCandidateInputV1Schema,
  validateOfferReleaseCandidateInput,
} from "./release-contract";

export const OFFER_ISSUANCE_REQUEST_VERSION = "offer-issuance-request.v1" as const;
export const OFFER_ISSUANCE_DISPATCH_VERSION = "offer-issuance-dispatch.v1" as const;
export const OFFER_ISSUANCE_INPUT_VERSION = "offer-issuance-input.v1" as const;
export const OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION =
  "offer-issuance-approval-command.v1" as const;
export const OFFER_ISSUANCE_APPROVAL_VERSION = "offer-issuance-approval.v1" as const;
export const OFFER_ISSUANCE_WITHDRAWAL_COMMAND_VERSION =
  "offer-issuance-withdrawal-command.v1" as const;
export const OFFER_ISSUANCE_WITHDRAWAL_VERSION = "offer-issuance-withdrawal.v1" as const;
export const OFFER_ISSUANCE_TEMPLATE_VERSION = "offer-issuance-template.v1" as const;
export const OFFER_ISSUANCE_RENDERER_RECIPE_VERSION =
  "offer-issuance-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac" as const;
export const OFFER_ISSUANCE_ARTIFACT_INTENT = "offer_issuance_final" as const;

const MAX_PDF_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const positiveRevisionSchema = z.int().safe().min(1);
const utcDateTimeSchema = z.iso.datetime({ offset: true }).regex(/Z$/u);
const sha256Schema = z.string().regex(SHA256_PATTERN);

export const offerIssuanceRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_ISSUANCE_REQUEST_VERSION),
  workspaceId: uuidSchema,
  offerId: uuidSchema,
  candidateId: uuidSchema,
});

export type OfferIssuanceRequestV1 = z.infer<typeof offerIssuanceRequestV1Schema>;

export const offerIssuanceDispatchV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_ISSUANCE_DISPATCH_VERSION),
  workspaceId: uuidSchema,
  issuanceId: uuidSchema,
});

export type OfferIssuanceDispatchV1 = z.infer<typeof offerIssuanceDispatchV1Schema>;

export const offerIssuanceApprovalCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION),
  issuanceId: uuidSchema,
  recipientAndScopeReviewed: z.literal(true),
  commercialTotalsReviewed: z.literal(true),
  legalProfileReviewed: z.literal(true),
  finalPdfForArchiveUnderstood: z.literal(true),
  zeroTaxTreatmentReviewed: z.literal(true).optional(),
});

export type OfferIssuanceApprovalCommandV1 = z.infer<
  typeof offerIssuanceApprovalCommandV1Schema
>;

export const offerIssuanceWithdrawalReasonV1Schema = z.enum([
  "content_error",
  "recipient_error",
  "legal_text_error",
  "commercial_error",
  "other",
]);

export type OfferIssuanceWithdrawalReasonV1 = z.infer<
  typeof offerIssuanceWithdrawalReasonV1Schema
>;

export const offerIssuanceWithdrawalCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_ISSUANCE_WITHDRAWAL_COMMAND_VERSION),
  issuanceId: uuidSchema,
  reasonCode: offerIssuanceWithdrawalReasonV1Schema,
});

export type OfferIssuanceWithdrawalCommandV1 = z.infer<
  typeof offerIssuanceWithdrawalCommandV1Schema
>;

const buildSourceBindingSchema = z.strictObject({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  offerId: uuidSchema,
  candidateId: uuidSchema,
  candidateApprovalId: uuidSchema,
  candidateApprovedAt: utcDateTimeSchema,
  candidateArtifactVersion: uuidSchema,
  candidateArtifactSha256: sha256Schema,
  candidateArtifactSizeBytes: z.int().safe().min(100).max(MAX_PDF_BYTES),
  variantId: uuidSchema,
  variantRevisionId: uuidSchema,
  variantRevision: positiveRevisionSchema,
  variantSnapshotSha256: sha256Schema,
  profileActivationId: uuidSchema,
  profileId: uuidSchema,
  profileRevisionId: uuidSchema,
  profileRevision: positiveRevisionSchema,
  profileSnapshotSha256: sha256Schema,
  recipientId: uuidSchema,
  recipientRevisionId: uuidSchema,
  recipientRevision: positiveRevisionSchema,
  recipientSnapshotSha256: sha256Schema,
});

export type BuildOfferIssuanceSourceBinding = z.infer<typeof buildSourceBindingSchema>;

export const offerIssuanceSourceV1Schema = z.strictObject({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  offerId: uuidSchema,
  candidateId: uuidSchema,
  candidateApprovalId: uuidSchema,
  candidateApprovedAt: utcDateTimeSchema,
  candidateArtifactVersion: uuidSchema,
  candidateArtifactMimeType: z.literal("application/pdf"),
  candidateArtifactSha256: sha256Schema,
  candidateArtifactSizeBytes: z.int().safe().min(100).max(MAX_PDF_BYTES),
  candidateInputVersion: z.literal(OFFER_RELEASE_CANDIDATE_INPUT_VERSION),
  candidateCanonicalizationVersion: z.literal(OFFER_CANONICALIZATION_VERSION),
  candidateTemplateVersion: z.literal(OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION),
  candidateRendererRecipeVersion: z.literal(OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION),
  candidateInputSha256: sha256Schema,
  candidateApprovalVersion: z.literal(OFFER_RELEASE_CANDIDATE_APPROVAL_VERSION),
  candidateApprovalCommandVersion: z.literal(OFFER_RELEASE_APPROVAL_COMMAND_VERSION),
  variant: z.strictObject({
    id: uuidSchema,
    revisionId: uuidSchema,
    revision: positiveRevisionSchema,
    snapshotSha256: sha256Schema,
  }),
  profile: z.strictObject({
    activationId: uuidSchema,
    id: uuidSchema,
    revisionId: uuidSchema,
    revision: positiveRevisionSchema,
    snapshotSha256: sha256Schema,
  }),
  recipient: z.strictObject({
    id: uuidSchema,
    revisionId: uuidSchema,
    revision: positiveRevisionSchema,
    snapshotSha256: sha256Schema,
  }),
});

export type OfferIssuanceSourceV1 = z.infer<typeof offerIssuanceSourceV1Schema>;

const {
  schemaVersion: ignoredCandidateSchemaVersion,
  canonicalizationVersion: ignoredCandidateCanonicalizationVersion,
  templateVersion: ignoredCandidateTemplateVersion,
  rendererRecipeVersion: ignoredCandidateRendererRecipeVersion,
  documentStatus: ignoredCandidateDocumentStatus,
  ...issuanceDocumentShape
} = offerReleaseCandidateInputV1Schema.shape;
void ignoredCandidateSchemaVersion;
void ignoredCandidateCanonicalizationVersion;
void ignoredCandidateTemplateVersion;
void ignoredCandidateRendererRecipeVersion;
void ignoredCandidateDocumentStatus;

export const offerIssuanceDocumentV1Schema = z.strictObject(issuanceDocumentShape);

export type OfferIssuanceDocumentV1 = z.infer<typeof offerIssuanceDocumentV1Schema>;

function candidateInputFromIssuance(
  source: OfferIssuanceSourceV1,
  document: OfferIssuanceDocumentV1,
) {
  return {
    schemaVersion: source.candidateInputVersion,
    canonicalizationVersion: source.candidateCanonicalizationVersion,
    templateVersion: source.candidateTemplateVersion,
    rendererRecipeVersion: source.candidateRendererRecipeVersion,
    documentStatus: "not_issued" as const,
    ...document,
  };
}

export const offerIssuanceInputV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_ISSUANCE_INPUT_VERSION),
  canonicalizationVersion: z.literal(OFFER_CANONICALIZATION_VERSION),
  templateVersion: z.literal(OFFER_ISSUANCE_TEMPLATE_VERSION),
  rendererRecipeVersion: z.literal(OFFER_ISSUANCE_RENDERER_RECIPE_VERSION),
  artifactIntent: z.literal(OFFER_ISSUANCE_ARTIFACT_INTENT),
  issuanceId: uuidSchema,
  preparedAt: utcDateTimeSchema,
  source: offerIssuanceSourceV1Schema,
  document: offerIssuanceDocumentV1Schema,
}).superRefine((input, context) => {
  if (Date.parse(input.preparedAt) < Date.parse(input.source.candidateApprovedAt)) {
    context.addIssue({
      code: "custom",
      path: ["preparedAt"],
      message: "Ausstellungsfassung darf nicht vor der Candidate-Freigabe vorbereitet werden.",
    });
  }
  if (input.source.variant.revision !== input.document.variant.revision) {
    context.addIssue({
      code: "custom",
      path: ["document", "variant", "revision"],
      message: "Variantenrevision stimmt nicht mit der Quellenbindung ueberein.",
    });
  }
  if (input.source.profile.revision !== input.document.profile.revision) {
    context.addIssue({
      code: "custom",
      path: ["document", "profile", "revision"],
      message: "Profilrevision stimmt nicht mit der Quellenbindung ueberein.",
    });
  }
  const reconstructedCandidate = candidateInputFromIssuance(input.source, input.document);
  const candidateValidation = validateOfferReleaseCandidateInput(reconstructedCandidate);
  if (!candidateValidation.ok) {
    for (const pointer of candidateValidation.paths) {
      const candidatePath = pointer === "/"
        ? []
        : pointer.slice(1).split("/").map((part) => part
          .replaceAll("~1", "/")
          .replaceAll("~0", "~"));
      context.addIssue({
        code: "custom",
        path: ["document", ...candidatePath],
        message: "Dokumentinhalt verletzt den versiegelten Candidate-Vertrag.",
      });
    }
    return;
  }
  if (
    hashOfferReleaseCandidateInput(candidateValidation.value)
    !== input.source.candidateInputSha256
  ) {
    context.addIssue({
      code: "custom",
      path: ["source", "candidateInputSha256"],
      message: "Candidate-Input-Hash stimmt nicht mit dem Dokumentinhalt ueberein.",
    });
  }
});

export type OfferIssuanceInputV1 = z.infer<typeof offerIssuanceInputV1Schema>;

export type BuildOfferIssuanceInputOptions = {
  issuanceId: string;
  preparedAt: string;
  sourceBinding: BuildOfferIssuanceSourceBinding;
  candidateInput: unknown;
};

/**
 * Creates a new issuance input from a validated Candidate input. Candidate PDF
 * bytes are deliberately not accepted by this boundary and therefore cannot
 * be copied or promoted into an issuance artifact.
 */
export function buildOfferIssuanceInput({
  issuanceId,
  preparedAt,
  sourceBinding,
  candidateInput,
}: BuildOfferIssuanceInputOptions): OfferIssuanceInputV1 {
  const candidate = validateOfferReleaseCandidateInput(candidateInput);
  if (!candidate.ok) throw new TypeError("Ungueltiger Candidate-Input.");
  const sourceFields = buildSourceBindingSchema.safeParse(sourceBinding);
  if (!sourceFields.success) throw new TypeError("Ungueltige Candidate-Quellenbindung.");
  if (
    sourceFields.data.variantRevision !== candidate.value.variant.revision
    || sourceFields.data.profileRevision !== candidate.value.profile.revision
  ) throw new TypeError("Candidate-Quellenbindung weist Revisionsdrift auf.");

  const {
    schemaVersion: candidateInputVersion,
    canonicalizationVersion: candidateCanonicalizationVersion,
    templateVersion: candidateTemplateVersion,
    rendererRecipeVersion: candidateRendererRecipeVersion,
    documentStatus: ignoredDocumentStatus,
    ...document
  } = candidate.value;
  void ignoredDocumentStatus;
  const source = offerIssuanceSourceV1Schema.parse({
    workspaceId: sourceFields.data.workspaceId,
    projectId: sourceFields.data.projectId,
    offerId: sourceFields.data.offerId,
    candidateId: sourceFields.data.candidateId,
    candidateApprovalId: sourceFields.data.candidateApprovalId,
    candidateApprovedAt: sourceFields.data.candidateApprovedAt,
    candidateArtifactVersion: sourceFields.data.candidateArtifactVersion,
    candidateArtifactMimeType: "application/pdf",
    candidateArtifactSha256: sourceFields.data.candidateArtifactSha256,
    candidateArtifactSizeBytes: sourceFields.data.candidateArtifactSizeBytes,
    candidateInputVersion,
    candidateCanonicalizationVersion,
    candidateTemplateVersion,
    candidateRendererRecipeVersion,
    candidateInputSha256: hashOfferReleaseCandidateInput(candidate.value),
    candidateApprovalVersion: OFFER_RELEASE_CANDIDATE_APPROVAL_VERSION,
    candidateApprovalCommandVersion: OFFER_RELEASE_APPROVAL_COMMAND_VERSION,
    variant: {
      id: sourceFields.data.variantId,
      revisionId: sourceFields.data.variantRevisionId,
      revision: sourceFields.data.variantRevision,
      snapshotSha256: sourceFields.data.variantSnapshotSha256,
    },
    profile: {
      activationId: sourceFields.data.profileActivationId,
      id: sourceFields.data.profileId,
      revisionId: sourceFields.data.profileRevisionId,
      revision: sourceFields.data.profileRevision,
      snapshotSha256: sourceFields.data.profileSnapshotSha256,
    },
    recipient: {
      id: sourceFields.data.recipientId,
      revisionId: sourceFields.data.recipientRevisionId,
      revision: sourceFields.data.recipientRevision,
      snapshotSha256: sourceFields.data.recipientSnapshotSha256,
    },
  });
  const parsed = offerIssuanceInputV1Schema.safeParse({
    schemaVersion: OFFER_ISSUANCE_INPUT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    templateVersion: OFFER_ISSUANCE_TEMPLATE_VERSION,
    rendererRecipeVersion: OFFER_ISSUANCE_RENDERER_RECIPE_VERSION,
    artifactIntent: OFFER_ISSUANCE_ARTIFACT_INTENT,
    issuanceId,
    preparedAt,
    source,
    document,
  });
  if (!parsed.success) throw new TypeError("Ungueltiger Ausstellungsfassungs-Input.");
  return parsed.data;
}

function validationPaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => {
    if (issue.path.length === 0) return "/";
    return `/${issue.path.map((part) => String(part)
      .replaceAll("~", "~0")
      .replaceAll("/", "~1")).join("/")}`;
  }))].slice(0, 20);
}

export function validateOfferIssuanceInput(
  value: unknown,
): OfferContractResult<OfferIssuanceInputV1> {
  const parsed = offerIssuanceInputV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, paths: validationPaths(parsed.error) };
  return { ok: true, value: parsed.data };
}

export function hashOfferIssuanceInput(value: unknown): string {
  const parsed = offerIssuanceInputV1Schema.safeParse(value);
  if (!parsed.success) throw new TypeError("Ungueltiger Ausstellungsfassungs-Input.");
  return createHash("sha256")
    .update(canonicalizeOfferJson(parsed.data), "utf8")
    .digest("hex");
}
