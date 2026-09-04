"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  LEAD_SOURCE_COLOR_PATTERN,
  LEAD_SOURCE_DOMAINS,
  LEAD_SOURCE_NAME_MAX,
  LEAD_SOURCE_SCHEMA_VERSION,
  type CreateLeadSourceCommand,
  type UpdateLeadSourceCommand,
} from "@/lib/integrations/lead-sources/contract";
import {
  archiveLeadSource,
  createLeadSource,
  LeadSourceConflictError,
  LeadSourceNotFoundError,
  LeadSourceValidationError,
  restoreLeadSource,
  updateLeadSource,
} from "@/modules/lead-sources";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type LeadSourceActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid"; message?: string }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseName(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.normalize("NFKC").trim();
  if (trimmed.length < 1 || trimmed.length > LEAD_SOURCE_NAME_MAX) return null;
  return trimmed;
}

// Kimi-P3-2: unbekannter Domain-Wert (crafted Request) → "invalid" statt
// still zu null zu koerzieren — symmetrisch zur Farb-Validierung.
function parseDomain(
  value: FormDataEntryValue | null,
): "residential" | "commercial" | null | "invalid" {
  if (typeof value !== "string" || value === "") return null;
  return LEAD_SOURCE_DOMAINS.includes(value as (typeof LEAD_SOURCE_DOMAINS)[number])
    ? (value as "residential" | "commercial")
    : "invalid";
}

function parseColor(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim();
  return LEAD_SOURCE_COLOR_PATTERN.test(trimmed) ? trimmed : null;
}

function mapError(error: unknown): LeadSourceActionState {
  if (error instanceof LeadSourceValidationError) return { status: "invalid" };
  if (error instanceof LeadSourceConflictError) return { status: "conflict" };
  if (error instanceof LeadSourceNotFoundError) return { status: "not_found" };
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

export async function createLeadSourceAction(
  _previous: LeadSourceActionState,
  formData: FormData,
): Promise<LeadSourceActionState> {
  const workspace = parseWorkspace(formData);
  const name = parseName(formData.get("name"));
  if (!workspace || name === null) return { status: "invalid" };
  const domain = parseDomain(formData.get("projectDomain"));
  if (domain === "invalid") return { status: "invalid" };
  const colorValue = formData.get("color");
  // Ungültige Farbe → invalid, statt still zu nullen (transparente UI).
  const color = parseColor(colorValue);
  if (colorValue && typeof colorValue === "string" && colorValue.trim() !== "" && color === null) {
    return { status: "invalid", message: "Die Farbe muss im Format #RRGGBB angegeben werden." };
  }

  const command: CreateLeadSourceCommand = {
    schemaVersion: LEAD_SOURCE_SCHEMA_VERSION,
    name,
    projectDomain: domain,
    color,
  };
  try {
    await authorizedAction(workspace, "lead_source.write", "lead_source", (tx, ctx) =>
      createLeadSource(tx, ctx, command),
    );
    revalidatePath(`/w/${workspace}/einstellungen/lead-quellen`);
    return { status: "success", message: "Lead-Quelle angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updateLeadSourceAction(
  _previous: LeadSourceActionState,
  formData: FormData,
): Promise<LeadSourceActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  const name = parseName(formData.get("name"));
  if (!workspace || !id?.success || name === null) return { status: "invalid" };
  const domain = parseDomain(formData.get("projectDomain"));
  if (domain === "invalid") return { status: "invalid" };
  const colorValue = formData.get("color");
  const color = parseColor(colorValue);
  if (colorValue && typeof colorValue === "string" && colorValue.trim() !== "" && color === null) {
    return { status: "invalid", message: "Die Farbe muss im Format #RRGGBB angegeben werden." };
  }

  const command: UpdateLeadSourceCommand = {
    schemaVersion: LEAD_SOURCE_SCHEMA_VERSION,
    id: id.data,
    name,
    projectDomain: domain,
    color,
  };
  try {
    await authorizedAction(workspace, "lead_source.write", "lead_source", (tx, ctx) =>
      updateLeadSource(tx, ctx, command),
    );
    revalidatePath(`/w/${workspace}/einstellungen/lead-quellen`);
    return { status: "success", message: "Lead-Quelle aktualisiert." };
  } catch (error) {
    return mapError(error);
  }
}

async function toggleArchived(
  workspace: string,
  id: string,
  archive: boolean,
): Promise<LeadSourceActionState> {
  try {
    await authorizedAction(workspace, "lead_source.write", "lead_source", (tx, ctx) =>
      archive ? archiveLeadSource(tx, ctx, id) : restoreLeadSource(tx, ctx, id),
    );
    revalidatePath(`/w/${workspace}/einstellungen/lead-quellen`);
    return {
      status: "success",
      message: archive ? "Lead-Quelle archiviert." : "Lead-Quelle reaktiviert.",
    };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveLeadSourceAction(
  _previous: LeadSourceActionState,
  formData: FormData,
): Promise<LeadSourceActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleArchived(workspace, id.data, true);
}

export async function restoreLeadSourceAction(
  _previous: LeadSourceActionState,
  formData: FormData,
): Promise<LeadSourceActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleArchived(workspace, id.data, false);
}
