// F16-07 Datei-Anfragen-Vorlagen: reiner Client-/Server-Vertrag
// (DTO-Form, Command-Schemas — keine Imports außer zod, kein I/O).
// Muster lib/file-request.ts + lib/integrations/calendar/template-contract:
// Sektion (Client) und Service (Server) teilen sich diese Datei, ohne
// Server-Code ins Client-Bundle zu ziehen.
import { z } from "zod";

// F10-10: Version 2 — allowMany je Vorlage (Allow-many aus Katalog F10-04).
export const FILE_REQUEST_TEMPLATE_SCHEMA_VERSION = 2;

export const FILE_REQUEST_TEMPLATE_NAME_MAX = 200;
export const FILE_REQUEST_TEMPLATE_TITLE_MAX = 160;
export const FILE_REQUEST_TEMPLATE_DESCRIPTION_MAX = 2000;

const cleanName = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= FILE_REQUEST_TEMPLATE_NAME_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

const cleanTitle = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= FILE_REQUEST_TEMPLATE_TITLE_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

const cleanDescription = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= FILE_REQUEST_TEMPLATE_DESCRIPTION_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" })
  .nullable();

export const fileRequestTemplateDtoSchema = z.object({
  schemaVersion: z.literal(FILE_REQUEST_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  allowMany: z.boolean(),
  position: z.number().int().min(0),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type FileRequestTemplateDto = z.infer<typeof fileRequestTemplateDtoSchema>;

export const createFileRequestTemplateCommandSchema = z.object({
  schemaVersion: z.literal(FILE_REQUEST_TEMPLATE_SCHEMA_VERSION),
  name: cleanName,
  title: cleanTitle,
  description: cleanDescription.optional(),
  allowMany: z.boolean(),
  position: z.number().int().min(0).optional(),
});
export type CreateFileRequestTemplateCommand = z.infer<typeof createFileRequestTemplateCommandSchema>;

export const updateFileRequestTemplateCommandSchema = z.object({
  schemaVersion: z.literal(FILE_REQUEST_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: cleanName,
  title: cleanTitle,
  description: cleanDescription.optional(),
  allowMany: z.boolean(),
  position: z.number().int().min(0),
});
export type UpdateFileRequestTemplateCommand = z.infer<typeof updateFileRequestTemplateCommandSchema>;

export const archiveFileRequestTemplateCommandSchema = z.object({
  schemaVersion: z.literal(FILE_REQUEST_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  active: z.boolean(),
});
export type ArchiveFileRequestTemplateCommand = z.infer<typeof archiveFileRequestTemplateCommandSchema>;

// Anwenden v1: Vorlage + Projekt → Datei-Anfrage mit Titel-Preset.
// Keine Akten-Verknüpfung (v1-Scope, explizit — BnD-Belege bleiben manuell).
export const applyFileRequestTemplateCommandSchema = z.object({
  schemaVersion: z.literal(FILE_REQUEST_TEMPLATE_SCHEMA_VERSION),
  templateId: z.string().uuid(),
  projectId: z.string().uuid(),
});
export type ApplyFileRequestTemplateCommand = z.infer<typeof applyFileRequestTemplateCommandSchema>;
