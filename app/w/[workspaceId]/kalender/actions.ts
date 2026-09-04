"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  AppointmentNotFoundError,
  AppointmentValidationError,
  archiveCalendar,
  createTenancyCalendar,
} from "@/modules/calendar";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type CalendarActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

export async function createCalendarAction(
  _previous: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const workspaceValue = formData.get("workspaceId");
  const nameValue = formData.get("name");
  const colorValue = formData.get("color");
  if (typeof workspaceValue !== "string" || typeof nameValue !== "string") {
    return { status: "invalid" };
  }
  const workspace = workspaceIdSchema.safeParse(workspaceValue);
  if (!workspace.success) return { status: "invalid" };
  const name = nameValue.normalize("NFKC").trim();
  if (name.length < 1 || name.length > 200) return { status: "invalid" };
  const color = typeof colorValue === "string" && colorValue.trim() !== ""
    ? (colorValue.trim().match(/^#[0-9a-fA-F]{6}$/u) ? colorValue.trim() : null)
    : null;
  if (colorValue && typeof colorValue === "string" && colorValue.trim() !== "" && color === null) {
    return { status: "invalid" };
  }

  try {
    await authorizedAction(workspace.data, "calendar.write", "calendar", (tx, ctx) =>
      createTenancyCalendar(tx, ctx, { name, color }),
    );
    revalidatePath(`/w/${workspace.data}/kalender`);
    return { status: "success", message: "Kalender angelegt." };
  } catch (error) {
    if (error instanceof AppointmentValidationError) return { status: "invalid" };
    if (error instanceof AppointmentNotFoundError) return { status: "not_found" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    throw error;
  }
}

export async function archiveCalendarAction(
  _previous: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const workspaceValue = formData.get("workspaceId");
  const idValue = formData.get("id");
  if (typeof workspaceValue !== "string" || typeof idValue !== "string") {
    return { status: "invalid" };
  }
  const workspace = workspaceIdSchema.safeParse(workspaceValue);
  const id = idSchema.safeParse(idValue);
  if (!workspace.success || !id.success) return { status: "invalid" };
  try {
    await authorizedAction(workspace.data, "calendar.write", "calendar", (tx, ctx) =>
      archiveCalendar(tx, ctx, id.data),
    );
    revalidatePath(`/w/${workspace.data}/kalender`);
    return { status: "success", message: "Kalender archiviert." };
  } catch (error) {
    if (error instanceof AppointmentNotFoundError) return { status: "not_found" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    throw error;
  }
}
