"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  ensureSubsidyCase,
  SubsidyCaseNotFoundError,
  subsidyCasePrograms,
  subsidyCaseStatuses,
  SubsidyCaseValidationError,
  setSubsidyCaseDetails,
  transitionSubsidyCase,
  type SubsidyCaseProgram,
  type SubsidyCaseStatus,
} from "@/modules/subsidy-cases";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type SubsidyCaseActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseIds(formData: FormData): { workspaceId: string; projectId: string } | null {
  const workspaceId = workspaceIdSchema.safeParse(formData.get("workspaceId"));
  const projectId = uuidSchema.safeParse(formData.get("projectId"));
  if (!workspaceId.success || !projectId.success) return null;
  return { workspaceId: workspaceId.data, projectId: projectId.data };
}

function mapError(error: unknown): SubsidyCaseActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof SubsidyCaseNotFoundError) return { status: "not_found" };
  if (error instanceof SubsidyCaseValidationError) return { status: "invalid" };
  throw error;
}

function detailPath(workspaceId: string, projectId: string): string {
  return `/w/${workspaceId}/anfragen/${projectId}`;
}

// F13-03: Anlage ist idempotent (ein Datensatz je Projekt).
export async function ensureSubsidyCaseAction(
  _previous: SubsidyCaseActionState,
  formData: FormData,
): Promise<SubsidyCaseActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "subsidy_case", (tx, ctx) =>
      ensureSubsidyCase(tx, ctx, ids.projectId),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Förderakte angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

function optionalProgram(value: FormDataEntryValue | null): SubsidyCaseProgram | null {
  if (typeof value !== "string" || value === "") return null;
  if (!(subsidyCasePrograms as readonly string[]).includes(value)) return null;
  return value as SubsidyCaseProgram;
}

function optionalText(value: FormDataEntryValue | null, max: number): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim().slice(0, max);
}

export async function setSubsidyCaseDetailsAction(
  _previous: SubsidyCaseActionState,
  formData: FormData,
): Promise<SubsidyCaseActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const program = optionalProgram(formData.get("program"));
  const rawBza = optionalText(formData.get("bzaNumber"), 64);
  if (formData.get("program") !== null && typeof formData.get("program") === "string"
    && (formData.get("program") as string) !== "" && program === null) {
    return { status: "invalid" };
  }
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "subsidy_case", (tx, ctx) =>
      setSubsidyCaseDetails(tx, ctx, {
        projectId: ids.projectId,
        program,
        bzaNumber: rawBza,
      }),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Angaben gespeichert." };
  } catch (error) {
    return mapError(error);
  }
}

export async function transitionSubsidyCaseAction(
  _previous: SubsidyCaseActionState,
  formData: FormData,
): Promise<SubsidyCaseActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const statusValue = formData.get("status");
  const status = typeof statusValue === "string" ? statusValue : "";
  if (!(subsidyCaseStatuses as readonly string[]).includes(status)) {
    return { status: "invalid" };
  }
  try {
    const changed = await authorizedAction(ids.workspaceId, "installation.write", "subsidy_case", (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, {
        projectId: ids.projectId,
        status: status as SubsidyCaseStatus,
      }),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    // F13-05: Versand-Nebeneffekt ehrlich melden; das Token erscheint
    // genau einmal hier (Muster F10-01-Einmalanzeige).
    const activation = changed.portalActivation;
    if (activation.outcome === "created" && activation.token !== null) {
      return {
        status: "success",
        message: `Status geändert. Kundenportal-Link erstellt: /p/${activation.token} — jetzt kopieren, er wird nicht erneut angezeigt.`,
      };
    }
    if (activation.outcome === "already_active") {
      return { status: "success", message: "Status geändert. Kundenportal-Link bereits aktiv." };
    }
    if (activation.outcome === "not_permitted") {
      return {
        status: "success",
        message: "Status geändert. Portal-Link nicht erstellt (fehlende Portal-Berechtigung).",
      };
    }
    return { status: "success", message: "Status geändert." };
  } catch (error) {
    if (error instanceof SubsidyCaseValidationError) return { status: "conflict" };
    return mapError(error);
  }
}
