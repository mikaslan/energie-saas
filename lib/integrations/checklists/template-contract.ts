import { z } from "zod";

// F7.3 Checklisten-Vorlagen — interner DTO-/Command-Vertrag (Slice A).
// OBSERVED-Item-Form: {componentId, quantity, position, visibleToCustomer,
// priceOverridesComponent}; componentId referenziert den EIGENEN Katalog.

export const CHECKLIST_TEMPLATE_SCHEMA_VERSION = 1;

export const TEMPLATE_NAME_MAX = 200;
export const TEMPLATE_DESCRIPTION_MAX = 2000;
export const TEMPLATE_TARGETS_MAX = 20;
export const TEMPLATE_ITEMS_MAX = 200;

const cleanText = (max: number) =>
  z
    .string()
    .transform((v) => v.normalize("NFKC").trim())
    .refine((v) => v.length >= 1 && v.length <= max, { message: "ungültige Länge" })
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

export const checklistTemplateItemSchema = z.strictObject({
  componentId: z.string().uuid(),
  quantity: z.number().int().min(1).max(10_000),
  position: z.number().int().min(0),
  visibleToCustomer: z.boolean(),
  priceOverridesComponent: z.boolean(),
});
export type ChecklistTemplateItemV1 = z.infer<typeof checklistTemplateItemSchema>;

export const checklistTemplateItemsSchema = z
  .array(checklistTemplateItemSchema)
  .max(TEMPLATE_ITEMS_MAX);

export const checklistTemplateTargetsSchema = z
  .array(
    z
      .string()
      .max(100)
      .transform((v) => v.normalize("NFKC").trim())
      .refine((v) => v.length >= 1, { message: "leerer Zielwert" }),
  )
  .max(TEMPLATE_TARGETS_MAX);

export const checklistTemplateDtoSchema = z.object({
  schemaVersion: z.literal(CHECKLIST_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  position: z.number().int().min(0),
  active: z.boolean(),
  targets: z.array(z.string()),
  items: checklistTemplateItemsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type ChecklistTemplateDto = z.infer<typeof checklistTemplateDtoSchema>;

export const createChecklistTemplateCommandSchema = z.object({
  schemaVersion: z.literal(CHECKLIST_TEMPLATE_SCHEMA_VERSION),
  name: cleanText(TEMPLATE_NAME_MAX),
  description: z
    .string()
    .transform((v) => v.normalize("NFKC").trim())
    .refine((v) => v.length <= TEMPLATE_DESCRIPTION_MAX, { message: "zu lang" })
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" })
    .nullable(),
  position: z.number().int().min(0).optional(),
  targets: checklistTemplateTargetsSchema.optional(),
  items: checklistTemplateItemsSchema.optional(),
});
export type CreateChecklistTemplateCommand = z.infer<typeof createChecklistTemplateCommandSchema>;

export const updateChecklistTemplateCommandSchema = z.object({
  schemaVersion: z.literal(CHECKLIST_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: cleanText(TEMPLATE_NAME_MAX),
  description: z
    .string()
    .transform((v) => v.normalize("NFKC").trim())
    .refine((v) => v.length <= TEMPLATE_DESCRIPTION_MAX, { message: "zu lang" })
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" })
    .nullable(),
  position: z.number().int().min(0),
  targets: checklistTemplateTargetsSchema.optional(),
  items: checklistTemplateItemsSchema.optional(),
});
export type UpdateChecklistTemplateCommand = z.infer<typeof updateChecklistTemplateCommandSchema>;
