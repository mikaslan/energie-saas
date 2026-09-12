"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import {
  COMMERCIAL_DOCUMENT_ARCHIVE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_DUPLICATE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_ARCHIVE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINK_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_SENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_UNLINK_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_TERMS_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  commercialDocumentCommandV1Schema,
  commercialDocumentGroupCommandV1Schema,
  commercialDocumentTermsCommandV1Schema,
  commercialVoidReasons,
  type CommercialVoidReason,
} from "@/lib/integrations/invoicing/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  createDocument,
  createDocumentGroup,
  createPartialInvoice,
  duplicateOrderConfirmationAsInvoice,
  issueDocument,
  linkDeposit,
  markSentDocument,
  unlinkDeposit,
  setDocumentArchived,
  setDocumentGroupArchived,
  setDocumentTerms,
  voidDocument,
  InvoicingConflictError,
  InvoicingNotFoundError,
  InvoicingPreconditionConflictError,
  InvoicingValidationError,
} from "@/modules/invoicing";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type InvoicingUiActionState =
  | { status: "idle" }
  | { status: "success" }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "precondition" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function mapError(error: unknown): InvoicingUiActionState {
  if (error instanceof InvoicingValidationError) return { status: "invalid" };
  if (error instanceof InvoicingNotFoundError) return { status: "not_found" };
  if (error instanceof InvoicingPreconditionConflictError) return { status: "precondition" };
  if (error instanceof InvoicingConflictError) return { status: "conflict" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

function parseWorkspaceId(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const parsed = workspaceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseUuid(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const parsed = z.uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

// F5-01 · Prozent mit einer Nachkommastelle („2,5" / „2.5") -> Basispunkte;
// leere Felder = kein Skonto (null). undefined = ungueltig.
function parseSkontoPercent(value: FormDataEntryValue | null): number | null | undefined {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = value.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d)?$/u.test(normalized)) return undefined;
  const bps = Math.round(Number(normalized) * 100);
  return Number.isFinite(bps) ? bps : undefined;
}

function parseSkontoDays(value: FormDataEntryValue | null): number | null | undefined {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (!/^\d{1,3}$/u.test(value.trim())) return undefined;
  return Number(value.trim());
}

// F8-02 · EUR-Betrag („119,00" / „119.00") -> Cent; leeres Feld =
// undefined (Default = volles Brutto). null = ungueltig.
function parseEuroCents(value: FormDataEntryValue | null): number | null | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const normalized = value.trim().replace(",", ".");
  if (!/^\d{1,9}(\.\d{1,2})?$/u.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isFinite(cents) ? cents : null;
}

export async function createInvoicingGroupAction(
  _previous: InvoicingUiActionState,
  formData: FormData,
): Promise<InvoicingUiActionState> {
  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  if (!workspaceId) return { status: "invalid" };
  try {
    const nameValue = formData.get("name");
    const parsed = commercialDocumentGroupCommandV1Schema.safeParse({
      schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
      name: typeof nameValue === "string" ? nameValue : "",
    });
    if (!parsed.success) return { status: "invalid" };
    await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document_group",
      (tx, ctx) => createDocumentGroup(tx, ctx, parsed.data),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/w/${workspaceId}/rechnungen`);
  return { status: "success" };
}

export async function setDocumentGroupArchivedAction(
  _previous: InvoicingUiActionState,
  formData: FormData,
): Promise<InvoicingUiActionState> {
  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  const groupId = parseUuid(formData.get("groupId"));
  if (!workspaceId || !groupId) return { status: "invalid" };
  try {
    await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document_group",
      (tx, ctx) => setDocumentGroupArchived(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_GROUP_ARCHIVE_COMMAND_VERSION,
        groupId,
        archived: formData.get("archived") === "true",
      }),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/w/${workspaceId}/rechnungen`);
  return { status: "success" };
}

export async function createDocumentAction(
  _previous: InvoicingUiActionState,
  formData: FormData,
): Promise<InvoicingUiActionState> {
  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  const typeValue = formData.get("type");
  const type = typeof typeValue === "string" ? typeValue : null;
  if (!workspaceId || typeof type !== "string") return { status: "invalid" };

  const groupValue = formData.get("groupId");
  // FormData-Werte je Feld genau einmal lesen (TS-Narrowing bleibt erhalten).
  const nameValue = formData.get("name");
  const dueDateValue = formData.get("dueDate");
  const deliveryDateValue = formData.get("deliveryDate");
  const validityDateValue = formData.get("validityDate");
  const plannedDeliveryDateValue = formData.get("plannedDeliveryDate");
  const plannedServiceDateValue = formData.get("plannedServiceDate");
  const creditNoteTypeValue = formData.get("creditNoteType");
  const optionalDate = (value: FormDataEntryValue | null): string | null =>
    typeof value === "string" && value !== "" ? value : null;
  // F5-01b · Skonto schon bei Anlage (nur invoice; Felder nur dort gerendert).
  const skontoPercentBps = parseSkontoPercent(formData.get("skontoPercent"));
  const skontoDays = parseSkontoDays(formData.get("skontoDays"));
  if (skontoPercentBps === undefined || skontoDays === undefined) return { status: "invalid" };
  const parsed = commercialDocumentCommandV1Schema.safeParse({
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input: {
      type,
      name: nameValue,
      groupId: typeof groupValue === "string" && groupValue !== "" ? groupValue : null,
      projectId: null,
      contactId: null,
      dueDate: optionalDate(dueDateValue),
      skontoPercentBps: skontoPercentBps ?? undefined,
      skontoDays: skontoDays ?? undefined,
      deliveryDate: optionalDate(deliveryDateValue),
      validityDate: optionalDate(validityDateValue),
      plannedDeliveryDate: optionalDate(plannedDeliveryDateValue),
      plannedServiceDate: optionalDate(plannedServiceDateValue),
      creditNoteType: optionalDate(creditNoteTypeValue),
    },
  });
  if (!parsed.success) return { status: "invalid" };
  try {
    await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document",
      (tx, ctx) => createDocument(tx, ctx, parsed.data),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/w/${workspaceId}/rechnungen/${type}`);
  return { status: "success" };
}

export async function issueDocumentAction(
  _previous: InvoicingUiActionState,
  formData: FormData,
): Promise<InvoicingUiActionState> {
  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  const documentId = parseUuid(formData.get("documentId"));
  if (!workspaceId || !documentId) return { status: "invalid" };
  try {
    await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document",
      (tx, ctx) => issueDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
        documentId,
      }),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/w/${workspaceId}/rechnungen`);
  revalidatePath(`/w/${workspaceId}/rechnungen/berichte`);
  return { status: "success" };
}

export async function sendDocumentAction(
  _previous: InvoicingUiActionState,
  formData: FormData,
): Promise<InvoicingUiActionState> {
  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  const documentId = parseUuid(formData.get("documentId"));
  if (!workspaceId || !documentId) return { status: "invalid" };
  try {
    await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document",
      (tx, ctx) => markSentDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_SENT_COMMAND_VERSION,
        documentId,
      }),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/w/${workspaceId}/rechnungen`);
  return { status: "success" };
}

export async function setDocumentTermsAction(
  _previous: InvoicingUiActionState,
  formData: FormData,
): Promise<InvoicingUiActionState> {
  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  const documentId = parseUuid(formData.get("documentId"));
  if (!workspaceId || !documentId) return { status: "invalid" };
  const skontoPercentBps = parseSkontoPercent(formData.get("skontoPercent"));
  const skontoDays = parseSkontoDays(formData.get("skontoDays"));
  if (skontoPercentBps === undefined || skontoDays === undefined) return { status: "invalid" };
  const parsed = commercialDocumentTermsCommandV1Schema.safeParse({
    schemaVersion: COMMERCIAL_DOCUMENT_TERMS_COMMAND_VERSION,
    documentId,
    skontoPercentBps,
    skontoDays,
  });
  if (!parsed.success) return { status: "invalid" };
  try {
    await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document",
      (tx, ctx) => setDocumentTerms(tx, ctx, parsed.data),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/w/${workspaceId}/rechnungen`);
  return { status: "success" };
}

