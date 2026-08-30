"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  authorizedOfferMutationAction,
  NotAuthenticatedError,
} from "@/lib/action";
import {
  OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION,
  OFFER_ISSUANCE_REQUEST_VERSION,
  OFFER_ISSUANCE_WITHDRAWAL_COMMAND_VERSION,
  offerIssuanceWithdrawalReasonV1Schema,
} from "@/lib/integrations/offers/issuance-contract";
import { PermissionDeniedError } from "@/lib/permissions";
import type { OfferIssuanceActionState } from "./issuance-action-state";

type OfferServicesModule = typeof import("@/modules/offers");
type OfferAdmissionModule = typeof import("@/lib/integrations/offers/admission");

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const CHECKED_SCHEMA = z.literal("true").transform(() => true as const);

const REQUEST_FIELDS = new Set([
  "schemaVersion",
  "workspaceId",
  "offerId",
  "candidateId",
]);
const APPROVAL_REQUIRED_FIELDS = new Set([
  "schemaVersion",
  "workspaceId",
  "offerId",
  "issuanceId",
  "recipientAndScopeReviewed",
  "commercialTotalsReviewed",
  "legalProfileReviewed",
  "finalPdfForArchiveUnderstood",
]);
const APPROVAL_OPTIONAL_FIELDS = new Set(["zeroTaxTreatmentReviewed"]);
const WITHDRAWAL_FIELDS = new Set([
  "schemaVersion",
  "workspaceId",
  "offerId",
  "issuanceId",
  "withdrawalReasonCode",
]);

const requestFormSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_ISSUANCE_REQUEST_VERSION),
  workspaceId: UUID_SCHEMA,
  offerId: UUID_SCHEMA,
  candidateId: UUID_SCHEMA,
});
const approvalFormSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION),
  workspaceId: UUID_SCHEMA,
  offerId: UUID_SCHEMA,
  issuanceId: UUID_SCHEMA,
  recipientAndScopeReviewed: CHECKED_SCHEMA,
  commercialTotalsReviewed: CHECKED_SCHEMA,
  legalProfileReviewed: CHECKED_SCHEMA,
  finalPdfForArchiveUnderstood: CHECKED_SCHEMA,
  zeroTaxTreatmentReviewed: CHECKED_SCHEMA.optional(),
});
const withdrawalFormSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_ISSUANCE_WITHDRAWAL_COMMAND_VERSION),
  workspaceId: UUID_SCHEMA,
  offerId: UUID_SCHEMA,
  issuanceId: UUID_SCHEMA,
  withdrawalReasonCode: offerIssuanceWithdrawalReasonV1Schema,
});

function workspaceForAdmission(formData: FormData): string | null {
  const values = formData.getAll("workspaceId");
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  const parsed = UUID_SCHEMA.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
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

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => (
    issue.path.length === 0
      ? "/"
      : `/${issue.path.map((part) => String(part)
        .replaceAll("~", "~0")
        .replaceAll("/", "~1")).join("/")}`
  )))].slice(0, 20);
}

function mapIssuanceError(
  error: unknown,
  services: OfferServicesModule,
  admission: OfferAdmissionModule,
): OfferIssuanceActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof services.OfferIssuanceValidationError) {
    return error.paths.length === 0
      ? { status: "invalid" }
      : { status: "invalid", paths: error.paths };
  }
  if (error instanceof services.OfferIssuanceNotFoundError) return { status: "not_found" };
  if (error instanceof services.OfferIssuanceConflictError) {
    return { status: "conflict", code: error.code };
  }
  if (error instanceof admission.OfferRateLimitError) {
    return { status: "unavailable", retryAfter: error.retryAfter };
  }
  if (
    error instanceof services.OfferIssuanceIntegrityError
    || error instanceof services.OfferIssuancePersistenceError
    || error instanceof services.OfferIssuanceDispatchError
  ) return { status: "unavailable" };
  return null;
}

