"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authorizedOfferMutationAction, authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import {
  createOfferCommandV1Schema,
  createVariantFromResolutionCommandV1Schema,
  duplicateOfferVariantCommandV1Schema,
  reviseOfferVariantCommandV1Schema,
} from "@/lib/integrations/offers/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  createOfferFromRequest,
  createVariantFromCurrentResolution,
  duplicateOfferVariant,
  getOfferPreviewHtml,
  OfferBlockedError,
  OfferConflictError,
  OfferPdfDraftConflictError,
  OfferPdfDraftIntegrityError,
  OfferPdfDraftNotFoundError,
  OfferRateLimitError,
  OfferValidationError,
  reviseOfferVariant,
} from "@/modules/offers";

const OFFER_BLOCKED_CODES = [
  "project_not_found",
  "project_not_eligible",
  "address_not_confirmed",
  "inbound_binding_missing",
  "calculation_not_current",
  "offer_column_configuration",
  "resolution_not_current",
  "catalog_pricing_missing",
  "offer_pricing_out_of_range",
  "project_not_request",
  "offer_number_exhausted",
  "variant_limit",
  "installation_site_changed",
] as const;
export type OfferBlockedCode = typeof OFFER_BLOCKED_CODES[number] | "requirements_changed";
const offerBlockedCodeSet = new Set<string>(OFFER_BLOCKED_CODES);

export type OfferActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "blocked"; code: OfferBlockedCode }
  | { status: "conflict"; currentRevision?: number }
  | { status: "unavailable"; retryAfter: string };

export type OfferEditorActionState = OfferActionState | {
  status: "success";
  offerId: string;
  variantId: string;
  revision: number;
};

const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const MAX_OPERATIONS_JSON_LENGTH = 256_000;
const WORKSPACE_ID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());

const CREATE_STANDARD_FIELDS = new Set([
  "workspaceId",
  "projectId",
  "expectedRequirementRevision",
  "expectedCalculationRevision",
  "expectedResolutionRevision",
  "forecastValueNetCents",
  "priceAudience",
  "priceAudienceConfirmation.code",
  "priceAudienceConfirmation.confirmed",
  "taxTreatment",
]);
const CREATE_ZERO_FIELDS = new Set([
  ...CREATE_STANDARD_FIELDS,
  "zeroConfirmation.code",
  "zeroConfirmation.confirmed",
]);
const DUPLICATE_FIELDS = new Set([
  "workspaceId",
  "offerId",
  "sourceVariantId",
  "expectedSourceRevision",
  "name",
]);
const REVISE_FIELDS = new Set([
  "workspaceId",
  "offerId",
  "variantId",
  "expectedRevision",
  "operations",
]);
const NEW_BASIS_STANDARD_FIELDS = new Set([
  "workspaceId",
  "offerId",
  "expectedRequirementRevision",
  "expectedCalculationRevision",
  "expectedResolutionRevision",
  "name",
  "taxTreatment",
]);
const NEW_BASIS_ZERO_FIELDS = new Set([
  ...NEW_BASIS_STANDARD_FIELDS,
  "zeroConfirmation.code",
  "zeroConfirmation.confirmed",
]);

type ParsedForm = Readonly<Record<string, string>>;

function workspaceForAdmission(formData: FormData): string | null {
  const values = formData.getAll("workspaceId");
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  const parsed = WORKSPACE_ID_SCHEMA.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}

function parseExactForm(
  formData: FormData,
  allowedVariants: readonly ReadonlySet<string>[],
): ParsedForm | null {
  const values = new Map<string, string>();

  for (const [name, rawValue] of formData.entries()) {
    if (typeof rawValue !== "string" || values.has(name)) return null;
    if (name.startsWith("$ACTION")) {
      if (!REACT_ACTION_FIELD_PATTERN.test(name)) return null;
      values.set(name, rawValue);
      continue;
    }
    values.set(name, rawValue);
  }

  const domainNames = new Set(
    [...values.keys()].filter((name) => !name.startsWith("$ACTION")),
  );
  const exactVariant = allowedVariants.some((allowed) =>
    domainNames.size === allowed.size
      && [...domainNames].every((name) => allowed.has(name)),
  );
  if (!exactVariant) return null;

  return Object.fromEntries(
    [...values].filter(([name]) => !name.startsWith("$ACTION")),
  );
}

