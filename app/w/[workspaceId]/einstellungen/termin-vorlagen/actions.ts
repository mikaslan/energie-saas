"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { APPOINTMENT_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/calendar/template-contract";
import {
  archiveAppointmentTemplate,
  createAppointmentTemplate,
  restoreAppointmentTemplate,
  AppointmentTemplateConflictError,
  AppointmentTemplateNotFoundError,
  AppointmentTemplateValidationError,
  updateAppointmentTemplate,
} from "@/modules/calendar";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type AppointmentTemplateActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseWorkspace(formData: FormData): string | null {
  const value = formData.get("workspaceId");
  if (typeof value !== "string") return null;
  const parsed = workspaceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseText(value: FormDataEntryValue | null, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").trim();
  if (text.length < 1 || text.length > max || /[\p{Cc}\p{Cf}]/u.test(text)) return null;
  return text;
}

// Dauer in Minuten, Pflicht, 1..2880.
function parseDuration(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || !/^\d{1,4}$/u.test(value.trim())) return null;
  const minutes = Number(value.trim());
  return Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 2880 ? minutes : null;
}

function parseFields(formData: FormData):
  | { name: string; title: string; durationMinutes: number; position: number }
  | null {
  const name = parseText(formData.get("name"), 200);
  const title = parseText(formData.get("title"), 200);
  const positionValue = formData.get("position");
  const durationMinutes = parseDuration(formData.get("durationMinutes"));
  if (name === null || title === null || durationMinutes === null) return null;
  if (typeof positionValue !== "string" || !/^\d+$/u.test(positionValue)) return null;
  const position = Number(positionValue);
  if (!Number.isSafeInteger(position) || position < 0) return null;
  return { name, title, durationMinutes, position };
}

function mapError(error: unknown): AppointmentTemplateActionState {
  if (error instanceof AppointmentTemplateValidationError) return { status: "invalid" };
  if (error instanceof AppointmentTemplateConflictError) return { status: "conflict" };
  if (error instanceof AppointmentTemplateNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

const SETTINGS_PATH = (workspace: string): string => `/w/${workspace}/einstellungen/termin-vorlagen`;

export async function createAppointmentTemplateAction(
  _previous: AppointmentTemplateActionState,
  formData: FormData,
): Promise<AppointmentTemplateActionState> {
  const workspace = parseWorkspace(formData);
  if (!workspace) return { status: "invalid" };
  const fields = parseFields(formData);
  if (!fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "appointment.write", "appointment_template", (tx, ctx) =>
      createAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        ...fields,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Vorlage angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updateAppointmentTemplateAction(
  _previous: AppointmentTemplateActionState,
  formData: FormData,
): Promise<AppointmentTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  if (!workspace || typeof idValue !== "string") return { status: "invalid" };
  const parsedId = idSchema.safeParse(idValue);
  const fields = parseFields(formData);
  if (!parsedId.success || !fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "appointment.write", "appointment_template", (tx, ctx) =>
      updateAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        id: parsedId.data,
        ...fields,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Vorlage gespeichert." };
  } catch (error) {
    return mapError(error);
  }
}

async function setActive(
  formData: FormData,
  active: boolean,
  message: string,
): Promise<AppointmentTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  if (!workspace || typeof idValue !== "string") return { status: "invalid" };
  const parsedId = idSchema.safeParse(idValue);
  if (!parsedId.success) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "appointment.write", "appointment_template", (tx, ctx) =>
      active
        ? restoreAppointmentTemplate(tx, ctx, {
          schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
          id: parsedId.data,
          active,
        })
        : archiveAppointmentTemplate(tx, ctx, {
          schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
          id: parsedId.data,
          active,
        }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveAppointmentTemplateAction(
  _previous: AppointmentTemplateActionState,
  formData: FormData,
): Promise<AppointmentTemplateActionState> {
  return setActive(formData, false, "Vorlage archiviert.");
}

export async function restoreAppointmentTemplateAction(
  _previous: AppointmentTemplateActionState,
  formData: FormData,
): Promise<AppointmentTemplateActionState> {
  return setActive(formData, true, "Vorlage reaktiviert.");
}
