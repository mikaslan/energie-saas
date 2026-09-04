import { z } from "zod";

// F9.1 Zeiterfassung — interner DTO-/Command-Vertrag (Slice A).
// Kein externer Producer: kein SHA-Pin nötig; Schema-Version gepinnt.

export const TIME_TRACKING_SCHEMA_VERSION = 1;

export const TIME_NAME_MAX = 120;
export const TIME_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/u;
export const TIME_COMMENT_MAX = 500;
export const TIME_MINUTES_MAX = 1440;

// Kimi-P2-1: Längen- und Steuerzeichen-Prüfung NACH der NFKC-Transformation
// (NFKC kann expandieren) — symmetrisch zu den DB-CHECKs.
const nameSchema = z
  .string()
  .min(1)
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1, { message: "name darf nicht leer sein" })
  .refine((v) => v.length <= TIME_NAME_MAX, { message: "name zu lang" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "name enthält Steuerzeichen" });

const colorSchema = z.string().regex(TIME_COLOR_PATTERN).nullable();
const isoDateSchema = z.string().datetime({ offset: true });

export const timeEventTypeDtoSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: z.string(),
  position: z.number().int().min(0),
  textColor: z.string().nullable(),
  backgroundColor: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type TimeEventTypeDto = z.infer<typeof timeEventTypeDtoSchema>;

export const createTimeEventTypeCommandSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  name: nameSchema,
  position: z.number().int().min(0).optional(),
  textColor: colorSchema.optional(),
  backgroundColor: colorSchema.optional(),
});
export type CreateTimeEventTypeCommand = z.infer<typeof createTimeEventTypeCommandSchema>;

export const updateTimeEventTypeCommandSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  id: z.string().uuid(),
  name: nameSchema,
  position: z.number().int().min(0),
  textColor: colorSchema.optional(),
  backgroundColor: colorSchema.optional(),
});
export type UpdateTimeEventTypeCommand = z.infer<typeof updateTimeEventTypeCommandSchema>;

export const timeEntryDtoSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  id: z.string().uuid(),
  userId: z.string().uuid(),
  projectId: z.string().uuid(),
  typeId: z.string().uuid().nullable(),
  startAt: z.string(),
  // F9.2: laufende Einträge tragen endAt/workingTimeMinutes = null.
  endAt: z.string().nullable(),
  // F9.4 Slice C: Start-Koordinaten (NULL ohne Consent).
  startLat: z.number().nullable(),
  startLng: z.number().nullable(),
  workingTimeMinutes: z.number().int().min(0).max(TIME_MINUTES_MAX).nullable(),
  running: z.boolean(),
  breakDurationMinutes: z.number().int().min(0).max(TIME_MINUTES_MAX),
  comment: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type TimeEntryDto = z.infer<typeof timeEntryDtoSchema>;

export const timeEntryListDtoSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  entries: z.array(timeEntryDtoSchema),
  totalWorkingMinutes: z.number().int().min(0),
});
export type TimeEntryListDto = z.infer<typeof timeEntryListDtoSchema>;

// F9.3 Fremdnutzer-Filter: userIds wie live (UUID, max 50); null/fehlend = kein Filter.
export const timeEntryListQuerySchema = z.object({
  projectId: z.string().uuid(),
  includeArchived: z.boolean().optional(),
  userIds: z.array(z.string().uuid()).max(50).nullish(),
});
export type TimeEntryListQuery = z.infer<typeof timeEntryListQuerySchema>;

export const timeMemberOptionSchema = z.object({
  userId: z.string().uuid(),
  label: z.string(),
});
export type TimeMemberOption = z.infer<typeof timeMemberOptionSchema>;

// F9.4 Slice B Versionshistorie: Revision = Vollbild des Vor-Update-Stands
// (immutable, kein updatedAt — Muster offer_variant_revision).
export const timeEntryRevisionDtoSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  id: z.string().uuid(),
  entryId: z.string().uuid(),
  userId: z.string().uuid(),
  projectId: z.string().uuid(),
  typeId: z.string().uuid().nullable(),
  startAt: z.string(),
  endAt: z.string().nullable(),
  // F9.4 Slice C: Vollbild — Start-Koordinaten werden mitkopiert.
  startLat: z.number().nullable(),
  startLng: z.number().nullable(),
  workingTimeMinutes: z.number().int().min(0).max(TIME_MINUTES_MAX).nullable(),
  breakDurationMinutes: z.number().int().min(0).max(TIME_MINUTES_MAX),
  comment: z.string().nullable(),
  revisedBy: z.string().uuid(),
  revisedAt: z.string(),
  createdAt: z.string(),
});
export type TimeEntryRevisionDto = z.infer<typeof timeEntryRevisionDtoSchema>;

export const timeEntryRevisionListDtoSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  entryId: z.string().uuid(),
  revisions: z.array(timeEntryRevisionDtoSchema),
});
export type TimeEntryRevisionListDto = z.infer<typeof timeEntryRevisionListDtoSchema>;

