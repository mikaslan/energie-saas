"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CONTACT_MAX_REVISION,
  CONTACT_UPDATE_COMMAND_VERSION,
  ContactConflictError,
  ContactDeletedError,
  ContactNotFoundError,
  ContactValidationError,
  updateContact,
  type ContactUpdateCommandV1,
} from "@/modules/contacts";

const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;

export type ContactActionState =
  | { status: "idle" }
  | { status: "success"; contactId: string; revision: number; changedFields: string[] }
  | { status: "invalid" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "not_found" }
  | { status: "deleted_contact" }
  | { status: "denied" }
  | { status: "unauthenticated" };

// Leere Felder bedeuten "löschen" (NULL); die Service-Schicht filtert
// unveränderte Werte heraus. is_business wird als fester Boolean übertragen.
const NULLABLE_TEXT_FIELDS = [
  "firstName",
  "lastName",
  "salutation",
  "emailSecondary",
  "phoneMobile",
  "phoneReachability",
  "addressStreet",
  "addressHouseNumber",
  "addressPostalCode",
  "addressCity",
  "addressCountry",
  "marketingConsentPolicyVersion",
  "marketingConsentText",
  "marketingConsentDataProtectionLink",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
] as const;

function normalizePhone(raw: string): string | null {
  const trimmed = raw.normalize("NFKC").trim();
  if (!trimmed) return null;
  let compact = trimmed.replace(/[\s()./\-]/g, "");
  if (compact.startsWith("00")) compact = `+${compact.slice(2)}`;
  else if (compact.startsWith("0")) compact = `+49${compact.slice(1)}`;
  return /^\+[1-9][0-9]{1,14}$/.test(compact) ? compact : null;
}

function trimOrEmpty(value: string): string {
  return value.trim();
}

function parseRevision(value: string | undefined): number | null {
  if (!value || !POSITIVE_INTEGER_PATTERN.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision <= CONTACT_MAX_REVISION
    ? revision
    : null;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function mapError(error: unknown): ContactActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof ContactValidationError) return { status: "invalid" };
  if (error instanceof ContactNotFoundError) return { status: "not_found" };
  if (error instanceof ContactDeletedError) return { status: "deleted_contact" };
  if (error instanceof ContactConflictError) {
    return error.currentRevision === undefined
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  return null;
}

export async function changeContact(
  rawWorkspaceId: string,
  rawBoundProjectId: string,
  _previousState: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  const route = z.strictObject({
    workspaceId: UUID_SCHEMA,
    projectId: UUID_SCHEMA,
  }).safeParse({ workspaceId: rawWorkspaceId, projectId: rawBoundProjectId });

  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return { status: "invalid" };
    if (name.startsWith("$ACTION")) continue;
    values.set(name, value);
  }

  if (
    !route.success
    || values.get("projectId") !== route.data.projectId
    || values.get("schemaVersion") !== CONTACT_UPDATE_COMMAND_VERSION
  ) return { status: "invalid" };

  const expectedRevision = parseRevision(values.get("expectedRevision"));
  const isBusiness = parseBoolean(values.get("isBusiness"));
  if (expectedRevision === null || isBusiness === null) return { status: "invalid" };

  const patch: Record<string, unknown> = { isBusiness };
  for (const field of NULLABLE_TEXT_FIELDS) {
    const raw = values.get(field);
    if (raw === undefined) continue;
    let value: string | null = raw === "" ? null : trimOrEmpty(raw);
    if (field === "emailSecondary" && value !== null) value = value.toLowerCase();
    if (field === "phoneMobile" && value !== null) {
      value = normalizePhone(value);
      if (value === null) return { status: "invalid" };
    }
    patch[field] = value;
  }

  const command: ContactUpdateCommandV1 = {
    schemaVersion: CONTACT_UPDATE_COMMAND_VERSION,
    projectId: route.data.projectId,
    expectedRevision,
    patch: patch as ContactUpdateCommandV1["patch"],
  };

  try {
    const result = await authorizedAction(
      route.data.workspaceId,
      "contact.write",
      "contact",
      (tx, ctx) => updateContact(tx, ctx, command),
    );
    revalidatePath(`/w/${route.data.workspaceId}/anfragen/${route.data.projectId}`);
    return {
      status: "success",
      contactId: result.contactId,
      revision: result.revision,
      changedFields: result.changedFields,
    };
  } catch (error) {
    const mapped = mapError(error);
    if (mapped?.status === "conflict") {
      revalidatePath(`/w/${route.data.workspaceId}/anfragen/${route.data.projectId}`);
    }
    return mapped ?? { status: "invalid" };
  }
}
