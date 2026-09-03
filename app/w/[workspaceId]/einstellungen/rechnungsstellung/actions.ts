"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  WORKSPACE_DOCUMENT_NUMBER_FORMAT_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
  invoicingSettingsCommandV1Schema,
  numberFormatCommandV1Schema,
  companyCountries,
  type AccountingMethod,
  type CompanyCountry,
  type DocumentNumberType,
  type NumberFormatCommandV1,
  type InvoicingSettingsCommandV1,
} from "@/lib/integrations/invoicing/contract";
import {
  upsertInvoicingSettings,
  upsertNumberFormat,
  InvoicingConflictError,
  InvoicingNotFoundError,
  InvoicingPreconditionConflictError,
  InvoicingValidationError,
} from "@/modules/invoicing";

const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const POSITIVE_INTEGER_PATTERN = /^[0-9]\d*$/u;

export type InvoicingSettingsActionState =
  | { status: "idle" }
  | { status: "success"; revision: number; created: boolean }
  | { status: "invalid" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

export type NumberFormatActionState =
  | { status: "idle" }
  | { status: "success"; type: DocumentNumberType }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseRevision(value: string | undefined): number | null {
  if (value === undefined || !POSITIVE_INTEGER_PATTERN.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

function textOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function mapSettingsError(error: unknown): InvoicingSettingsActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof InvoicingValidationError) return { status: "invalid" };
  if (error instanceof InvoicingNotFoundError) return { status: "not_found" };
  if (error instanceof InvoicingConflictError) {
    return error.currentRevision === undefined
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  return null;
}

export async function saveInvoicingSettings(
  rawWorkspaceId: string,
  _previousState: InvoicingSettingsActionState,
  formData: FormData,
): Promise<InvoicingSettingsActionState> {
  const workspaceId = UUID_SCHEMA.safeParse(rawWorkspaceId);
  if (!workspaceId.success) return { status: "invalid" };

  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return { status: "invalid" };
    if (name.startsWith("$ACTION")) continue;
    values.set(name, value);
  }
  if (values.get("schemaVersion") !== WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION) {
    return { status: "invalid" };
  }
  const baseRevision = parseRevision(values.get("baseRevision"));
  if (baseRevision === null) return { status: "invalid" };

  const command: InvoicingSettingsCommandV1 = {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision,
    input: {
      companyName: values.get("companyName") ?? "",
      companyEmail: values.get("companyEmail") ?? "",
      companyAuthority: textOrNull(values.get("companyAuthority")),
      companyRegisterNumber: textOrNull(values.get("companyRegisterNumber")),
      companyTaxId: textOrNull(values.get("companyTaxId")),
      companyAddressLine1: values.get("companyAddressLine1") ?? "",
      companyAddressLine2: textOrNull(values.get("companyAddressLine2")),
      companyPostalCode: values.get("companyPostalCode") ?? "",
      companyCity: values.get("companyCity") ?? "",
      companyCountry: (values.get("companyCountry") ?? "") as CompanyCountry,
      accountingMethod: (values.get("accountingMethod") ?? "") as AccountingMethod,
      paymentAccountHolder: textOrNull(values.get("paymentAccountHolder")),
      paymentIban: textOrNull(values.get("paymentIban")),
      paymentBic: textOrNull(values.get("paymentBic")),
      goebdRetentionDefaultDays: Number(values.get("goebdRetentionDefaultDays") ?? "0"),
    },
  };

  if (!invoicingSettingsCommandV1Schema.safeParse(command).success) {
    return { status: "invalid" };
  }

  try {
    const result = await authorizedAction(
      workspaceId.data,
      "invoicing.write",
      "workspace_invoicing_settings",
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, command),
    );
    revalidatePath(`/w/${workspaceId.data}/einstellungen/rechnungsstellung`);
    return { status: "success", revision: result.revision, created: result.created };
  } catch (error) {
    return mapSettingsError(error) ?? { status: "invalid" };
  }
}

export async function saveNumberFormat(
  rawWorkspaceId: string,
  _previousState: NumberFormatActionState,
  formData: FormData,
): Promise<NumberFormatActionState> {
  const workspaceId = UUID_SCHEMA.safeParse(rawWorkspaceId);
  if (!workspaceId.success) return { status: "invalid" };

  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return { status: "invalid" };
    if (name.startsWith("$ACTION")) continue;
    values.set(name, value);
  }
  if (values.get("schemaVersion") !== WORKSPACE_DOCUMENT_NUMBER_FORMAT_COMMAND_VERSION) {
    return { status: "invalid" };
  }

  const command = {
    schemaVersion: WORKSPACE_DOCUMENT_NUMBER_FORMAT_COMMAND_VERSION,
    type: values.get("type"),
    formatTemplate: values.get("formatTemplate") ?? "",
  } as NumberFormatCommandV1;
  if (!numberFormatCommandV1Schema.safeParse(command).success) {
    return { status: "invalid" };
  }

  try {
    await authorizedAction(
      workspaceId.data,
      "invoicing.write",
      "workspace_document_number_format",
      (tx, ctx) => upsertNumberFormat(tx, ctx, command),
    );
    revalidatePath(`/w/${workspaceId.data}/einstellungen/rechnungsstellung`);
    return { status: "success", type: command.type };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof InvoicingValidationError) return { status: "invalid" };
    if (error instanceof InvoicingNotFoundError) return { status: "not_found" };
    return { status: "invalid" };
  }
}
