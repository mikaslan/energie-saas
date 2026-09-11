import { z } from "zod";

// F9-07 Abrechnungslauf — interner DTO-/Command-Vertrag.
// Freigegebene Einträge je Zeitraum übernehmen, Lauf schließen (Snapshot).
// Kein Delete. Keine neuen Permissions: time.read/time.write.

export const BILLING_RUN_SCHEMA_VERSION = 1;

export const BILLING_RUN_LABEL_MAX = 120;
export const BILLING_RUN_PERIOD_DAYS_MAX = 366;

const cleanLabel = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= BILLING_RUN_LABEL_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, { message: "kein Kalendertag" })
  .refine((v) => {
    const [year, month, day] = v.split("-").map(Number);
    const probe = new Date(Date.UTC(year!, month! - 1, day!));
    return probe.getUTCFullYear() === year
      && probe.getUTCMonth() === month! - 1
      && probe.getUTCDate() === day;
  }, { message: "ungültiges Datum" });

export const billingRunDtoSchema = z.object({
  schemaVersion: z.literal(BILLING_RUN_SCHEMA_VERSION),
  id: z.string().uuid(),
  label: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.enum(["open", "closed"]),
  totalMinutes: z.number().int().min(0),
  entryCount: z.number().int().min(0),
  closedBy: z.string().uuid().nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type BillingRunDto = z.infer<typeof billingRunDtoSchema>;

export const createBillingRunCommandSchema = z.object({
  schemaVersion: z.literal(BILLING_RUN_SCHEMA_VERSION),
  label: cleanLabel,
  periodStart: calendarDaySchema,
  periodEnd: calendarDaySchema,
}).refine((v) => v.periodStart <= v.periodEnd, { message: "Start nach Ende" })
  .refine((v) => {
    const start = Date.parse(`${v.periodStart}T00:00:00Z`);
    const end = Date.parse(`${v.periodEnd}T00:00:00Z`);
    return (end - start) / 86_400_000 <= BILLING_RUN_PERIOD_DAYS_MAX;
  }, { message: "Zeitraum zu lang" });
export type CreateBillingRunCommand = z.infer<typeof createBillingRunCommandSchema>;

export const closeBillingRunCommandSchema = z.object({
  schemaVersion: z.literal(BILLING_RUN_SCHEMA_VERSION),
  id: z.string().uuid(),
});
export type CloseBillingRunCommand = z.infer<typeof closeBillingRunCommandSchema>;

// F9-08 Lauf-Auswertung — Zeilen je Person aus dem eingefrorenen Lauf.
// Reiner Lesepfad (keine Migration); Summen müssen dem Snapshot entsprechen.
export const billingRunBreakdownRowSchema = z.object({
  schemaVersion: z.literal(BILLING_RUN_SCHEMA_VERSION),
  userId: z.string().uuid(),
  label: z.string(),
  entryCount: z.number().int().min(0),
  totalWorkingMinutes: z.number().int().min(0),
});
export type BillingRunBreakdownRow = z.infer<typeof billingRunBreakdownRowSchema>;

export const billingRunBreakdownDtoSchema = z.object({
  schemaVersion: z.literal(BILLING_RUN_SCHEMA_VERSION),
  billingRunId: z.string().uuid(),
  entryCount: z.number().int().min(0),
  totalMinutes: z.number().int().min(0),
  rows: billingRunBreakdownRowSchema.array(),
});
export type BillingRunBreakdownDto = z.infer<typeof billingRunBreakdownDtoSchema>;

export const getBillingRunBreakdownCommandSchema = z.object({
  schemaVersion: z.literal(BILLING_RUN_SCHEMA_VERSION),
  billingRunId: z.string().uuid(),
});
export type GetBillingRunBreakdownCommand = z.infer<typeof getBillingRunBreakdownCommandSchema>;
