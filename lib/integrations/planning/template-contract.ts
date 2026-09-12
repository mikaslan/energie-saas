import { z } from "zod";

import { planningModeSchema } from "./contract";

// F16-08 Planungs-Vorlagen — interner DTO-/Command-Vertrag.
// Modus-Preset (quick/2d/3d); Anwenden an einer Angebotsvariante via
// set_planning_mode-Revision; Archiv statt Delete (F7.3/F16.3-Muster).
// Keine neuen Permissions: planning.settings.read/settings.manage;
// Angebots-Schreibschutz (project.write) prüft der Angebots-Pfad selbst.

export const PLANNING_TEMPLATE_SCHEMA_VERSION = 1;

export const PLANNING_TEMPLATE_NAME_MAX = 200;

const cleanName = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= PLANNING_TEMPLATE_NAME_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

export const planningTemplateDtoSchema = z.object({
  schemaVersion: z.literal(PLANNING_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string(),
  mode: planningModeSchema,
  position: z.number().int().min(0),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type PlanningTemplateDto = z.infer<typeof planningTemplateDtoSchema>;

export const createPlanningTemplateCommandSchema = z.object({
  schemaVersion: z.literal(PLANNING_TEMPLATE_SCHEMA_VERSION),
  name: cleanName,
  mode: planningModeSchema,
  position: z.number().int().min(0).optional(),
});
export type CreatePlanningTemplateCommand = z.infer<typeof createPlanningTemplateCommandSchema>;

export const updatePlanningTemplateCommandSchema = z.object({
  schemaVersion: z.literal(PLANNING_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: cleanName,
  mode: planningModeSchema,
  position: z.number().int().min(0),
});
export type UpdatePlanningTemplateCommand = z.infer<typeof updatePlanningTemplateCommandSchema>;

export const archivePlanningTemplateCommandSchema = z.object({
  schemaVersion: z.literal(PLANNING_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  active: z.boolean(),
});
export type ArchivePlanningTemplateCommand = z.infer<typeof archivePlanningTemplateCommandSchema>;

export const applyPlanningTemplateCommandSchema = z.object({
  schemaVersion: z.literal(PLANNING_TEMPLATE_SCHEMA_VERSION),
  templateId: z.string().uuid(),
  offerId: z.string().uuid(),
  variantId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
});
export type ApplyPlanningTemplateCommand = z.infer<typeof applyPlanningTemplateCommandSchema>;
