"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  OFFER_PAYMENT_OPTION_COMMAND_VERSION,
  PAYMENT_OPTION_KEYS,
  type CreatePaymentOptionCommand,
  type UpdatePaymentOptionCommand,
} from "@/lib/integrations/offers/contract";
import {
  archivePaymentOption,
  createPaymentOption,
  PaymentOptionConflictError,
  PaymentOptionNotFoundError,
  PaymentOptionValidationError,
  restorePaymentOption,
  updatePaymentOption,
} from "@/modules/offers";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type PaymentOptionActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid"; message?: string }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseLabel(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.normalize("NFC").trim();
  if (trimmed.length < 1 || trimmed.length > 120) return null;
  return trimmed;
}

function parseKey(
  value: FormDataEntryValue | null,
): (typeof PAYMENT_OPTION_KEYS)[number] | null {
  if (typeof value !== "string") return null;
  return (PAYMENT_OPTION_KEYS as readonly string[]).includes(value)
    ? (value as (typeof PAYMENT_OPTION_KEYS)[number])
    : null;
}

function mapError(error: unknown): PaymentOptionActionState {
  if (error instanceof PaymentOptionValidationError) return { status: "invalid" };
  if (error instanceof PaymentOptionConflictError) return { status: "conflict" };
  if (error instanceof PaymentOptionNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

function parseWorkspace(formData: FormData): string | null {
  const workspaceValue = formData.get("workspaceId");
  if (typeof workspaceValue !== "string") return null;
  const workspace = workspaceIdSchema.safeParse(workspaceValue);
  return workspace.success ? workspace.data : null;
}

export async function createPaymentOptionAction(
  _previous: PaymentOptionActionState,
  formData: FormData,
): Promise<PaymentOptionActionState> {
  const workspace = parseWorkspace(formData);
  const key = parseKey(formData.get("key"));
  const label = parseLabel(formData.get("label"));
  if (!workspace || key === null || label === null) return { status: "invalid" };

  const command: CreatePaymentOptionCommand = {
    schemaVersion: OFFER_PAYMENT_OPTION_COMMAND_VERSION,
    key,
    label,
  };
  try {
    await authorizedAction(workspace, "payment_option.write", "payment_option", (tx, ctx) =>
      createPaymentOption(tx, ctx, command),
    );
    revalidatePath(`/w/${workspace}/einstellungen/zahlarten`);
    return { status: "success", message: "Zahlart angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updatePaymentOptionAction(
  _previous: PaymentOptionActionState,
  formData: FormData,
): Promise<PaymentOptionActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  const label = parseLabel(formData.get("label"));
  if (!workspace || !id?.success || label === null) return { status: "invalid" };

  const command: UpdatePaymentOptionCommand = {
    schemaVersion: OFFER_PAYMENT_OPTION_COMMAND_VERSION,
    id: id.data,
    label,
  };
  try {
    await authorizedAction(workspace, "payment_option.write", "payment_option", (tx, ctx) =>
      updatePaymentOption(tx, ctx, command),
    );
    revalidatePath(`/w/${workspace}/einstellungen/zahlarten`);
    return { status: "success", message: "Zahlart aktualisiert." };
  } catch (error) {
    return mapError(error);
  }
}

async function toggleArchived(
  workspace: string,
  id: string,
  archive: boolean,
): Promise<PaymentOptionActionState> {
  try {
    await authorizedAction(workspace, "payment_option.write", "payment_option", (tx, ctx) =>
      archive ? archivePaymentOption(tx, ctx, id) : restorePaymentOption(tx, ctx, id),
    );
    revalidatePath(`/w/${workspace}/einstellungen/zahlarten`);
    return {
      status: "success",
      message: archive ? "Zahlart archiviert." : "Zahlart reaktiviert.",
    };
  } catch (error) {
    return mapError(error);
  }
}

export async function archivePaymentOptionAction(
  _previous: PaymentOptionActionState,
  formData: FormData,
): Promise<PaymentOptionActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleArchived(workspace, id.data, true);
}

export async function restorePaymentOptionAction(
  _previous: PaymentOptionActionState,
  formData: FormData,
): Promise<PaymentOptionActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleArchived(workspace, id.data, false);
}