export async function voidDocumentAction(
  _previous: InvoicingUiActionState,
  formData: FormData,
): Promise<InvoicingUiActionState> {
  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  const documentId = parseUuid(formData.get("documentId"));
  const reasonValue = formData.get("reason");
  const reason = typeof reasonValue === "string" ? reasonValue : "";
  if (!workspaceId || !documentId) return { status: "invalid" };
  if (!(commercialVoidReasons as readonly string[]).includes(reason)) {
    return { status: "invalid" };
  }
  try {
    await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document",
      (tx, ctx) => voidDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
        documentId,
        reason: reason as CommercialVoidReason,
      }),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/w/${workspaceId}/rechnungen`);
  revalidatePath(`/w/${workspaceId}/rechnungen/berichte`);
  return { status: "success" };
}

export async function setDocumentArchivedAction(
  _previous: InvoicingUiActionState,
  formData: FormData,
): Promise<InvoicingUiActionState> {
  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  const documentId = parseUuid(formData.get("documentId"));
  if (!workspaceId || !documentId) return { status: "invalid" };
  try {
    await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document",
      (tx, ctx) => setDocumentArchived(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_ARCHIVE_COMMAND_VERSION,
        documentId,
        archived: formData.get("archived") === "true",
      }),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/w/${workspaceId}/rechnungen`);
  return { status: "success" };
}

