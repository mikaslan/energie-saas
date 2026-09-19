"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  authorizedAction,
  NotAuthenticatedError,
} from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";

// F8-24c: Draft-Vorschau anfordern (Spiegel pdf-actions, schlank).
import type { RequestDraftPdfActionState } from "./pdf-action-state";

type DraftPdfServiceModule = typeof import("@/modules/invoicing");

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const WORKSPACE_ID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const DRAFT_PDF_FIELDS = new Set([
  "workspaceId",
  "type",
  "documentId",
]);
// Nur invoice/credit_note — letter fail-closed bereits beim Parsen
// (der Service verweigert zusaetzlich: nie auf eine Schicht verlassen).
const draftPdfFormSchema = z.strictObject({
  workspaceId: WORKSPACE_ID_SCHEMA,
  type: z.enum(["invoice", "credit_note"]),
  documentId: z.uuid().transform((value) => value.toLowerCase()),
});

function workspaceForAdmission(formData: FormData): string | null {
  const values = formData.getAll("workspaceId");
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  const parsed = WORKSPACE_ID_SCHEMA.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}

function parseExactForm(formData: FormData): z.infer<typeof draftPdfFormSchema> | null {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
    if (name.startsWith("$ACTION")) {
      if (!REACT_ACTION_FIELD_PATTERN.test(name)) return null;
      values.set(name, value);
      continue;
    }
    if (!DRAFT_PDF_FIELDS.has(name)) return null;
    values.set(name, value);
  }

  const domainEntries = [...values].filter(([name]) => !name.startsWith("$ACTION"));
  if (
    domainEntries.length !== DRAFT_PDF_FIELDS.size
    || ![...DRAFT_PDF_FIELDS].every((name) => values.has(name))
  ) return null;

  const parsed = draftPdfFormSchema.safeParse(Object.fromEntries(domainEntries));
  return parsed.success ? parsed.data : null;
}

function mapDraftPdfError(
  error: unknown,
  pdfService: DraftPdfServiceModule,
): RequestDraftPdfActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof pdfService.InvoicingValidationError) return { status: "invalid" };
  if (error instanceof pdfService.InvoicingNotFoundError) return { status: "not_found" };
  if (error instanceof pdfService.InvoicingIntegrityError) return { status: "unavailable" };
  return null;
}

export async function requestDraftPdfAction(
  _previousState: RequestDraftPdfActionState,
  formData: FormData,
): Promise<RequestDraftPdfActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  // Erst beim tatsächlichen Server-Action-Aufruf laden. So bleibt die Client-
  // Referenz frei von der server-only DAL; Next ersetzt diese Funktion im
  // Browser ohnehin durch die verschlüsselte Action-Referenz.
  const pdfService: DraftPdfServiceModule = await import("@/modules/invoicing");

  try {
    const command = parseExactForm(formData);
    if (!command) throw new pdfService.InvoicingValidationError();
    const result = await authorizedAction(
      workspaceId,
      "invoicing.write",
      "draft_pdf",
      async (tx, ctx) => pdfService.requestDraftPdfInput(tx, ctx, {
        schemaVersion: pdfService.COMMERCIAL_DOCUMENT_DRAFT_RENDER_COMMAND_VERSION,
        documentId: command.documentId,
      }),
    );

    revalidatePath(`/w/${workspaceId}/rechnungen/${command.type}/${command.documentId}`);
    return {
      status: "success",
      state: result.status,
      jobId: result.jobId,
    };
  } catch (error) {
    const mapped = mapDraftPdfError(error, pdfService);
    if (mapped) return mapped;
    throw error;
  }
}
