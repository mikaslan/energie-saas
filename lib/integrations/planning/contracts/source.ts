import { z } from "zod";

export const PLANNING_SOURCE_CONTRACT_VERSION =
  "planning-source.v1" as const;

export const planningSourceKindSchema = z.enum(["upload", "self_drawn"]);
export type PlanningSourceKind = z.infer<typeof planningSourceKindSchema>;

export const planningSourceScaleRefV1Schema = z.strictObject({
  meters: z.number().finite().positive(),
  pixelLength: z.number().finite().positive(),
});
export type PlanningSourceScaleRefV1 = z.infer<
  typeof planningSourceScaleRefV1Schema
>;

export const planningSourceCreateV1Schema = z
  .strictObject({
    schemaVersion: z.literal(PLANNING_SOURCE_CONTRACT_VERSION),
    kind: planningSourceKindSchema,
    scaleRef: planningSourceScaleRefV1Schema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "self_drawn" && value.scaleRef !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "self_drawn forbids scaleRef",
        path: ["scaleRef"],
      });
    }
  });
export type PlanningSourceCreateV1 = z.infer<
  typeof planningSourceCreateV1Schema
>;
