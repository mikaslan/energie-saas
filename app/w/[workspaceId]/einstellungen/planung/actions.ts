"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import {
  PLANNING_SETTINGS_MAX_REVISION,
  WORKSPACE_PLANNING_SETTINGS_COMMAND_VERSION,
  planningModeSchema,
  type PlanningSettingsCommandV1,
} from "@/lib/integrations/planning/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PlanningSettingsConflictError,
  PlanningSettingsIntegrityError,
  PlanningSettingsValidationError,
  upsertPlanningSettings,
} from "@/modules/planning";

const REACT_ACTION_FIELD_PATTERN =
  /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const WORKSPACE_ID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const PLANNING_SETTINGS_FIELDS = new Set([
  "schemaVersion",
  "workspaceId",
  "baseRevision",
  "defaultPlanningMode",
]);

const planningSettingsFormSchema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_PLANNING_SETTINGS_COMMAND_VERSION),
  workspaceId: WORKSPACE_ID_SCHEMA,
  baseRevision: z.string().regex(INTEGER_PATTERN).transform(Number).pipe(
    z.int().safe().min(0).max(PLANNING_SETTINGS_MAX_REVISION),
  ),
  defaultPlanningMode: planningModeSchema,
});

export type PlanningSettingsActionState =
  | { status: "idle" }
  | { status: "success"; revision: number; created: boolean }
  | { status: "invalid" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "denied" }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

function exactStringEntries(
  formData: FormData,
  allowedFields: ReadonlySet<string>,
): Record<string, string> | null {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
    if (name.startsWith("$ACTION")) {
      if (!REACT_ACTION_FIELD_PATTERN.test(name)) return null;
      values.set(name, value);
      continue;
    }
    if (!allowedFields.has(name)) return null;
    values.set(name, value);
  }
  const domainEntries = [...values].filter(([name]) => !name.startsWith("$ACTION"));
  if (
    domainEntries.length !== allowedFields.size
    || ![...allowedFields].every((name) => values.has(name))
  ) return null;
  return Object.fromEntries(domainEntries);
}

function workspaceForAdmission(formData: FormData): string | null {
  const values = formData.getAll("workspaceId");
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  const parsed = WORKSPACE_ID_SCHEMA.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}

export async function upsertPlanningSettingsAction(
  _previous: PlanningSettingsActionState,
  formData: FormData,
): Promise<PlanningSettingsActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  const entries = exactStringEntries(formData, PLANNING_SETTINGS_FIELDS);
  const parsed = entries === null
    ? null
    : planningSettingsFormSchema.safeParse(entries);
  if (!parsed || !parsed.success || parsed.data.workspaceId !== workspaceId) {
    return { status: "invalid" };
  }

  const command: PlanningSettingsCommandV1 = {
    schemaVersion: parsed.data.schemaVersion,
    baseRevision: parsed.data.baseRevision,
    defaultPlanningMode: parsed.data.defaultPlanningMode,
  };

  try {
    const result = await authorizedAction(
      workspaceId,
      "settings.manage",
      "workspace_planning_settings",
      (tx, ctx) => upsertPlanningSettings(tx, ctx, command),
    );
    revalidatePath(`/w/${workspaceId}/einstellungen/planung`);
    return {
      status: "success",
      revision: result.revision,
      created: command.baseRevision === 0,
    };
  } catch (error) {
    if (error instanceof PlanningSettingsValidationError) {
      return { status: "invalid" };
    }
    if (error instanceof PlanningSettingsConflictError) {
      return error.currentRevision === undefined
        ? { status: "conflict" }
        : { status: "conflict", currentRevision: error.currentRevision };
    }
    if (error instanceof PlanningSettingsIntegrityError) {
      return { status: "unavailable" };
    }
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    throw error;
  }
}
