import { z } from "zod";

import { PROJECT_TASK_MAX_ASSIGNEES } from "./contract";

// F16-04 Aufgaben-Vorlagen — interner DTO-/Command-Vertrag.
// Titel-Preset + optionaler Fälligkeits-Offset (Tage ab heute,
// Europe/Berlin); Archiv statt Delete (F7.3/F16.3-Muster).
// Keine neuen Permissions: task.read/task.write.
// F16-04b: optionale Bearbeiter-Memberships (leer = nur Anwendender).

export const TASK_TEMPLATE_SCHEMA_VERSION = 1;

export const TASK_TEMPLATE_NAME_MAX = 200;
export const TASK_TEMPLATE_TITLE_MAX = 200;
export const TASK_TEMPLATE_DUE_OFFSET_MAX = 3650;

const cleanName = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= TASK_TEMPLATE_NAME_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

const cleanTitle = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= TASK_TEMPLATE_TITLE_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

const dueOffsetDaysSchema = z.number().int().min(0).max(TASK_TEMPLATE_DUE_OFFSET_MAX);

// F16-04b: Bearbeiter-Memberships der Vorlage (Cap = Task-Vertrag;
// leere Liste = nur Anwendender wie bisher).
const assigneeMembershipIdsSchema = z.array(z.string().uuid()).max(PROJECT_TASK_MAX_ASSIGNEES);

// Aufgelöste Anzeige-Optionen fürs Edit-Formular (Fehlende entfallen;
// Anzeige, keine Autorisierung — IDs bleiben die Quelle).
const assigneeOptionSchema = z.object({
  membershipId: z.string().uuid(),
  label: z.string().min(1),
});

export const taskTemplateDtoSchema = z.object({
  schemaVersion: z.literal(TASK_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string(),
  title: z.string(),
  dueOffsetDays: z.number().int().min(0).max(TASK_TEMPLATE_DUE_OFFSET_MAX).nullable(),
  assigneeMembershipIds: assigneeMembershipIdsSchema,
  assignees: z.array(assigneeOptionSchema).max(PROJECT_TASK_MAX_ASSIGNEES),
  position: z.number().int().min(0),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type TaskTemplateDto = z.infer<typeof taskTemplateDtoSchema>;

export const createTaskTemplateCommandSchema = z.object({
  schemaVersion: z.literal(TASK_TEMPLATE_SCHEMA_VERSION),
  name: cleanName,
  title: cleanTitle,
  dueOffsetDays: dueOffsetDaysSchema.nullable().optional(),
  assigneeMembershipIds: assigneeMembershipIdsSchema.optional(),
  position: z.number().int().min(0).optional(),
});
export type CreateTaskTemplateCommand = z.infer<typeof createTaskTemplateCommandSchema>;

export const updateTaskTemplateCommandSchema = z.object({
  schemaVersion: z.literal(TASK_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: cleanName,
  title: cleanTitle,
  dueOffsetDays: dueOffsetDaysSchema.nullable().optional(),
  assigneeMembershipIds: assigneeMembershipIdsSchema.optional(),
  position: z.number().int().min(0),
});
export type UpdateTaskTemplateCommand = z.infer<typeof updateTaskTemplateCommandSchema>;

export const archiveTaskTemplateCommandSchema = z.object({
  schemaVersion: z.literal(TASK_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  active: z.boolean(),
});
export type ArchiveTaskTemplateCommand = z.infer<typeof archiveTaskTemplateCommandSchema>;

export const applyTaskTemplateCommandSchema = z.object({
  schemaVersion: z.literal(TASK_TEMPLATE_SCHEMA_VERSION),
  templateId: z.string().uuid(),
  projectId: z.string().uuid(),
});
export type ApplyTaskTemplateCommand = z.infer<typeof applyTaskTemplateCommandSchema>;
