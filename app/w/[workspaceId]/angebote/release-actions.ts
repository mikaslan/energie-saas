"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  authorizedOfferMutationAction,
  NotAuthenticatedError,
} from "@/lib/action";
import {
  OFFER_RECIPIENT_REVISE_COMMAND_VERSION,
  OFFER_RELEASE_APPROVAL_COMMAND_VERSION,
  OFFER_RELEASE_CANDIDATE_REQUEST_VERSION,
} from "@/lib/integrations/offers/release-contract";
import { PermissionDeniedError } from "@/lib/permissions";
import type { OfferReleaseActionState } from "./release-action-state";

type OfferServicesModule = typeof import("@/modules/offers");
type OfferAdmissionModule = typeof import("@/lib/integrations/offers/admission");

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;
const NONNEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const WORKSPACE_ID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const CHECKED_SCHEMA = z.literal("true").transform(() => true as const);
const NULLABLE_TEXT_SCHEMA = z.string().transform((value) => {
  const normalized = value.normalize("NFC").trim();
  return normalized === "" ? null : normalized;
});

const RECIPIENT_FIELDS = new Set([
  "schemaVersion",
  "workspaceId",
  "offerId",
  "expectedCurrentRevision",
  "displayName",
  "company",
  "email",
  "street",
  "houseNumber",
  "postalCode",
  "city",
  "country",
  "billingDetailsConfirmed",
]);
const CANDIDATE_FIELDS = new Set([
  "schemaVersion",
  "workspaceId",
  "offerId",
  "variantId",
  "expectedVariantRevision",
  "sourcePdfDraftId",
  "documentProfileId",
  "documentProfileRevisionId",
  "expectedDocumentProfileRevision",
  "recipientRevisionId",
  "expectedRecipientRevision",
  "validThrough",
]);
const APPROVAL_REQUIRED_FIELDS = new Set([
  "schemaVersion",
  "workspaceId",
  "offerId",
  "candidateId",
  "expectedArtifactVersion",
  "recipientBillingReviewed",
  "commercialContentReviewed",
  "activeProfileReviewed",
  "notIssuedStatusUnderstood",
]);
const APPROVAL_OPTIONAL_FIELDS = new Set(["zeroTaxTreatmentReviewed"]);

const recipientFormSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_RECIPIENT_REVISE_COMMAND_VERSION),
  workspaceId: WORKSPACE_ID_SCHEMA,
  offerId: UUID_SCHEMA,
  expectedCurrentRevision: z.string().regex(NONNEGATIVE_INTEGER_PATTERN)
    .transform(Number).pipe(z.int().safe().min(0)),
  displayName: z.string(),
  company: NULLABLE_TEXT_SCHEMA,
  email: z.string(),
  street: z.string(),
  houseNumber: z.string(),
  postalCode: z.string(),
  city: z.string(),
  country: z.literal("DE"),
  billingDetailsConfirmed: CHECKED_SCHEMA,
});

const candidateFormSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_RELEASE_CANDIDATE_REQUEST_VERSION),
  workspaceId: WORKSPACE_ID_SCHEMA,
  offerId: UUID_SCHEMA,
  variantId: UUID_SCHEMA,
  expectedVariantRevision: z.string().regex(POSITIVE_INTEGER_PATTERN)
    .transform(Number).pipe(z.int().safe().min(1)),
  sourcePdfDraftId: UUID_SCHEMA,
  documentProfileId: UUID_SCHEMA,
  documentProfileRevisionId: UUID_SCHEMA,
  expectedDocumentProfileRevision: z.string().regex(POSITIVE_INTEGER_PATTERN)
    .transform(Number).pipe(z.int().safe().min(1)),
  recipientRevisionId: UUID_SCHEMA,
  expectedRecipientRevision: z.string().regex(POSITIVE_INTEGER_PATTERN)
    .transform(Number).pipe(z.int().safe().min(1)),
  validThrough: z.iso.date(),
});

const approvalFormSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_RELEASE_APPROVAL_COMMAND_VERSION),
  workspaceId: WORKSPACE_ID_SCHEMA,
  offerId: UUID_SCHEMA,
  candidateId: UUID_SCHEMA,
  expectedArtifactVersion: UUID_SCHEMA,
  recipientBillingReviewed: CHECKED_SCHEMA,
  commercialContentReviewed: CHECKED_SCHEMA,
  activeProfileReviewed: CHECKED_SCHEMA,
  notIssuedStatusUnderstood: CHECKED_SCHEMA,
  zeroTaxTreatmentReviewed: CHECKED_SCHEMA.optional(),
});

function workspaceForAdmission(formData: FormData): string | null {
  const values = formData.getAll("workspaceId");
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  const parsed = WORKSPACE_ID_SCHEMA.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}

function submittedRecipientRevision(formData: FormData): number | null {
  const values = formData.getAll("expectedCurrentRevision");
  if (
    values.length !== 1
    || typeof values[0] !== "string"
    || !NONNEGATIVE_INTEGER_PATTERN.test(values[0])
  ) return null;
  const revision = Number(values[0]);
  return Number.isSafeInteger(revision) ? revision : null;
}

function bindSubmittedRecipientRevision(
  state: OfferReleaseActionState,
  revision: number | null,
): OfferReleaseActionState {
  return { ...state, submittedRecipientRevision: revision };
}

function exactStringEntries(
  formData: FormData,
  requiredFields: ReadonlySet<string>,
  optionalFields: ReadonlySet<string> = new Set(),
): Record<string, string> | null {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
    if (name.startsWith("$ACTION")) {
      if (!REACT_ACTION_FIELD_PATTERN.test(name)) return null;
      values.set(name, value);
      continue;
    }
    if (!requiredFields.has(name) && !optionalFields.has(name)) return null;
    values.set(name, value);
  }
  const domainEntries = [...values].filter(([name]) => !name.startsWith("$ACTION"));
  const optionalCount = [...optionalFields].filter((name) => values.has(name)).length;
  if (
    domainEntries.length !== requiredFields.size + optionalCount
    || ![...requiredFields].every((name) => values.has(name))
  ) return null;
  return Object.fromEntries(domainEntries);
}

function mapReleaseError(
  error: unknown,
  offerServices: OfferServicesModule,
  offerAdmission: OfferAdmissionModule,
): OfferReleaseActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof offerServices.OfferReleaseValidationError) {
    return error.paths.length === 0
      ? { status: "invalid" }
      : { status: "invalid", paths: error.paths };
  }
  if (error instanceof offerServices.OfferReleaseProfileValidationError) {
    return error.paths.length === 0
      ? { status: "invalid" }
      : { status: "invalid", paths: error.paths };
  }
  if (
    error instanceof offerServices.OfferReleaseNotFoundError
    || error instanceof offerServices.OfferReleaseProfileNotFoundError
  ) return { status: "not_found" };
  if (error instanceof offerServices.OfferReleaseConflictError) {
    return {
      status: "conflict",
      code: error.code,
      ...(error.currentRevision === undefined
        ? {}
        : { currentRevision: error.currentRevision }),
    };
  }
  if (error instanceof offerServices.OfferReleaseProfileConflictError) {
    return error.currentRevision === undefined
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  if (error instanceof offerAdmission.OfferRateLimitError) {
    return { status: "unavailable", retryAfter: error.retryAfter };
  }
  if (
    error instanceof offerServices.OfferReleaseIntegrityError
    || error instanceof offerServices.OfferReleasePersistenceError
    || error instanceof offerServices.OfferReleaseDispatchError
    || error instanceof offerServices.OfferReleaseProfileIntegrityError
    || error instanceof offerServices.OfferReleaseProfilePersistenceError
  ) return { status: "unavailable" };
  return null;
}

async function releaseDependencies() {
  return Promise.all([
    import("@/modules/offers"),
    import("@/lib/integrations/offers/admission"),
  ]);
}

