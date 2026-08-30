"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  authorizedOfferMutationAction,
  NotAuthenticatedError,
} from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import type { GenerateOfferPdfDraftActionState } from "./pdf-action-state";

type PdfServiceModule = typeof import("@/modules/offers");
type OfferAdmissionModule = typeof import("@/lib/integrations/offers/admission");

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const INTEGER_PATTERN = /^[1-9]\d*$/u;
const WORKSPACE_ID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const PDF_DRAFT_FIELDS = new Set([
  "workspaceId",
  "offerId",
  "variantId",
  "expectedVariantRevision",
]);
const pdfDraftFormSchema = z.strictObject({
  workspaceId: WORKSPACE_ID_SCHEMA,
  offerId: z.uuid().transform((value) => value.toLowerCase()),
  variantId: z.uuid().transform((value) => value.toLowerCase()),
  expectedVariantRevision: z.string().regex(INTEGER_PATTERN).transform(Number)
    .pipe(z.int().safe().min(1)),
});

function workspaceForAdmission(formData: FormData): string | null {
  const values = formData.getAll("workspaceId");
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  const parsed = WORKSPACE_ID_SCHEMA.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}

function parseExactForm(formData: FormData): z.infer<typeof pdfDraftFormSchema> | null {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
    if (name.startsWith("$ACTION")) {
      if (!REACT_ACTION_FIELD_PATTERN.test(name)) return null;
      values.set(name, value);
      continue;
    }
    if (!PDF_DRAFT_FIELDS.has(name)) return null;
    values.set(name, value);
  }

  const domainEntries = [...values].filter(([name]) => !name.startsWith("$ACTION"));
  if (
    domainEntries.length !== PDF_DRAFT_FIELDS.size
    || ![...PDF_DRAFT_FIELDS].every((name) => values.has(name))
  ) return null;

  const parsed = pdfDraftFormSchema.safeParse(Object.fromEntries(domainEntries));
  return parsed.success ? parsed.data : null;
}

function mapPdfDraftError(
  error: unknown,
  pdfService: PdfServiceModule,
  offerAdmission: OfferAdmissionModule,
): GenerateOfferPdfDraftActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof pdfService.OfferPdfDraftValidationError) return { status: "invalid" };
  if (error instanceof pdfService.OfferPdfDraftNotFoundError) return { status: "not_found" };
  if (error instanceof pdfService.OfferPdfDraftConflictError) {
    return error.currentRevision === undefined
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  if (error instanceof offerAdmission.OfferRateLimitError) {
    return { status: "unavailable", retryAfter: error.retryAfter };
  }
  if (
    error instanceof pdfService.OfferPdfDraftIntegrityError
    || error instanceof pdfService.OfferPdfDraftPersistenceError
    || error instanceof pdfService.OfferPdfDraftDispatchError
  ) return { status: "unavailable" };
  return null;
}

export async function generateOfferPdfDraftAction(
  _previousState: GenerateOfferPdfDraftActionState,
  formData: FormData,
): Promise<GenerateOfferPdfDraftActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  // Erst beim tatsächlichen Server-Action-Aufruf laden. So bleibt die Client-
  // Referenz frei von der server-only DAL; Next ersetzt diese Funktion im
  // Browser ohnehin durch die verschlüsselte Action-Referenz.
  const [pdfService, offerAdmission] = await Promise.all([
    import("@/modules/offers"),
    import("@/lib/integrations/offers/admission"),
  ]);

  try {
    const result = await authorizedOfferMutationAction(
      workspaceId,
      ["project.write"],
      "offer_pdf_draft",
      async (tx, ctx) => {
        const command = parseExactForm(formData);
        if (!command) throw new pdfService.OfferPdfDraftValidationError();
        return pdfService.requestOfferPdfDraft(tx, ctx, command);
      },
    );

    revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
    return {
      status: "success",
      state: result.state,
      replayed: result.replayed,
      variantRevision: result.variantRevision,
    };
  } catch (error) {
    const mapped = mapPdfDraftError(error, pdfService, offerAdmission);
    if (mapped) return mapped;
    throw error;
  }
}