function positiveInteger(value: string | undefined): number | null {
  if (value === undefined || !INTEGER_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function nullableMoneyCents(value: string | undefined): number | null | undefined {
  if (value === undefined || value === "") return null;
  if (!INTEGER_PATTERN.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 9_000_000_000_000_000
    ? parsed
    : undefined;
}

function parseOperations(value: string | undefined): unknown[] | null {
  if (value === undefined || value.length === 0 || value.length > MAX_OPERATIONS_JSON_LENGTH) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapOfferError(error: unknown): OfferActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  // OfferBlockedError derives from OfferValidationError so the specific,
  // redacted state must be mapped first. Unknown future service codes collapse
  // to one non-enumerating fallback instead of leaking internal details.
  if (error instanceof OfferBlockedError) {
    return {
      status: "blocked",
      code: offerBlockedCodeSet.has(error.code)
        ? error.code as OfferBlockedCode
        : "requirements_changed",
    };
  }
  if (error instanceof OfferValidationError) return { status: "invalid" };
  if (error instanceof OfferConflictError) {
    return error.currentRevision === undefined
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  if (error instanceof OfferRateLimitError) {
    return { status: "unavailable", retryAfter: error.retryAfter };
  }
  return null;
}

export async function createOfferFromRequestAction(
  _previousState: OfferActionState,
  formData: FormData,
): Promise<OfferActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };

  let result: { offerId: string; variantId: string; projectId: string };
  try {
    result = await authorizedOfferMutationAction(
      workspaceId,
      ["project.write", "phase.convert", "price.edit"],
      "offer",
      async (tx, ctx) => {
        const fields = parseExactForm(formData, [CREATE_STANDARD_FIELDS, CREATE_ZERO_FIELDS]);
        if (!fields) throw new OfferValidationError();
        const forecastValueNetCents = nullableMoneyCents(fields.forecastValueNetCents);
        if (forecastValueNetCents === undefined) throw new OfferValidationError();
        const parsed = createOfferCommandV1Schema.safeParse({
          schemaVersion: "offer-create-command.v1",
          projectId: fields.projectId,
          expectedRequirementRevision: positiveInteger(fields.expectedRequirementRevision),
          expectedCalculationRevision: positiveInteger(fields.expectedCalculationRevision),
          expectedResolutionRevision: positiveInteger(fields.expectedResolutionRevision),
          forecastValueNetCents,
          priceAudience: fields.priceAudience,
          priceAudienceConfirmation: {
            code: fields["priceAudienceConfirmation.code"],
            confirmed: fields["priceAudienceConfirmation.confirmed"] === "true",
          },
          taxTreatment: fields.taxTreatment,
          ...(fields.taxTreatment === "zero_operator_confirmed"
            ? {
                zeroConfirmation: {
                  code: fields["zeroConfirmation.code"],
                  confirmed: fields["zeroConfirmation.confirmed"] === "true",
                },
              }
            : {}),
        });
        if (!parsed.success) throw new OfferValidationError();
        const mutation = await createOfferFromRequest(tx, ctx, parsed.data);
        return { ...mutation, projectId: parsed.data.projectId };
      },
    );
  } catch (error) {
    const mapped = mapOfferError(error);
    if (mapped) return mapped;
    throw error;
  }

  revalidatePath(`/w/${workspaceId}/anfragen`);
  revalidatePath(`/w/${workspaceId}/anfragen/${result.projectId}`);
  revalidatePath(`/w/${workspaceId}/angebote`);
  redirect(`/w/${workspaceId}/angebote/${result.offerId}?variante=${result.variantId}`);
}

export async function duplicateOfferVariantAction(
  _previousState: OfferActionState,
  formData: FormData,
): Promise<OfferActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };

  let result: { offerId: string; variantId: string };
  try {
    result = await authorizedOfferMutationAction(
      workspaceId,
      ["project.write"],
      "offer_variant",
      async (tx, ctx) => {
        const fields = parseExactForm(formData, [DUPLICATE_FIELDS]);
        if (!fields) throw new OfferValidationError();
        const parsed = duplicateOfferVariantCommandV1Schema.safeParse({
          schemaVersion: "offer-variant-duplicate-command.v1",
          offerId: fields.offerId,
          sourceVariantId: fields.sourceVariantId,
          expectedSourceRevision: positiveInteger(fields.expectedSourceRevision),
          name: fields.name,
        });
        if (!parsed.success) throw new OfferValidationError();
        return duplicateOfferVariant(tx, ctx, parsed.data);
      },
    );
  } catch (error) {
    const mapped = mapOfferError(error);
    if (mapped) return mapped;
    throw error;
  }

  revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
  revalidatePath(`/w/${workspaceId}/angebote`);
  redirect(`/w/${workspaceId}/angebote/${result.offerId}?variante=${result.variantId}`);
}

