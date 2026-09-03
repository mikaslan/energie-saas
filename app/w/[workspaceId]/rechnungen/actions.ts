"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import {
  COMMERCIAL_DOCUMENT_ARCHIVE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_ARCHIVE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_SENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  commercialDocumentCommandV1Schema,
  commercialDocumentGroupCommandV1Schema,
  commercialVoidReasons,
  type CommercialVoidReason,
} from "@/lib/integrations/invoicing/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  createDocument,
  createDocumentGroup,
  issueDocument,
  markSentDocument,
  setDocumentArchived,
  setDocumentGroupArchived,
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
  const parsed = commercialDocumentCommandV1Schema.safeParse({
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input: {
      type,
      name: nameValue,
      groupId: typeof groupValue === "string" && groupValue !== "" ? groupValue : null,
      projectId: null,
      contactId: null,
      dueDate: optionalDate(dueDateValue),
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
