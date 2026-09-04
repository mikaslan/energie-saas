import { z } from "zod";

// F1.8 Lead Sources — interner DTO-/Command-Vertrag (Slice A).
// Kein externer Producer: kein SHA-Pin nötig; Schema-Version gepinnt für
// spätere Evolution (Slice B: Auto-Zuweisungsregeln).

export const LEAD_SOURCE_SCHEMA_VERSION = 1;

export const LEAD_SOURCE_NAME_MAX = 120;
export const LEAD_SOURCE_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/u;
export const LEAD_SOURCE_DOMAINS = ["residential", "commercial"] as const;

const nameSchema = z
  .string()
  .min(1)
  .max(LEAD_SOURCE_NAME_MAX)
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1, { message: "name darf nicht leer sein" });

const projectDomainSchema = z.enum(LEAD_SOURCE_DOMAINS).nullable().optional();
const colorSchema = z.string().regex(LEAD_SOURCE_COLOR_PATTERN).nullable().optional();

export const leadSourceDtoSchema = z.object({
  schemaVersion: z.literal(LEAD_SOURCE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string(),
  projectDomain: z.enum(LEAD_SOURCE_DOMAINS).nullable(),
  color: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type LeadSourceDto = z.infer<typeof leadSourceDtoSchema>;

export const createLeadSourceCommandSchema = z.object({
  schemaVersion: z.literal(LEAD_SOURCE_SCHEMA_VERSION),
  name: nameSchema,
  projectDomain: projectDomainSchema,
  color: colorSchema,
});
export type CreateLeadSourceCommand = z.infer<typeof createLeadSourceCommandSchema>;

export const updateLeadSourceCommandSchema = z.object({
  schemaVersion: z.literal(LEAD_SOURCE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: nameSchema,
  projectDomain: projectDomainSchema,
  color: colorSchema,
});
export type UpdateLeadSourceCommand = z.infer<typeof updateLeadSourceCommandSchema>;

export const listLeadSourcesQuerySchema = z.object({
  includeArchived: z.boolean().optional().default(false),
});