export async function reviseOfferVariantAction(
  _previousState: OfferActionState,
  formData: FormData,
): Promise<OfferActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };

  let result: { offerId: string; variantId: string };
  try {
    result = await authorizedOfferMutationAction(
      workspaceId,
      ["project.write"],
      "offer_variant",
      async (tx, ctx) => {
        const fields = parseExactForm(formData, [REVISE_FIELDS]);
        if (!fields) throw new OfferValidationError();
        const operations = parseOperations(fields.operations);
        if (!operations) throw new OfferValidationError();
        const parsed = reviseOfferVariantCommandV1Schema.safeParse({
          schemaVersion: "offer-variant-revise-command.v1",
          offerId: fields.offerId,
          variantId: fields.variantId,
          expectedRevision: positiveInteger(fields.expectedRevision),
          operations,
        });
        if (!parsed.success) throw new OfferValidationError();
        return reviseOfferVariant(tx, ctx, parsed.data);
      },
    );
  } catch (error) {
    const mapped = mapOfferError(error);
    if (mapped) return mapped;
    throw error;
  }

  revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
  revalidatePath(`/w/${workspaceId}/angebote`);
  redirect(`/w/${workspaceId}/angebote/${result.offerId}?variante=${result.variantId}`);
}

/**
 * Editor-Action ohne Zwischenredirect: Der Client rebaset seinen lokalen Draft
 * ausschließlich auf die vom Fachservice bestätigte Revision und refresht
 * anschließend das serverautoritativ berechnete Readmodel.
 */
export async function saveOfferVariantDraftAction(
  formData: FormData,
): Promise<OfferEditorActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };

  let result: { offerId: string; variantId: string; revision: number };
  try {
    result = await authorizedOfferMutationAction(
      workspaceId,
      ["project.write"],
      "offer_variant",
      async (tx, ctx) => {
        const fields = parseExactForm(formData, [REVISE_FIELDS]);
        if (!fields) throw new OfferValidationError();
        const operations = parseOperations(fields.operations);
        if (!operations) throw new OfferValidationError();
        const parsed = reviseOfferVariantCommandV1Schema.safeParse({
          schemaVersion: "offer-variant-revise-command.v1",
          offerId: fields.offerId,
          variantId: fields.variantId,
          expectedRevision: positiveInteger(fields.expectedRevision),
          operations,
        });
        if (!parsed.success) throw new OfferValidationError();
        return reviseOfferVariant(tx, ctx, parsed.data);
      },
    );
  } catch (error) {
    const mapped = mapOfferError(error);
    if (mapped) return mapped;
    throw error;
  }

  revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
  revalidatePath(`/w/${workspaceId}/angebote`);
  return { status: "success", ...result };
}

export async function duplicateOfferVariantEditorAction(
  formData: FormData,
): Promise<OfferEditorActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };

  let result: { offerId: string; variantId: string; revision: number };
  try {
    result = await authorizedOfferMutationAction(
      workspaceId,
      ["project.write"],
      "offer_variant",
      async (tx, ctx) => {
        const fields = parseExactForm(formData, [DUPLICATE_FIELDS]);
        if (!fields) throw new OfferValidationError();
        const parsed = duplicateOfferVariantCommandV1Schema.safeParse({
          schemaVersion: "offer-variant-duplicate-command.v1",
          offerId: fields.offerId,
          sourceVariantId: fields.sourceVariantId,
          expectedSourceRevision: positiveInteger(fields.expectedSourceRevision),
          name: fields.name,
        });
        if (!parsed.success) throw new OfferValidationError();
        return duplicateOfferVariant(tx, ctx, parsed.data);
      },
    );
  } catch (error) {
    const mapped = mapOfferError(error);
    if (mapped) return mapped;
    throw error;
  }

  revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
  revalidatePath(`/w/${workspaceId}/angebote`);
  return { status: "success", ...result };
}

