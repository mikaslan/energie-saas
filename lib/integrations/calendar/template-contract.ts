import { z } from "zod";

// F16-05 Termin-Vorlagen — interner DTO-/Command-Vertrag.
// Titel-Preset + Standarddauer (Minuten); Anwenden mit Start (Berliner
// Wanduhrzeit) und Kalender; Archiv statt Delete (F7.3/F16.3-Muster).
// Keine neuen Permissions: appointment.read/appointment.write.

export const APPOINTMENT_TEMPLATE_SCHEMA_VERSION = 1;

export const APPOINTMENT_TEMPLATE_NAME_MAX = 200;
export const APPOINTMENT_TEMPLATE_TITLE_MAX = 200;
export const APPOINTMENT_TEMPLATE_DURATION_MIN = 1;
export const APPOINTMENT_TEMPLATE_DURATION_MAX = 2880;

const cleanName = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= APPOINTMENT_TEMPLATE_NAME_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

const cleanTitle = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= APPOINTMENT_TEMPLATE_TITLE_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

const durationMinutesSchema = z.number().int()
  .min(APPOINTMENT_TEMPLATE_DURATION_MIN)
  .max(APPOINTMENT_TEMPLATE_DURATION_MAX);

export const appointmentTemplateDtoSchema = z.object({
  schemaVersion: z.literal(APPOINTMENT_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string(),
  title: z.string(),
  durationMinutes: z.number().int()
    .min(APPOINTMENT_TEMPLATE_DURATION_MIN)
    .max(APPOINTMENT_TEMPLATE_DURATION_MAX),
  position: z.number().int().min(0),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type AppointmentTemplateDto = z.infer<typeof appointmentTemplateDtoSchema>;

export const createAppointmentTemplateCommandSchema = z.object({
  schemaVersion: z.literal(APPOINTMENT_TEMPLATE_SCHEMA_VERSION),
  name: cleanName,
  title: cleanTitle,
  durationMinutes: durationMinutesSchema,
  position: z.number().int().min(0).optional(),
});
export type CreateAppointmentTemplateCommand = z.infer<typeof createAppointmentTemplateCommandSchema>;

export const updateAppointmentTemplateCommandSchema = z.object({
  schemaVersion: z.literal(APPOINTMENT_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: cleanName,
  title: cleanTitle,
  durationMinutes: durationMinutesSchema,
  position: z.number().int().min(0),
});
export type UpdateAppointmentTemplateCommand = z.infer<typeof updateAppointmentTemplateCommandSchema>;

export const archiveAppointmentTemplateCommandSchema = z.object({
  schemaVersion: z.literal(APPOINTMENT_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  active: z.boolean(),
});
export type ArchiveAppointmentTemplateCommand = z.infer<typeof archiveAppointmentTemplateCommandSchema>;

export const applyAppointmentTemplateCommandSchema = z.object({
  schemaVersion: z.literal(APPOINTMENT_TEMPLATE_SCHEMA_VERSION),
  templateId: z.string().uuid(),
  projectId: z.string().uuid(),
  calendarId: z.string().uuid(),
  start: z.string(),
});
export type ApplyAppointmentTemplateCommand = z.infer<typeof applyAppointmentTemplateCommandSchema>;
