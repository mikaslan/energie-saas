import { z } from "zod";

// F3-04b Panel-Deselect Stufe-0 — Client-sicherer Contract (keine
// Server-Imports). Deselect-Zeilen je Panel-Gruppe (row/col, optionale
// Begründung) + Ableitung effectiveCount (rows·cols − Abwahlen) zur
// Nachnutzung.
export const PLANNING_PANEL_DESELECT_VERSION =
  "planning-panel-deselect.v1" as const;

export const planningPanelDeselectV1Schema = z.strictObject({
  schemaVersion: z.literal(PLANNING_PANEL_DESELECT_VERSION),
  groupId: z.string().uuid(),
  row: z.number().int().min(1),
  col: z.number().int().min(1),
  reason: z.string().min(1).max(280).optional(),
});
export type PlanningPanelDeselectV1 = z.infer<
  typeof planningPanelDeselectV1Schema
>;

export type DeselectedEffectiveCountInput = {
  rows: number;
  cols: number;
  deselected: number;
};

// Reine Subtraktion ohne Clamp (Service garantiert Gültigkeit).
export function deselectedEffectiveCount(
  input: DeselectedEffectiveCountInput,
): number {
  return input.rows * input.cols - input.deselected;
}
