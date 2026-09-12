import { z } from "zod";

// F16-06 Angebots-Vorlagen — interner DTO-/Command-Vertrag.
// Presets: Zahlart (payment_option) und/oder Rabatt-Vorlage
// (discount_template), je optional, zusammen mindestens eines belegt.
// Anwenden an einer Angebotsvariante heißt: Zahlart setzen (wenn belegt)
// + Rabatt-Vorlage global anwenden (wenn belegt, mit expectedRevision).
// Archiv statt Delete (F7.3/F16.3-Muster). Keine neuen Permissions:
// discount_template.read/discount_template.write; den Angebots-Schreibschutz
// (project.write) prüft der Angebots-Pfad selbst.
// F16-09 zusätzlich: Förder-Vorlage (subsidy_template) als drittes
// optionales Preset, angewandt zwischen Rabatt und Zahlart mit
// Revisionsverkettung (geteilte Slots: späterer Schritt gewinnt).

export const OFFER_TEMPLATE_SCHEMA_VERSION = 1;

export const OFFER_TEMPLATE_NAME_MAX = 200;

const cleanName = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= OFFER_TEMPLATE_NAME_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

const optionalUuid = z.string().uuid().nullish();

const presetRefinement = (value: { paymentOptionId?: string | null; discountTemplateId?: string | null; subsidyTemplateId?: string | null }) =>
  value.paymentOptionId != null || value.discountTemplateId != null || value.subsidyTemplateId != null;

export const offerTemplateDtoSchema = z.object({
  schemaVersion: z.literal(OFFER_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string(),
  paymentOptionId: z.string().uuid().nullable(),
  discountTemplateId: z.string().uuid().nullable(),
  subsidyTemplateId: z.string().uuid().nullable(),
  position: z.number().int().min(0),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type OfferTemplateDto = z.infer<typeof offerTemplateDtoSchema>;

export const createOfferTemplateCommandSchema = z.object({
  schemaVersion: z.literal(OFFER_TEMPLATE_SCHEMA_VERSION),
  name: cleanName,
  paymentOptionId: optionalUuid,
  discountTemplateId: optionalUuid,
  subsidyTemplateId: optionalUuid,
  position: z.number().int().min(0).optional(),
}).refine(presetRefinement, { message: "mindestens ein Preset" });
export type CreateOfferTemplateCommand = z.infer<typeof createOfferTemplateCommandSchema>;

export const updateOfferTemplateCommandSchema = z.object({
  schemaVersion: z.literal(OFFER_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: cleanName,
  paymentOptionId: optionalUuid,
  discountTemplateId: optionalUuid,
  subsidyTemplateId: optionalUuid,
  position: z.number().int().min(0),
}).refine(presetRefinement, { message: "mindestens ein Preset" });
export type UpdateOfferTemplateCommand = z.infer<typeof updateOfferTemplateCommandSchema>;

export const archiveOfferTemplateCommandSchema = z.object({
  schemaVersion: z.literal(OFFER_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  active: z.boolean(),
});
export type ArchiveOfferTemplateCommand = z.infer<typeof archiveOfferTemplateCommandSchema>;

export const applyOfferTemplateCommandSchema = z.object({
  schemaVersion: z.literal(OFFER_TEMPLATE_SCHEMA_VERSION),
  templateId: z.string().uuid(),
  offerId: z.string().uuid(),
  variantId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
});
export type ApplyOfferTemplateCommand = z.infer<typeof applyOfferTemplateCommandSchema>;