// Query nur { entryId }: Projekt/Workspace folgen aus dem Eintrag
// (Eintrag ausserhalb des Workspace => not_found, gleiche Schranke).
export const timeEntryRevisionListQuerySchema = z.object({
  entryId: z.string().uuid(),
});
export type TimeEntryRevisionListQuery = z.infer<typeof timeEntryRevisionListQuerySchema>;

// F9.4 Slice D Team-Auslastung: Aggregation je Mitglied, Filter =
// List-Filter wiederverwendet (timeEntryListQuerySchema, kein Dialekt).
export const timeUtilizationRowDtoSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  userId: z.string().uuid(),
  label: z.string(),
  entryCount: z.number().int().min(0),
  totalWorkingMinutes: z.number().int().min(0),
  running: z.boolean(),
});
export type TimeUtilizationRowDto = z.infer<typeof timeUtilizationRowDtoSchema>;

export const timeUtilizationDtoSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  rows: z.array(timeUtilizationRowDtoSchema),
});
export type TimeUtilizationDto = z.infer<typeof timeUtilizationDtoSchema>;

// F9.4 Slice A CSV-Export: Filter = List-Filter wiederverwendet
// (timeEntryListQuerySchema, kein neuer Dialekt).
export const timeEntryExportResultSchema = z.object({
  content: z.string(),
  contentType: z.literal("text/csv; charset=utf-8"),
  fileName: z.string().min(1).max(120),
});
export type TimeEntryExportResult = z.infer<typeof timeEntryExportResultSchema>;

export const timeEntryUpsertFieldsSchema = z.object({
  typeId: z.string().uuid().nullable(),
  startAt: isoDateSchema,
  endAt: isoDateSchema,
  workingTimeMinutes: z.number().int().min(0).max(TIME_MINUTES_MAX),
  breakDurationMinutes: z.number().int().min(0).max(TIME_MINUTES_MAX),
  comment: z
    .string()
    .transform((v) => v.normalize("NFKC").trim())
    .refine((v) => v.length >= 1, { message: "comment darf nicht leer sein" })
    .refine((v) => v.length <= TIME_COMMENT_MAX, { message: "comment zu lang" })
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "comment enthält Steuerzeichen" })
    .nullable(),
}).refine((v) => new Date(v.endAt) >= new Date(v.startAt), {
  message: "endAt muss nach startAt liegen",
}).refine((v) => v.breakDurationMinutes <= v.workingTimeMinutes, {
  message: "Pause darf die Arbeitszeit nicht überschreiten",
});

export const createTimeEntryCommandSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  projectId: z.string().uuid(),
  fields: timeEntryUpsertFieldsSchema,
});
export type CreateTimeEntryCommand = z.infer<typeof createTimeEntryCommandSchema>;

export const updateTimeEntryCommandSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  id: z.string().uuid(),
  fields: timeEntryUpsertFieldsSchema,
});
export type UpdateTimeEntryCommand = z.infer<typeof updateTimeEntryCommandSchema>;

// F9.4 Slice C: GPS-Koordinaten nur am Start-Event (Consent-Opt-in).
// Beide oder keiner (halbe Paare sind nie ehrlich); finite + Range
// symmetrisch zu den DB-CHECKs time_entry_gps_ck.
const startLatSchema = z.number().finite().min(-90).max(90).nullable();
const startLngSchema = z.number().finite().min(-180).max(180).nullable();

// F9.2 Stoppuhr-Commands
export const startTimeEntryCommandSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  projectId: z.string().uuid(),
  startLat: startLatSchema.optional(),
  startLng: startLngSchema.optional(),
  typeId: z.string().uuid().nullable(),
  comment: z
    .string()
    .transform((v) => v.normalize("NFKC").trim())
    .refine((v) => v.length <= TIME_COMMENT_MAX, { message: "comment zu lang" })
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" })
    .nullable(),
});
export type StartTimeEntryCommand = z.infer<typeof startTimeEntryCommandSchema>;
export const startTimeEntryCommandWithGpsSchema = startTimeEntryCommandSchema.refine(
  (v) => {
    const latMissing = (v.startLat ?? null) === null;
    const lngMissing = (v.startLng ?? null) === null;
    return latMissing === lngMissing;
  },
  { message: "startLat und startLng nur gemeinsam" },
);

export const stopTimeEntryCommandSchema = z.object({
  schemaVersion: z.literal(TIME_TRACKING_SCHEMA_VERSION),
  id: z.string().uuid(),
  workingTimeMinutes: z.number().int().min(1).max(TIME_MINUTES_MAX),
  breakDurationMinutes: z.number().int().min(0).max(TIME_MINUTES_MAX),
  comment: z
    .string()
    .transform((v) => v.normalize("NFKC").trim())
    .refine((v) => v.length <= TIME_COMMENT_MAX, { message: "comment zu lang" })
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" })
    .nullable(),
}).refine((v) => v.breakDurationMinutes <= v.workingTimeMinutes, {
  message: "Pause darf die Arbeitszeit nicht überschreiten",
});
export type StopTimeEntryCommand = z.infer<typeof stopTimeEntryCommandSchema>;
