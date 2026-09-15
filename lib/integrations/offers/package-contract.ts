import { z } from "zod";

// F16-11 Paket-Vorlagen (Katalog F16.2, erster Offshoot) — interner
// DTO-/Command-Vertrag. Ein Paket ist eine Sektion (Titel + Kategorie)
// mit freien Positionen; Anwenden ersetzt die Custom-Ebene einer
// Angebotsvariante (Revise-Ops, expectedRevision). Archiv statt Delete
// (F7.3/F16.3-Muster). Keine neuen Permissions:
// discount_template.read/discount_template.write (gleiche
// Einstellungs-Familie wie F16-06); den Angebots-Schreibschutz prüft
// der Angebots-Pfad selbst.

export const PACKAGE_TEMPLATE_SCHEMA_VERSION = 1;

// F16-13b Picker-Suche: Suchtext für die serverseitige Katalogsuche im
// Paket-Picker (min. 2 Zeichen wie die Projekt-Katalogsuche, max. 120 wie
// die Listenfilter; NFKC-Trim, keine Steuerzeichen). Ungültig → null
// (keine Suche, leere Treffer — kein Fehler-Orakel).
export const PACKAGE_BINDING_SEARCH_MIN = 2;
export const PACKAGE_BINDING_SEARCH_MAX = 120;
export const PACKAGE_BINDING_SEARCH_LIMIT = 50;

export function normalizeBindingSearchQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const query = value.normalize("NFKC").trim();
  if (
    query.length < PACKAGE_BINDING_SEARCH_MIN
    || query.length > PACKAGE_BINDING_SEARCH_MAX
    || /[\p{Cc}\p{Cf}]/u.test(query)
  ) {
    return null;
  }
  return query;
}

export const PACKAGE_TEMPLATE_NAME_MAX = 200;
export const PACKAGE_TEMPLATE_SECTION_TITLE_MAX = 120;
export const PACKAGE_TEMPLATE_MAX_LINES = 50;

export const packageTemplateCategories = [
  "module",
  "inverter",
  "battery",
  "wallbox",
  "heat_pump",
  "mounting",
  "other",
] as const;

export const packageTemplateUnits = ["piece", "set", "meter"] as const;

export const packageTemplatePositionTypes = [
  "required",
  "additional",
  "optional",
] as const;

export type PackageTemplateCategory = (typeof packageTemplateCategories)[number];

const cleanName = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= PACKAGE_TEMPLATE_NAME_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

const cleanSectionTitle = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= PACKAGE_TEMPLATE_SECTION_TITLE_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

const singleLine = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  "control characters are not allowed",
);

// Mengen in Milli-Einheiten (1 Stück = 1000); Stück/Set nur ganzzahlig
// (gleiche Regel wie der Angebots-Vertrag).
const quantityMilliSchema = z.number().int().min(1).max(100_000_000);

// Cent-Beträge je Einheit (VK/EK netto, wie add_custom_line).
const unitNetCentsSchema = z.number().int().min(0).max(9_000_000_000_000_000);

// F16-11b: Steuer je Zeile (19 % oder 0 % nach Prüfung). Bestand
// ohne Feld fällt auf 19 % (F16-11-Zeilen bleiben lesbar). Die
// 0-%-Bestätigung ist frisch zum Einsetz-Zeitpunkt fällig (Apply-
// Command) und wird nie in der Vorlage gespeichert.
const templatePackageLineSchema = z.strictObject({
  displayName: singleLine(200),
  description: singleLine(1_000).nullable().optional(),
  unit: z.enum(packageTemplateUnits),
  quantityMilli: quantityMilliSchema,
  salesUnitNetCents: unitNetCentsSchema,
  purchaseUnitNetCents: unitNetCentsSchema,
  positionType: z.enum(packageTemplatePositionTypes),
  isHidden: z.boolean(),
  taxTreatment: z.enum(["standard_19", "zero_operator_confirmed"]).optional().default("standard_19"),
  // F16-13 Katalog-Zeile: optionale Bindung an eine Katalogkomponente.
  // Beide Felder gemeinsam oder keines (Preise/Einheit stammen beim
  // Speichern/Einsetzen aus der gebundenen Revision — Fail-closed bei Drift).
  catalogComponentId: z.uuid().optional(),
  catalogComponentRevision: z.number().int().min(1).max(2_147_483_647).optional(),
}).superRefine((line, ctx) => {
  if (line.unit !== "meter" && line.quantityMilli % 1_000 !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["quantityMilli"],
      message: "piece und set erlauben nur ganze Einheiten.",
    });
  }
  const boundId = line.catalogComponentId !== undefined;
  const boundRev = line.catalogComponentRevision !== undefined;
  if (boundId !== boundRev) {
    ctx.addIssue({
      code: "custom",
      path: ["catalogComponentId"],
      message: "Katalogbindung braucht Komponente und Revision gemeinsam.",
    });
  }
});
export type PackageTemplateLine = z.infer<typeof templatePackageLineSchema>;

export const packageTemplateLinesSchema = z.array(templatePackageLineSchema).max(
  PACKAGE_TEMPLATE_MAX_LINES,
);

export const packageTemplateDtoSchema = z.object({
  schemaVersion: z.literal(PACKAGE_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string(),
  sectionTitle: z.string(),
  category: z.enum(packageTemplateCategories),
  lines: packageTemplateLinesSchema,
  position: z.number().int().min(0),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type PackageTemplateDto = z.infer<typeof packageTemplateDtoSchema>;

export const createPackageTemplateCommandSchema = z.object({
  schemaVersion: z.literal(PACKAGE_TEMPLATE_SCHEMA_VERSION),
  name: cleanName,
  sectionTitle: cleanSectionTitle,
  category: z.enum(packageTemplateCategories),
  lines: packageTemplateLinesSchema.min(1),
  position: z.number().int().min(0).optional(),
});
export type CreatePackageTemplateCommand = z.infer<typeof createPackageTemplateCommandSchema>;

export const updatePackageTemplateCommandSchema = z.object({
  schemaVersion: z.literal(PACKAGE_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: cleanName,
  sectionTitle: cleanSectionTitle,
  category: z.enum(packageTemplateCategories),
  lines: packageTemplateLinesSchema.min(1),
  position: z.number().int().min(0),
});
export type UpdatePackageTemplateCommand = z.infer<typeof updatePackageTemplateCommandSchema>;

export const archivePackageTemplateCommandSchema = z.object({
  schemaVersion: z.literal(PACKAGE_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  active: z.boolean(),
});
export type ArchivePackageTemplateCommand = z.infer<typeof archivePackageTemplateCommandSchema>;

export const applyPackageTemplateCommandSchema = z.object({
  schemaVersion: z.literal(PACKAGE_TEMPLATE_SCHEMA_VERSION),
  templateId: z.string().uuid(),
  offerId: z.string().uuid(),
  variantId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
  // F16-11b: frische 0-%-Bestätigung des Einsetzenden (Pflicht, sobald
  // das Paket 0-%-Zeilen enthält; sonst bedeutungslos).
  zeroConfirmed: z.boolean().optional().default(false),
});
export type ApplyPackageTemplateCommand = z.infer<typeof applyPackageTemplateCommandSchema>;