export async function reviseOfferRecipientAction(
  _previousState: OfferReleaseActionState,
  formData: FormData,
): Promise<OfferReleaseActionState> {
  const submittedRevision = submittedRecipientRevision(formData);
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) {
    return bindSubmittedRecipientRevision({ status: "invalid" }, submittedRevision);
  }
  const [offerServices, offerAdmission] = await releaseDependencies();
  try {
    const result = await authorizedOfferMutationAction(
      workspaceId,
      ["offer.release.prepare"],
      "offer_recipient",
      async (tx, ctx) => {
        const entries = exactStringEntries(formData, RECIPIENT_FIELDS);
        const parsed = entries === null ? null : recipientFormSchema.safeParse(entries);
        if (!parsed || !parsed.success) {
          throw new offerServices.OfferReleaseProfileValidationError();
        }
        const input = parsed.data;
        return offerServices.reviseOfferRecipient(tx, ctx, {
          schemaVersion: input.schemaVersion,
          workspaceId: input.workspaceId,
          offerId: input.offerId,
          expectedCurrentRevision: input.expectedCurrentRevision,
          displayName: input.displayName,
          company: input.company,
          email: input.email,
          billingAddress: {
            street: input.street,
            houseNumber: input.houseNumber,
            postalCode: input.postalCode,
            city: input.city,
            country: input.country,
          },
          billingDetailsConfirmed: input.billingDetailsConfirmed,
        });
      },
    );
    revalidatePath(`/w/${workspaceId}/angebote/${result.snapshot.offerId}`);
    return bindSubmittedRecipientRevision({
      status: "recipient_saved",
      recipientRevisionId: result.recipientRevisionId,
      recipientRevision: result.revision,
    }, submittedRevision);
  } catch (error) {
    const mapped = mapReleaseError(error, offerServices, offerAdmission);
    if (mapped) return bindSubmittedRecipientRevision(mapped, submittedRevision);
    throw error;
  }
}

export async function requestOfferReleaseCandidateAction(
  _previousState: OfferReleaseActionState,
  formData: FormData,
): Promise<OfferReleaseActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  const [offerServices, offerAdmission] = await releaseDependencies();
  try {
    const result = await authorizedOfferMutationAction(
      workspaceId,
      ["offer.release.prepare"],
      "offer_release_candidate",
      async (tx, ctx) => {
        const entries = exactStringEntries(formData, CANDIDATE_FIELDS);
        const parsed = entries === null ? null : candidateFormSchema.safeParse(entries);
        if (!parsed || !parsed.success) throw new offerServices.OfferReleaseValidationError();
        return offerServices.requestOfferReleaseCandidate(tx, ctx, parsed.data);
      },
    );
    revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
    return {
      status: "candidate_requested",
      candidateId: result.candidateId,
      state: result.state,
      variantRevision: result.variantRevision,
      replayed: result.replayed,
    };
  } catch (error) {
    const mapped = mapReleaseError(error, offerServices, offerAdmission);
    if (mapped) return mapped;
    throw error;
  }
}

export async function approveOfferReleaseCandidateAction(
  _previousState: OfferReleaseActionState,
  formData: FormData,
): Promise<OfferReleaseActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  const [offerServices, offerAdmission] = await releaseDependencies();
  try {
    const result = await authorizedOfferMutationAction(
      workspaceId,
      ["offer.release.approve"],
      "offer_release_candidate_approval",
      async (tx, ctx) => {
        const entries = exactStringEntries(
          formData,
          APPROVAL_REQUIRED_FIELDS,
          APPROVAL_OPTIONAL_FIELDS,
        );
        const parsed = entries === null ? null : approvalFormSchema.safeParse(entries);
        if (!parsed || !parsed.success) throw new offerServices.OfferReleaseValidationError();
        return offerServices.approveOfferReleaseCandidate(tx, ctx, parsed.data);
      },
    );
    revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
    return {
      status: "candidate_approved",
      candidateId: result.candidateId,
      approvedAt: result.approvedAt,
      replayed: result.replayed,
    };
  } catch (error) {
    const mapped = mapReleaseError(error, offerServices, offerAdmission);
    if (mapped) return mapped;
    throw error;
  }
}
