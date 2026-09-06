import { z } from "zod";

export const WORKSPACE_PLANNING_SETTINGS_VERSION =
  "workspace-planning-settings.v1" as const;
export const WORKSPACE_PLANNING_SETTINGS_COMMAND_VERSION =
  "workspace-planning-settings-command.v1" as const;
export const PLANNING_MODE_DEFAULT_LOCK_VERSION =
  "workspace-planning-mode-default-lock.v1" as const;
export const PLANNING_SETTINGS_MAX_REVISION = 2_147_483_647 as const;

export const planningModeSchema = z.enum(["quick", "2d", "3d"]);
export type PlanningMode = z.infer<typeof planningModeSchema>;
export const PLANNING_MODE_DEFAULT = "3d" as const satisfies PlanningMode;

const revisionSchema = z.number().int().min(0).max(PLANNING_SETTINGS_MAX_REVISION);

export const planningSettingsCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_PLANNING_SETTINGS_COMMAND_VERSION),
  baseRevision: revisionSchema,
  defaultPlanningMode: planningModeSchema,
});
export type PlanningSettingsCommandV1 = z.infer<
  typeof planningSettingsCommandV1Schema
>;

export const planningSettingsV1Schema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_PLANNING_SETTINGS_VERSION),
  revision: revisionSchema,
  defaultPlanningMode: planningModeSchema,
  permissions: z.strictObject({ canWrite: z.boolean() }),
});
export type PlanningSettingsV1 = z.infer<typeof planningSettingsV1Schema>;
