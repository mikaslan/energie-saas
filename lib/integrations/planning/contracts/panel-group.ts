import { z } from "zod";

// F3-04a manuelle Panel-Gruppe Stufe-0 — Client-sicherer Contract (keine
// Server-Imports). Rechteck-Raster je Dach; Rechteck-in-Polygon liegt in
// roof-restriction und wird vom Service direkt von dort importiert.
export const PLANNING_PANEL_GROUP_VERSION =
  "planning-panel-group.v1" as const;

export const PLANNING_PANEL_GROUP_ROWS_MIN = 1 as const;
export const PLANNING_PANEL_GROUP_ROWS_MAX = 200 as const;
export const PLANNING_PANEL_GROUP_COLS_MIN = 1 as const;
export const PLANNING_PANEL_GROUP_COLS_MAX = 200 as const;
export const PLANNING_PANEL_GROUP_MODULE_MIN_M = 0.1 as const;
export const PLANNING_PANEL_GROUP_MODULE_MAX_M = 5 as const;
export const PLANNING_PANEL_GROUP_GAP_MIN_M = 0 as const;
export const PLANNING_PANEL_GROUP_GAP_MAX_M = 2 as const;
export const PLANNING_PANEL_GROUP_TILT_MIN_DEG = 0 as const;
export const PLANNING_PANEL_GROUP_TILT_MAX_DEG = 90 as const;

export const planningPanelGroupKindSchema = z.enum(["h", "v"]);
export type PlanningPanelGroupKind = z.infer<
  typeof planningPanelGroupKindSchema
>;

export const planningPanelGroupOriginV1Schema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type PlanningPanelGroupOriginV1 = z.infer<
  typeof planningPanelGroupOriginV1Schema
>;

export const planningPanelGroupCreateV1Schema = z.strictObject({
  schemaVersion: z.literal(PLANNING_PANEL_GROUP_VERSION),
  kind: planningPanelGroupKindSchema,
  label: z.string().min(1),
  origin: planningPanelGroupOriginV1Schema,
  rows: z
    .number()
    .int()
    .min(PLANNING_PANEL_GROUP_ROWS_MIN)
    .max(PLANNING_PANEL_GROUP_ROWS_MAX),
  cols: z
    .number()
    .int()
    .min(PLANNING_PANEL_GROUP_COLS_MIN)
    .max(PLANNING_PANEL_GROUP_COLS_MAX),
  moduleWM: z
    .number()
    .finite()
    .min(PLANNING_PANEL_GROUP_MODULE_MIN_M)
    .max(PLANNING_PANEL_GROUP_MODULE_MAX_M),
  moduleHM: z
    .number()
    .finite()
    .min(PLANNING_PANEL_GROUP_MODULE_MIN_M)
    .max(PLANNING_PANEL_GROUP_MODULE_MAX_M),
  gapM: z
    .number()
    .finite()
    .min(PLANNING_PANEL_GROUP_GAP_MIN_M)
    .max(PLANNING_PANEL_GROUP_GAP_MAX_M),
  tiltDeg: z
    .number()
    .finite()
    .min(PLANNING_PANEL_GROUP_TILT_MIN_DEG)
    .max(PLANNING_PANEL_GROUP_TILT_MAX_DEG)
    .optional(),
});
export type PlanningPanelGroupCreateV1 = z.infer<
  typeof planningPanelGroupCreateV1Schema
>;

export type PlanningPanelGroupRectInput = {
  origin: PlanningPanelGroupOriginV1;
  rows: number;
  cols: number;
  moduleWM: number;
  moduleHM: number;
  gapM: number;
};

export type PlanningPanelGroupRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// Gruppen-Rechteck: Ursprung + cols*moduleWM + (cols-1)*gapM (Breite),
// rows*moduleHM + (rows-1)*gapM (Höhe).
export function groupRect(
  input: PlanningPanelGroupRectInput,
): PlanningPanelGroupRect {
  const { origin, rows, cols, moduleWM, moduleHM, gapM } = input;
  return {
    x: origin.x,
    y: origin.y,
    width: cols * moduleWM + (cols - 1) * gapM,
    height: rows * moduleHM + (rows - 1) * gapM,
  };
}
