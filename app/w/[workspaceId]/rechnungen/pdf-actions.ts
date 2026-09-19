"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  authorizedAction,
  NotAuthenticatedError,
} from "@/lib/action";
import {
  COMMERCIAL_DOCUMENT_PAYMENT_RENDER_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
  commercialDocumentTypes,
} from "@/lib/integrations/invoicing/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import type {
  RequestInvoicePaymentActionState,
  RequestInvoicePdfActionState,
} from "./pdf-action-state";

type PdfServiceModule = typeof import("@/modules/invoicing");

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const WORKSPACE_ID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const INVOICE_PDF_FIELDS = new Set([
  "workspaceId",
  "type",
  "documentId",
]);
const invoicePdfFormSchema = z.strictObject({
  workspaceId: WORKSPACE_ID_SCHEMA,
  type: z.enum(commercialDocumentTypes),
  documentId: z.uuid().transform((value) => value.toLowerCase()),
});
// F8-18: Zahlungsbeleg nur fuer Rechnungen (Gutschriften schulden dem
// Kunden — nie ein QR an uns). Form-Felder identisch, Typ strikt.
const invoicePaymentFormSchema = z.strictObject({
  workspaceId: WORKSPACE_ID_SCHEMA,
  type: z.literal("invoice"),
  documentId: z.uuid().transform((value) => value.toLowerCase()),
});

function workspaceForAdmission(formData: FormData): string | null {
  const values = formData.getAll("workspaceId");
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  const parsed = WORKSPACE_ID_SCHEMA.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}

function parseExactForm(formData: FormData): z.infer<typeof invoicePdfFormSchema> | null {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
    if (name.startsWith("$ACTION")) {
      if (!REACT_ACTION_FIELD_PATTERN.test(name)) return null;
      values.set(name, value);
      continue;
    }
    if (!INVOICE_PDF_FIELDS.has(name)) return null;
    values.set(name, value);
  }

  const domainEntries = [...values].filter(([name]) => !name.startsWith("$ACTION"));
  if (
    domainEntries.length !== INVOICE_PDF_FIELDS.size
    || ![...INVOICE_PDF_FIELDS].every((name) => values.has(name))
  ) return null;

  const parsed = invoicePdfFormSchema.safeParse(Object.fromEntries(domainEntries));
  return parsed.success ? parsed.data : null;
}

function mapInvoicePdfError(
  error: unknown,
  pdfService: PdfServiceModule,
): RequestInvoicePdfActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof pdfService.InvoicingValidationError) return { status: "invalid" };
  if (error instanceof pdfService.InvoicingNotFoundError) return { status: "not_found" };
  if (error instanceof pdfService.InvoicingIntegrityError) return { status: "unavailable" };
  return null;
}

function parseExactPaymentForm(formData: FormData): z.infer<typeof invoicePaymentFormSchema> | null {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
    if (name.startsWith("$ACTION")) {
      if (!REACT_ACTION_FIELD_PATTERN.test(name)) return null;
      values.set(name, value);
      continue;
    }
    if (!INVOICE_PDF_FIELDS.has(name)) return null;
    values.set(name, value);
  }

  const domainEntries = [...values].filter(([name]) => !name.startsWith("$ACTION"));
  if (
    domainEntries.length !== INVOICE_PDF_FIELDS.size
    || ![...INVOICE_PDF_FIELDS].every((name) => values.has(name))
  ) return null;

  const parsed = invoicePaymentFormSchema.safeParse(Object.fromEntries(domainEntries));
  return parsed.success ? parsed.data : null;
}

export async function requestInvoicePdfAction(
  _previousState: RequestInvoicePdfActionState,
  formData: FormData,
): Promise<RequestInvoicePdfActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  // Erst beim tatsächlichen Server-Action-Aufruf laden. So bleibt die Client-
  // Referenz frei von der server-only DAL; Next ersetzt diese Funktion im
  // Browser ohnehin durch die verschlüsselte Action-Referenz.
  const pdfService: PdfServiceModule = await import("@/modules/invoicing");

  try {
    const command = parseExactForm(formData);
    if (!command) throw new pdfService.InvoicingValidationError();
    const result = await authorizedAction(
      workspaceId,
      "invoicing.write",
      "invoice_pdf",
      async (tx, ctx) => pdfService.requestInvoicePdfInput(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
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
    const mapped = mapInvoicePdfError(error, pdfService);
    if (mapped) return mapped;
    throw error;
  }
}

// F8-18: Zahlungsbeleg anfordern (Spiegel requestInvoicePdfAction:
// exaktes Parsing, type strikt invoice, gleiche Fehlerabbildung).
export async function requestInvoicePaymentAction(
  _previousState: RequestInvoicePaymentActionState,
  formData: FormData,
): Promise<RequestInvoicePaymentActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  // Erst beim tatsächlichen Server-Action-Aufruf laden. So bleibt die Client-
  // Referenz frei von der server-only DAL; Next ersetzt diese Funktion im
  // Browser ohnehin durch die verschlüsselte Action-Referenz.
  const pdfService: PdfServiceModule = await import("@/modules/invoicing");

  try {
    const command = parseExactPaymentForm(formData);
    if (!command) throw new pdfService.InvoicingValidationError();
    const result = await authorizedAction(
      workspaceId,
      "invoicing.write",
      "invoice_payment",
      async (tx, ctx) => pdfService.requestInvoicePaymentInput(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_RENDER_COMMAND_VERSION,
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
    const mapped = mapInvoicePdfError(error, pdfService);
    if (mapped) return mapped;
    throw error;
  }
}
