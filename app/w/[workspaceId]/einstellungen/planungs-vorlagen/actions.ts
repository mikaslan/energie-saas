"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { PLANNING_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/planning/template-contract";
import {
  archivePlanningTemplate,
  createPlanningTemplate,
  PlanningTemplateConflictError,
  PlanningTemplateNotFoundError,
  PlanningTemplateValidationError,
  restorePlanningTemplate,
  updatePlanningTemplate,
} from "@/modules/planning";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type PlanningTemplateActionState =
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

function parseFields(formData: FormData):
  | { name: string; mode: "quick" | "2d" | "3d"; position: number }
  | null {
  const name = parseText(formData.get("name"), 200);
  const modeValue = formData.get("mode");
  const mode = modeValue === "quick" || modeValue === "2d" || modeValue === "3d" ? modeValue : null;
  const positionValue = formData.get("position");
  if (name === null || mode === null) return null;
  if (typeof positionValue !== "string" || !/^\d+$/u.test(positionValue)) return null;
  const position = Number(positionValue);
  if (!Number.isSafeInteger(position) || position < 0) return null;
  return { name, mode, position };
}

function mapError(error: unknown): PlanningTemplateActionState {
  if (error instanceof PlanningTemplateValidationError) return { status: "invalid" };
  if (error instanceof PlanningTemplateConflictError) return { status: "conflict" };
  if (error instanceof PlanningTemplateNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

const SETTINGS_PATH = (workspace: string): string => `/w/${workspace}/einstellungen/planungs-vorlagen`;

export async function createPlanningTemplateAction(
  _previous: PlanningTemplateActionState,
  formData: FormData,
): Promise<PlanningTemplateActionState> {
  const workspace = parseWorkspace(formData);
  if (!workspace) return { status: "invalid" };
  const fields = parseFields(formData);
  if (!fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "project.write", "planning_template", (tx, ctx) =>
      createPlanningTemplate(tx, ctx, {
        schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
        ...fields,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Vorlage angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updatePlanningTemplateAction(
  _previous: PlanningTemplateActionState,
  formData: FormData,
): Promise<PlanningTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  if (!workspace || typeof idValue !== "string") return { status: "invalid" };
  const parsedId = idSchema.safeParse(idValue);
  const fields = parseFields(formData);
  if (!parsedId.success || !fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "project.write", "planning_template", (tx, ctx) =>
      updatePlanningTemplate(tx, ctx, {
        schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
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
): Promise<PlanningTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  if (!workspace || typeof idValue !== "string") return { status: "invalid" };
  const parsedId = idSchema.safeParse(idValue);
  if (!parsedId.success) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "project.write", "planning_template", (tx, ctx) =>
      active
        ? restorePlanningTemplate(tx, ctx, {
          schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
          id: parsedId.data,
          active,
        })
        : archivePlanningTemplate(tx, ctx, {
          schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
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

export async function archivePlanningTemplateAction(
  _previous: PlanningTemplateActionState,
  formData: FormData,
): Promise<PlanningTemplateActionState> {
  return setActive(formData, false, "Vorlage archiviert.");
}

export async function restorePlanningTemplateAction(
  _previous: PlanningTemplateActionState,
  formData: FormData,
): Promise<PlanningTemplateActionState> {
  return setActive(formData, true, "Vorlage reaktiviert.");
}
