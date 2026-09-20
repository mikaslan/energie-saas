import { z } from "zod";

// F3-05b String-Equipment Stufe-0 — Client-sicherer Contract (keine
// Server-Imports). Equipment-Einträge je String (Optimierer pro
// String/Panel, Mikro-WR je Panel); Advisory bei Mikro-Teilabdeckung,
// nie Reject.
export const PLANNING_STRING_EQUIPMENT_VERSION =
  "planning-string-equipment.v1" as const;

export const planningStringEquipmentPanelRefV1Schema = z.strictObject({
  groupId: z.string().uuid(),
  row: z.number().int().min(1),
  col: z.number().int().min(1),
});
export type PlanningStringEquipmentPanelRefV1 = z.infer<
  typeof planningStringEquipmentPanelRefV1Schema
>;

export const planningStringEquipmentAttachV1Schema = z
  .strictObject({
    schemaVersion: z.literal(PLANNING_STRING_EQUIPMENT_VERSION),
    stringId: z.string().uuid(),
    scope: z.enum(["string", "panel"]),
    panelRef: planningStringEquipmentPanelRefV1Schema.optional(),
    equipment: z.enum(["optimizer", "micro_inverter"]),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "string" && value.panelRef !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["panelRef"],
        message: "panelRef nur bei scope=panel.",
      });
    }
    if (value.scope === "panel" && value.panelRef === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["panelRef"],
        message: "panelRef ist bei scope=panel Pflicht.",
      });
    }
    if (value.equipment === "micro_inverter" && value.scope !== "panel") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["equipment"],
        message: "Mikro-WR nur bei scope=panel.",
      });
    }
  });
export type PlanningStringEquipmentAttachV1 = z.infer<
  typeof planningStringEquipmentAttachV1Schema
>;

export type PlanningStringEquipmentAdvisoryCode = "partial-coverage";

export type PlanningStringEquipmentAdvisory = {
  code: PlanningStringEquipmentAdvisoryCode;
  message: string;
};

export type PlanningStringEquipmentAdvisoriesInput = {
  microCount: number;
  moduleCount: number;
};

// Advisory-Ableitung (nie Reject): 0 < microCount < moduleCount →
// partial-coverage, sonst leer (keine Mikros oder volle Abdeckung).
export function stringEquipmentAdvisories(
  input: PlanningStringEquipmentAdvisoriesInput,
): PlanningStringEquipmentAdvisory[] {
  if (
    input.microCount > 0 &&
    input.microCount < input.moduleCount
  ) {
    return [
      {
        code: "partial-coverage",
        message: `Mikro-WR decken ${input.microCount} von ${input.moduleCount} Modulen ab (Teilabdeckung).`,
      },
    ];
  }
  return [];
}
