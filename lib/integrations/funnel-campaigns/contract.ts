import { z } from "zod";

// F12-01 Funnel-Kampagnen — interner DTO-/Command-Vertrag.
// Kein externer Producer: kein SHA-Pin nötig; Schema-Version gepinnt für
// spätere Evolution (F12-02: Deeplink-Bedienung, Auto-Routing).

export const FUNNEL_CAMPAIGN_SCHEMA_VERSION = 1;

export const FUNNEL_CAMPAIGN_NAME_MAX = 120;
export const FUNNEL_CAMPAIGN_SLUG_MAX = 64;
// Deeplink-Token: kleingeschrieben, URL-pfadsicher (F12-02-Reserve).
export const FUNNEL_CAMPAIGN_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const nameSchema = z
  .string()
  .min(1)
  .max(FUNNEL_CAMPAIGN_NAME_MAX)
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1, { message: "name darf nicht leer sein" });

const slugSchema = z
  .string()
  .min(1)
  .max(FUNNEL_CAMPAIGN_SLUG_MAX)
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => FUNNEL_CAMPAIGN_SLUG_PATTERN.test(v), {
    message: "slug muss [a-z0-9._-] sein und mit [a-z0-9] beginnen",
  });

export const funnelCampaignDtoSchema = z.object({
  schemaVersion: z.literal(FUNNEL_CAMPAIGN_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  leadSourceId: z.string().uuid(),
  leadSourceName: z.string(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type FunnelCampaignDto = z.infer<typeof funnelCampaignDtoSchema>;

export const createFunnelCampaignCommandSchema = z.object({
  schemaVersion: z.literal(FUNNEL_CAMPAIGN_SCHEMA_VERSION),
  name: nameSchema,
  slug: slugSchema,
  leadSourceId: z.string().uuid(),
});
export type CreateFunnelCampaignCommand = z.infer<typeof createFunnelCampaignCommandSchema>;

export const listFunnelCampaignsQuerySchema = z.object({
  includeArchived: z.boolean().optional().default(false),
});
