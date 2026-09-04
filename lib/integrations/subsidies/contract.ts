import { z } from "zod";

// F16.3 Slice B Förder-Vorlagen — interner DTO-/Command-Vertrag.
// kind-Diskriminante: fix_cents (amountCents gesetzt, percentBps NULL)
// oder percent_bps (percentBps 1..10000, amountCents NULL, Cap optional).
// Steuerabzug ist Angebotslogik und steht bewusst NICHT hier.

export const SUBSIDY_TEMPLATE_SCHEMA_VERSION = 1;

export const SUBSIDY_TEMPLATE_NAME_MAX = 200;

export const SUBSIDY_KIND_FIX = "fix_cents" as const;
export const SUBSIDY_KIND_PERCENT = "percent_bps" as const;

const cleanName = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= SUBSIDY_TEMPLATE_NAME_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

const amountCentsSchema = z.number().int().min(0).max(999_999_999_999);
const percentBpsSchema = z.number().int().min(1).max(10_000);
const capCentsSchema = z.number().int().min(0).max(999_999_999_999);

const kindFields = {
  kind: z.enum([SUBSIDY_KIND_FIX, SUBSIDY_KIND_PERCENT]),
  amountCents: amountCentsSchema.nullable(),
  percentBps: percentBpsSchema.nullable(),
  capCents: capCentsSchema.nullable(),
};

// Zweig-Konsistenz (beide-oder-keiner je Zweig, Cap nur bei Prozent) —
// symmetrisch zu den DB-CHECKs subsidy_template_{fix,percent,cap}_ck.
function checkKindConsistency(value: {
  kind: string;
  amountCents: number | null;
  percentBps: number | null;
  capCents: number | null;
}): boolean {
  if (value.kind === SUBSIDY_KIND_FIX) {
    return value.amountCents !== null && value.percentBps === null && value.capCents === null;
  }
  return (
    value.percentBps !== null && value.amountCents === null
    && (value.capCents === null || value.capCents >= 0)
  );
}

export const subsidyTemplateDtoSchema = z.object({
  schemaVersion: z.literal(SUBSIDY_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string(),
  kind: z.enum([SUBSIDY_KIND_FIX, SUBSIDY_KIND_PERCENT]),
  amountCents: z.number().int().min(0).nullable(),
  percentBps: z.number().int().min(1).max(10_000).nullable(),
  capCents: z.number().int().min(0).nullable(),
  position: z.number().int().min(0),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type SubsidyTemplateDto = z.infer<typeof subsidyTemplateDtoSchema>;

export const createSubsidyTemplateCommandSchema = z
  .object({
    schemaVersion: z.literal(SUBSIDY_TEMPLATE_SCHEMA_VERSION),
    name: cleanName,
    ...kindFields,
    position: z.number().int().min(0).optional(),
  })
  .refine(checkKindConsistency, { message: "kind und Beträge passen nicht zusammen" });
export type CreateSubsidyTemplateCommand = z.infer<typeof createSubsidyTemplateCommandSchema>;

export const updateSubsidyTemplateCommandSchema = z
  .object({
    schemaVersion: z.literal(SUBSIDY_TEMPLATE_SCHEMA_VERSION),
    id: z.string().uuid(),
    name: cleanName,
    ...kindFields,
    position: z.number().int().min(0),
  })
  .refine(checkKindConsistency, { message: "kind und Beträge passen nicht zusammen" });
export type UpdateSubsidyTemplateCommand = z.infer<typeof updateSubsidyTemplateCommandSchema>;
