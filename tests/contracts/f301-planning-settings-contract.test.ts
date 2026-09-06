import { describe, expect, it } from "vitest";

import {
  PLANNING_MODE_DEFAULT,
  PLANNING_SETTINGS_MAX_REVISION,
  WORKSPACE_PLANNING_SETTINGS_COMMAND_VERSION,
  WORKSPACE_PLANNING_SETTINGS_VERSION,
  planningModeSchema,
  planningSettingsCommandV1Schema,
  planningSettingsV1Schema,
  type PlanningMode,
} from "@/lib/integrations/planning/contract";

describe("F3.1 Workspace-Planungsstandard — Contract", () => {
  it("F301-CON-01: kennt exakt Quick, 2D und 3D mit 3D als Produktfallback", () => {
    expect(planningModeSchema.options).toEqual(["quick", "2d", "3d"]);
    expect(PLANNING_MODE_DEFAULT).toBe("3d");

    for (const mode of ["quick", "2d", "3d"] satisfies PlanningMode[]) {
      expect(planningModeSchema.safeParse(mode).success).toBe(true);
    }
    for (const value of ["Quick", "2D", "3D", "", null, 3]) {
      expect(planningModeSchema.safeParse(value).success).toBe(false);
    }
  });

  it("F301-CON-02: erzwingt einen strikten revisionsgebundenen Write-Command", () => {
    const command = {
      schemaVersion: WORKSPACE_PLANNING_SETTINGS_COMMAND_VERSION,
      baseRevision: 0,
      defaultPlanningMode: "3d" as const,
    };
    expect(planningSettingsCommandV1Schema.safeParse(command).success).toBe(true);
    expect(planningSettingsCommandV1Schema.safeParse({
      ...command,
      baseRevision: PLANNING_SETTINGS_MAX_REVISION,
    }).success).toBe(true);

    for (const candidate of [
      { ...command, baseRevision: -1 },
      { ...command, baseRevision: 0.5 },
      { ...command, baseRevision: PLANNING_SETTINGS_MAX_REVISION + 1 },
      { ...command, defaultPlanningMode: "4d" },
      { ...command, actorId: "client-controlled" },
      { ...command, schemaVersion: "workspace-planning-settings-command.v2" },
    ]) {
      expect(planningSettingsCommandV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("F301-CON-03: validiert das virtuelle Leerstands-DTO 3D/Revision 0 strikt", () => {
    const virtualSettings = {
      schemaVersion: WORKSPACE_PLANNING_SETTINGS_VERSION,
      revision: 0,
      defaultPlanningMode: PLANNING_MODE_DEFAULT,
      permissions: { canWrite: false },
    };
    expect(planningSettingsV1Schema.parse(virtualSettings)).toEqual(virtualSettings);
    expect(planningSettingsV1Schema.safeParse({
      ...virtualSettings,
      revision: -1,
    }).success).toBe(false);
    expect(planningSettingsV1Schema.safeParse({
      ...virtualSettings,
      permissions: { canWrite: false, canDelete: true },
    }).success).toBe(false);
    expect(planningSettingsV1Schema.safeParse({
      ...virtualSettings,
      internalComment: "must not escape",
    }).success).toBe(false);
  });
});