// F8-01 · Anzahlung verlinken/entfernen (Schlussrechnung-Detail).
export async function linkDepositAction(
  _previous: InvoicingUiActionState,
  formData: FormData,
): Promise<InvoicingUiActionState> {
  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  const finalId = parseUuid(formData.get("finalId"));
  const depositId = parseUuid(formData.get("depositId"));
  const appliedCents = parseEuroCents(formData.get("appliedEur"));
  if (!workspaceId || !finalId || !depositId || appliedCents === null) return { status: "invalid" };
  try {
    await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document_deposit_link",
      (tx, ctx) => linkDeposit(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_LINK_COMMAND_VERSION,
        finalId,
        depositId,
        ...(appliedCents === undefined ? {} : { appliedCents }),
      }),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/w/${workspaceId}/rechnungen/invoice/${finalId}`);
  return { status: "success" };
}

export async function unlinkDepositAction(
  _previous: InvoicingUiActionState,
  formData: FormData,
): Promise<InvoicingUiActionState> {
  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  const finalId = parseUuid(formData.get("finalId"));
  const depositId = parseUuid(formData.get("depositId"));
  if (!workspaceId || !finalId || !depositId) return { status: "invalid" };
  try {
    await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document_deposit_link",
      (tx, ctx) => unlinkDeposit(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_UNLINK_COMMAND_VERSION,
        finalId,
        depositId,
      }),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/w/${workspaceId}/rechnungen/invoice/${finalId}`);
  return { status: "success" };
}

export type DuplicateDocumentActionState =
  | { status: "idle" }
  | { status: "success"; invoiceId: string }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "denied" }
  | { status: "unauthenticated" };

export type PartialInvoiceActionState =
  | { status: "idle" }
  | { status: "success"; invoiceId: string }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "denied" }
  | { status: "unauthenticated" };