export async function createVariantFromCurrentResolutionEditorAction(
  formData: FormData,
): Promise<OfferEditorActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };

  let result: { offerId: string; variantId: string; revision: number };
  try {
    result = await authorizedOfferMutationAction(
      workspaceId,
      ["project.write", "price.edit"],
      "offer_variant",
      async (tx, ctx) => {
        const fields = parseExactForm(formData, [
          NEW_BASIS_STANDARD_FIELDS,
          NEW_BASIS_ZERO_FIELDS,
        ]);
        if (!fields) throw new OfferValidationError();
        const parsed = createVariantFromResolutionCommandV1Schema.safeParse({
          schemaVersion: "offer-variant-from-resolution-command.v1",
          offerId: fields.offerId,
          expectedRequirementRevision: positiveInteger(fields.expectedRequirementRevision),
          expectedCalculationRevision: positiveInteger(fields.expectedCalculationRevision),
          expectedResolutionRevision: positiveInteger(fields.expectedResolutionRevision),
          name: fields.name,
          taxTreatment: fields.taxTreatment,
          ...(fields.taxTreatment === "zero_operator_confirmed"
            ? {
                zeroConfirmation: {
                  code: fields["zeroConfirmation.code"],
                  confirmed: fields["zeroConfirmation.confirmed"] === "true",
                },
              }
            : {}),
        });
        if (!parsed.success) throw new OfferValidationError();
        return createVariantFromCurrentResolution(tx, ctx, parsed.data);
      },
    );
  } catch (error) {
    const mapped = mapOfferError(error);
    if (mapped) return mapped;
    throw error;
  }

  revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
  revalidatePath(`/w/${workspaceId}/angebote`);
  return { status: "success", ...result };
}

export async function createVariantFromCurrentResolutionAction(
  _previousState: OfferActionState,
  formData: FormData,
): Promise<OfferActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };

  let result: { offerId: string; variantId: string };
  try {
    result = await authorizedOfferMutationAction(
      workspaceId,
      ["project.write", "price.edit"],
      "offer_variant",
      async (tx, ctx) => {
        const fields = parseExactForm(formData, [
          NEW_BASIS_STANDARD_FIELDS,
          NEW_BASIS_ZERO_FIELDS,
        ]);
        if (!fields) throw new OfferValidationError();
        const parsed = createVariantFromResolutionCommandV1Schema.safeParse({
          schemaVersion: "offer-variant-from-resolution-command.v1",
          offerId: fields.offerId,
          expectedRequirementRevision: positiveInteger(fields.expectedRequirementRevision),
          expectedCalculationRevision: positiveInteger(fields.expectedCalculationRevision),
          expectedResolutionRevision: positiveInteger(fields.expectedResolutionRevision),
          name: fields.name,
          taxTreatment: fields.taxTreatment,
          ...(fields.taxTreatment === "zero_operator_confirmed"
            ? {
                zeroConfirmation: {
                  code: fields["zeroConfirmation.code"],
                  confirmed: fields["zeroConfirmation.confirmed"] === "true",
                },
              }
            : {}),
        });
        if (!parsed.success) throw new OfferValidationError();
        return createVariantFromCurrentResolution(tx, ctx, parsed.data);
      },
    );
  } catch (error) {
    const mapped = mapOfferError(error);
    if (mapped) return mapped;
    throw error;
  }

  revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
  revalidatePath(`/w/${workspaceId}/angebote`);
  redirect(`/w/${workspaceId}/angebote/${result.offerId}?variante=${result.variantId}`);
}

export type OfferPreviewState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "unavailable" }
  | { status: "success"; html: string; variantRevision: number };

export async function previewOfferHtmlAction(input: {
  workspaceId: string;
  offerId: string;
  variantId: string;
  expectedVariantRevision: number;
}): Promise<OfferPreviewState> {
  const parsed = z
    .strictObject({
      workspaceId: z.uuid(),
      offerId: z.uuid(),
      variantId: z.uuid(),
      expectedVariantRevision: z.number().int().min(1),
    })
    .safeParse(input);
  if (!parsed.success) return { status: "invalid" };
  try {
    const result = await authorizedQuery(
      parsed.data.workspaceId,
      "project.read",
      "offer_preview",
      async (tx, ctx) =>
        getOfferPreviewHtml(tx, ctx, {
          workspaceId: parsed.data.workspaceId,
          offerId: parsed.data.offerId,
          variantId: parsed.data.variantId,
          expectedVariantRevision: parsed.data.expectedVariantRevision,
        }),
    );
    return { status: "success", html: result.html, variantRevision: result.variantRevision };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof OfferValidationError) return { status: "invalid" };
    if (error instanceof OfferPdfDraftNotFoundError) return { status: "invalid" };
    if (error instanceof OfferPdfDraftConflictError) {
      return error.currentRevision === undefined
        ? { status: "conflict" }
        : { status: "conflict", currentRevision: error.currentRevision };
    }
    if (error instanceof OfferPdfDraftIntegrityError) return { status: "unavailable" };
    throw error;
  }
}
