import { z } from "zod";

import { checklistItemKindSchema } from "./contract";

// F7.3 Checklisten-Vorlagen — interner DTO-/Command-Vertrag (Slice A).
// OBSERVED-Item-Form: {componentId, quantity, position, visibleToCustomer,
// priceOverridesComponent}; componentId referenziert den EIGENEN Katalog.
// F7-03B: optionale Punkt-Art je Position (nullish = Legacy = Aufgabe);
// die Vorlage definiert die ART, nie Inhalt oder Antwort.

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
  // F7-03B: Art des Punkts, den das Anwenden erzeugt (alle zehn
  // Projekt-Arten; fehlend = Legacy = Aufgabe wie bisher).
  kind: checklistItemKindSchema.nullish(),
  // F7-03D: Bedingung „Sichtbar, wenn Komponente erledigt" (Regel unten;
  // Anwenden mappt auf die erzeugte Punkt-ID).
  visibleIfComponentId: z.string().uuid().nullish(),
});
export type ChecklistTemplateItemV1 = z.infer<typeof checklistTemplateItemSchema>;

export const checklistTemplateItemsSchema = z
  .array(checklistTemplateItemSchema)
  .max(TEMPLATE_ITEMS_MAX)
  // F7-03D: Regelziel muss eine ANDERE Position derselben Vorlage sein
  // (fail-closed: baumelnd/Selbst = ungueltig). Keine Ketten-Pruefung:
  // Single-Hop gilt erst im Projekt (F7-02B).
  .refine(
    (items) => {
      const known = new Set(items.map((entry) => entry.componentId));
      return items.every(
        (entry) => entry.visibleIfComponentId == null
          || (entry.visibleIfComponentId !== entry.componentId
            && known.has(entry.visibleIfComponentId)),
      );
    },
    { message: "Bedingung verlangt eine andere Position derselben Vorlage" },
  );

// F7-03D: Editor-Sanitize — nach Entfernen/Ummappen einer Position
// werden Regeln ohne (fremdes) Ziel auf null gesetzt statt beim
// Speichern generisch zu scheitern. Rein (keine Mutation);
// Duplikat-Komponenten bleiben erlaubt (last-wins beim Anwenden).
export function sanitizeTemplateRuleTargets(
  items: ChecklistTemplateItemV1[],
): ChecklistTemplateItemV1[] {
  const known = new Set(items.map((entry) => entry.componentId));
  return items.map((entry) =>
    entry.visibleIfComponentId != null
    && (entry.visibleIfComponentId === entry.componentId
      || !known.has(entry.visibleIfComponentId))
      ? { ...entry, visibleIfComponentId: null }
      : entry,
  );
}

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