// F8-05 · Teilrechnung zum Auftrag (Modi percent/lines). Prozent als
// Dezimal-Prozent (0 < p ≤ 100, zwei Stellen) → Basispunkte ohne Float:
// Math.round(p * 100), danach Schema-Range 1–10000. F8-12 · remainder:
// Anteil VOM REST (0 < p < 100, Range 1–9999; 100 % ist closing).
// F8-13 · amount: Euro-Betrag (0 < €, zwei Stellen) → Cent ohne Float:
// Math.round(€ * 100), danach Service gegen Ketten-Rest (Conflict).
export async function createPartialInvoiceAction(
  _previous: PartialInvoiceActionState,
  formData: FormData,
): Promise<PartialInvoiceActionState> {
  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  const documentId = parseUuid(formData.get("documentId"));
  const modeValue = formData.get("mode");
  const mode = modeValue === "percent" || modeValue === "lines" || modeValue === "scheme" || modeValue === "closing" || modeValue === "remainder" || modeValue === "amount" ? modeValue : null;
  if (!workspaceId || !documentId || !mode) return { status: "invalid" };
  let percentBps: number | null = null;
  let amountCents: number | null = null;
  let lineIds: string[] | null = null;
  if (mode === "scheme" || mode === "closing") {
    // F8-07/F8-08: Tranche/Rest folgt aus der Kette (kein Prozent-Input).
  } else if (mode === "amount") {
    // F8-13: Euro-Betrag (Dezimal, zwei Stellen) → Cent ohne Float.
    const raw = formData.get("amount");
    const euros = typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(euros) || euros <= 0) return { status: "invalid" };
    amountCents = Math.round(euros * 100);
    if (amountCents < 1) return { status: "invalid" };
  } else if (mode === "percent" || mode === "remainder") {
    const raw = formData.get("percent");
    const percent = typeof raw === "string" ? Number(raw) : NaN;
    // F8-12: Teil-Rest ist ein echter Teil (0 < p < 100); 100 % ist
    // die Rest-Schlussrechnung (closing-Modus).
    if (!Number.isFinite(percent) || percent <= 0) return { status: "invalid" };
    if (mode === "remainder" ? percent >= 100 : percent > 100) return { status: "invalid" };
    percentBps = Math.round(percent * 100);
    if (percentBps < 1 || percentBps > (mode === "remainder" ? 9999 : 10000)) return { status: "invalid" };
  } else {
    const raw = formData.getAll("lineIds").filter((value): value is string => typeof value === "string");
    const unique = [...new Set(raw)];
    if (unique.length === 0 || unique.length > 200) return { status: "invalid" };
    if (!unique.every((value) => z.uuid().safeParse(value).success)) return { status: "invalid" };
    lineIds = unique;
  }
  try {
    const result = await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document_partial",
      (tx, ctx) => createPartialInvoice(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
        orderId: documentId,
        mode,
        percentBps,
        amountCents,
        lineIds,
      }),
    );
    revalidatePath(`/w/${workspaceId}/rechnungen/invoice`);
    revalidatePath(`/w/${workspaceId}/rechnungen/order_confirmation/${documentId}`);
    return { status: "success", invoiceId: result.id };
  } catch (error) {
    const mapped = mapError(error);
    if (mapped.status === "success" || mapped.status === "precondition") {
      return { status: "invalid" };
    }
    return mapped;
  }
}

// F8-04b · AB als Rechnung übernehmen (Duplicate into type, nur AB).
export async function duplicateDocumentAction(
  _previous: DuplicateDocumentActionState,
  formData: FormData,
): Promise<DuplicateDocumentActionState> {
  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  const documentId = parseUuid(formData.get("documentId"));
  if (!workspaceId || !documentId) return { status: "invalid" };
  try {
    const result = await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document",
      (tx, ctx) => duplicateOrderConfirmationAsInvoice(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_DUPLICATE_COMMAND_VERSION,
        sourceDocumentId: documentId,
      }),
    );
    revalidatePath(`/w/${workspaceId}/rechnungen/invoice`);
    revalidatePath(`/w/${workspaceId}/rechnungen/order_confirmation/${documentId}`);
    return { status: "success", invoiceId: result.id };
  } catch (error) {
    const mapped = mapError(error);
    if (mapped.status === "success" || mapped.status === "precondition") {
      return { status: "invalid" };
    }
    return mapped;
  }
}