async function issuanceDependencies() {
  return Promise.all([
    import("@/modules/offers"),
    import("@/lib/integrations/offers/admission"),
  ]);
}

export async function requestOfferIssuanceAction(
  _previousState: OfferIssuanceActionState,
  formData: FormData,
): Promise<OfferIssuanceActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  const [services, admission] = await issuanceDependencies();
  try {
    const result = await authorizedOfferMutationAction(
      workspaceId,
      ["offer.issue.prepare"],
      "offer_issuance",
      async (tx, ctx) => {
        const entries = exactStringEntries(formData, REQUEST_FIELDS);
        if (entries === null) throw new services.OfferIssuanceValidationError();
        const parsed = requestFormSchema.safeParse(entries);
        if (!parsed.success) {
          throw new services.OfferIssuanceValidationError(issuePaths(parsed.error));
        }
        return services.requestOfferIssuance(tx, ctx, parsed.data);
      },
    );
    revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
    return {
      status: "issuance_requested",
      issuanceId: result.issuanceId,
      state: result.state,
      approvalCount: result.approvalCount,
      replayed: result.replayed,
    };
  } catch (error) {
    const mapped = mapIssuanceError(error, services, admission);
    if (mapped) return mapped;
    throw error;
  }
}

export async function approveOfferIssuanceAction(
  _previousState: OfferIssuanceActionState,
  formData: FormData,
): Promise<OfferIssuanceActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  const [services, admission] = await issuanceDependencies();
  try {
    const result = await authorizedOfferMutationAction(
      workspaceId,
      ["offer.issue.approve"],
      "offer_issuance_approval",
      async (tx, ctx) => {
        const entries = exactStringEntries(
          formData,
          APPROVAL_REQUIRED_FIELDS,
          APPROVAL_OPTIONAL_FIELDS,
        );
        if (entries === null) throw new services.OfferIssuanceValidationError();
        const parsed = approvalFormSchema.safeParse(entries);
        if (!parsed.success) {
          throw new services.OfferIssuanceValidationError(issuePaths(parsed.error));
        }
        const { workspaceId: ignoredWorkspaceId, offerId: ignoredOfferId, ...command } = parsed.data;
        void ignoredWorkspaceId;
        void ignoredOfferId;
        return services.approveOfferIssuance(tx, ctx, command);
      },
    );
    revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
    return {
      status: "issuance_approved",
      issuanceId: result.issuanceId,
      approvalCount: result.approvalCount,
      derivedState: result.state,
      replayed: result.replayed,
    };
  } catch (error) {
    const mapped = mapIssuanceError(error, services, admission);
    if (mapped) return mapped;
    throw error;
  }
}

export async function withdrawOfferIssuanceAction(
  _previousState: OfferIssuanceActionState,
  formData: FormData,
): Promise<OfferIssuanceActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  const [services, admission] = await issuanceDependencies();
  try {
    const result = await authorizedOfferMutationAction(
      workspaceId,
      ["offer.issue.withdraw"],
      "offer_issuance_withdrawal",
      async (tx, ctx) => {
        const entries = exactStringEntries(formData, WITHDRAWAL_FIELDS);
        if (entries === null) throw new services.OfferIssuanceValidationError();
        const parsed = withdrawalFormSchema.safeParse(entries);
        if (!parsed.success) {
          throw new services.OfferIssuanceValidationError(issuePaths(parsed.error));
        }
        return services.withdrawOfferIssuance(tx, ctx, {
          schemaVersion: parsed.data.schemaVersion,
          issuanceId: parsed.data.issuanceId,
          reasonCode: parsed.data.withdrawalReasonCode,
        });
      },
    );
    revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
    return {
      status: "issuance_withdrawn",
      issuanceId: result.issuanceId,
      state: result.state,
      approvalCount: result.approvalCount,
      withdrawnAt: result.withdrawnAt,
      replayed: result.replayed,
    };
  } catch (error) {
    const mapped = mapIssuanceError(error, services, admission);
    if (mapped) return mapped;
    throw error;
  }
}
