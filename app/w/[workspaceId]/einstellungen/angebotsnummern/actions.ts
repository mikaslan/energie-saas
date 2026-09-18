"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  OFFER_NUMBER_FORMAT_COMMAND_VERSION,
  type SetOfferNumberFormatCommand,
} from "@/lib/integrations/offers/contract";
import {
  OfferNumberFormatConflictError,
  OfferNumberFormatValidationError,
  setOfferNumberFormat,
} from "@/modules/offers";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type NumberFormatActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid"; message?: string }
  | { status: "conflict" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function mapError(error: unknown): NumberFormatActionState {
  if (error instanceof OfferNumberFormatValidationError) return { status: "invalid" };
  if (error instanceof OfferNumberFormatConflictError) return { status: "conflict" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

function parsePrefix(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,8}$/u.test(normalized)) return null;
  return normalized;
}

function parsePadding(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 4 || parsed > 8) return null;
  return parsed;
}

function parseRevision(value: FormDataEntryValue | null): number | null {
  // Revision-CAS: null = Erstanlage, sonst exakte erwartete Revision.
  if (value === null || value === "") return null;
  if (typeof value !== "string") return -1;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return -1;
  return parsed;
}

export async function setOfferNumberFormatAction(
  _previous: NumberFormatActionState,
  formData: FormData,
): Promise<NumberFormatActionState> {
  const workspaceValue = formData.get("workspaceId");
  const workspace = typeof workspaceValue === "string"
    ? workspaceIdSchema.safeParse(workspaceValue)
    : null;
  const prefix = parsePrefix(formData.get("prefix"));
  const padding = parsePadding(formData.get("padding"));
  const isDefault = formData.get("isDefault") === "true";
  const expectedRevision = isDefault ? null : parseRevision(formData.get("revision"));
  if (!workspace?.success || prefix === null || padding === null || expectedRevision === -1) {
    return { status: "invalid" };
  }

  const command: SetOfferNumberFormatCommand = {
    schemaVersion: OFFER_NUMBER_FORMAT_COMMAND_VERSION,
    prefix,
    padding,
    expectedRevision,
  };
  try {
    await authorizedAction(
      workspace.data,
      "offer_number_format.write",
      "workspace_offer_number_format",
      (tx, ctx) => setOfferNumberFormat(tx, ctx, command),
    );
    revalidatePath(`/w/${workspace.data}/einstellungen/angebotsnummern`);
    return { status: "success", message: "Nummernformat gespeichert." };
  } catch (error) {
    return mapError(error);
  }
}
