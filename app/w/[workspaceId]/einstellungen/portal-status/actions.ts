"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  INSTALLATION_STATUS_FAQ_KEYS,
  INSTALLATION_STATUS_FAQ_MAX,
  INSTALLATION_STATUS_LABEL_KEYS,
  InstallationValidationError,
  resetInstallationStatusFaq,
  resetInstallationStatusLabel,
  upsertInstallationStatusFaq,
  upsertInstallationStatusLabel,
} from "@/modules/installations";

export type StatusLabelActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid"; message?: string }
  | { status: "denied" }
  | { status: "unauthenticated" };

export type StatusFaqActionState = StatusLabelActionState;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const keySchema = z.enum(INSTALLATION_STATUS_LABEL_KEYS);

const SETTINGS_PATH = (workspace: string): string => `/w/${workspace}/einstellungen/portal-status`;

function parseWorkspace(formData: FormData): string | null {
  const value = formData.get("workspaceId");
  if (typeof value !== "string") return null;
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseKey(formData: FormData): string | null {
  const value = formData.get("key");
  if (typeof value !== "string") return null;
  const parsed = keySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function mapError(error: unknown): StatusLabelActionState {
  if (error instanceof InstallationValidationError) {
    return { status: "invalid", message: "Eingaben prüfen (Bezeichnung 1–80 Zeichen, kein Leertext)." };
  }
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

export async function upsertStatusLabelAction(
  _previous: StatusLabelActionState,
  formData: FormData,
): Promise<StatusLabelActionState> {
  const workspace = parseWorkspace(formData);
  const key = parseKey(formData);
  const rawLabel = formData.get("label");
  if (!workspace || !key || typeof rawLabel !== "string") return { status: "invalid" };
  try {
    await authorizedAction(workspace, "installation.write", "portal_status_label", (tx, ctx) =>
      upsertInstallationStatusLabel(tx, ctx, { key, label: rawLabel }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Bezeichnung gespeichert." };
  } catch (error) {
    return mapError(error);
  }
}

export async function resetStatusLabelAction(
  _previous: StatusLabelActionState,
  formData: FormData,
): Promise<StatusLabelActionState> {
  const workspace = parseWorkspace(formData);
  const key = parseKey(formData);
  if (!workspace || !key) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "installation.write", "portal_status_label", (tx, ctx) =>
      resetInstallationStatusLabel(tx, ctx, { key }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Auf Standard zurückgesetzt." };
  } catch (error) {
    return mapError(error);
  }
}

const faqKeySchema = z.enum(INSTALLATION_STATUS_FAQ_KEYS);

function parseFaqKey(formData: FormData): string | null {
  const value = formData.get("key");
  if (typeof value !== "string") return null;
  const parsed = faqKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function mapFaqError(error: unknown): StatusFaqActionState {
  if (error instanceof InstallationValidationError) {
    return {
      status: "invalid",
      message: `Eingaben prüfen (FAQ 1–${INSTALLATION_STATUS_FAQ_MAX} Zeichen, kein Leertext).`,
    };
  }
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

// F10-09: FAQ je Anzeigestand (Muster Statusmapping; fehlende Zeile =
// kein FAQ-Block, Zurücksetzen löscht die Zeile).
export async function upsertStatusFaqAction(
  _previous: StatusFaqActionState,
  formData: FormData,
): Promise<StatusFaqActionState> {
  const workspace = parseWorkspace(formData);
  const key = parseFaqKey(formData);
  const rawFaq = formData.get("faq");
  if (!workspace || !key || typeof rawFaq !== "string") return { status: "invalid" };
  try {
    await authorizedAction(workspace, "installation.write", "portal_status_faq", (tx, ctx) =>
      upsertInstallationStatusFaq(tx, ctx, { key, faq: rawFaq }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "FAQ gespeichert." };
  } catch (error) {
    return mapFaqError(error);
  }
}

export async function resetStatusFaqAction(
  _previous: StatusFaqActionState,
  formData: FormData,
): Promise<StatusFaqActionState> {
  const workspace = parseWorkspace(formData);
  const key = parseFaqKey(formData);
  if (!workspace || !key) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "installation.write", "portal_status_faq", (tx, ctx) =>
      resetInstallationStatusFaq(tx, ctx, { key }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "FAQ entfernt." };
  } catch (error) {
    return mapFaqError(error);
  }
}
