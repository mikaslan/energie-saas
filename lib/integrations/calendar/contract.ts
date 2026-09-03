import { z } from "zod";

export const PROJECT_APPOINTMENT_COMMAND_VERSION =
  "project-appointment-command.v1" as const;
export const PROJECT_APPOINTMENT_ITEM_VERSION =
  "project-appointment-item.v1" as const;
export const PROJECT_APPOINTMENT_RANGE_VERSION =
  "project-appointment-range.v1" as const;
export const CALENDAR_CATEGORY_ITEM_VERSION =
  "calendar-category-item.v1" as const;
export const PROJECT_APPOINTMENT_MAX_REVISION = 2_147_483_647 as const;
export const PROJECT_APPOINTMENT_MAX_ATTENDEES = 100 as const;
export const APPOINTMENT_TITLE_MAX_LENGTH = 2000 as const;
export const APPOINTMENT_DESCRIPTION_MAX_LENGTH = 5000 as const;
export const APPOINTMENT_LOCATION_MAX_LENGTH = 2000 as const;
export const CALENDAR_CATEGORY_NAME_MAX_LENGTH = 200 as const;

export const appointmentTypes = [
  "on_site",
  "phone",
  "installation",
  "maintenance",
  "consultation",
  "other",
] as const;

export type AppointmentType = (typeof appointmentTypes)[number];

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const canonicalUuidSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  "UUID must be canonical lowercase",
);
const revisionSchema = z.number().int().min(1).max(PROJECT_APPOINTMENT_MAX_REVISION);

// Europe/Berlin-normalisierte Zeitgrenze (ADR 0021 E6): Ein-/Ausgaben sind die
// Berliner Wanduhrzeit als "floating" ISO-Datetime OHNE Offset. Die
// Service-Grenze castet sie deterministisch nach timestamptz (UTC-Speicherung)
// über `at time zone 'Europe/Berlin'`, damit DST reproduzierbar bleibt.
//
// hourCycle "h23" ist bewusst gepinnt: manche ICU-Builds liefern sonst für
// Mitternacht "24" statt "00" und verfälschen den Wanduhr-Round-Trip.
const BERLIN_WALL_CLOCK_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function berlinWallClockOf(utcMs: number): string {
  const parts = BERLIN_WALL_CLOCK_FORMATTER.formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

// Berlin kennt genau zwei Offsets: CET (+01:00) und CEST (+02:00). Eine
// Wanduhrzeit existiert, wenn mindestens einer der beiden Kandidaten auf
// denselben Wanduhr-Wert zurückformatiert. In der Frühjahrs-Lücke (z. B.
// 02:30 am Umstellungstag) trifft kein Kandidat zu → invalid statt rohem 23514.
function isBerlinWallClock(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const monthLengths = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  if (day > monthLengths[month - 1]!) return false;

  const wallClock = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}`;
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (const offsetMinutes of [60, 120]) {
    if (berlinWallClockOf(naiveUtc - offsetMinutes * 60_000) === wallClock) {
      return true;
    }
  }
  return false;
}

const appointmentInstantSchema = z.string().refine(isBerlinWallClock, {
  message: "start/end must be an Europe/Berlin wall-clock datetime without offset",
});

function wallClockMs(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u.exec(value);
  if (!match) return Number.NaN;
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]),
    match[6] === undefined ? 0 : Number(match[6]),
  );
}

const DAY_MS = 86_400_000;

const singleLineText = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  "control characters are not allowed",
);
const optionalMultilineText = (max: number) => z.string().trim().min(1).max(max)
  .refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value),
    "control characters are not allowed",
  );

const titleSchema = singleLineText(APPOINTMENT_TITLE_MAX_LENGTH);
const locationSchema = singleLineText(APPOINTMENT_LOCATION_MAX_LENGTH);
const descriptionSchema = optionalMultilineText(APPOINTMENT_DESCRIPTION_MAX_LENGTH);
const typeSchema = z.enum(appointmentTypes);
const attendeeIdsSchema = z.array(uuidSchema).max(PROJECT_APPOINTMENT_MAX_ATTENDEES)
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "duplicate attendee" });
    }
  });

const commandBase = {
  schemaVersion: z.literal(PROJECT_APPOINTMENT_COMMAND_VERSION),
  projectId: uuidSchema,
} as const;
const mutationBase = {
  ...commandBase,
  appointmentId: uuidSchema,
  expectedRevision: revisionSchema,
} as const;
const editableFields = {
  title: titleSchema,
  start: appointmentInstantSchema,
  end: appointmentInstantSchema,
  allDay: z.boolean(),
  type: typeSchema,
  location: locationSchema.nullable(),
  description: descriptionSchema.nullable(),
  attendeeMembershipIds: attendeeIdsSchema,
  categoryId: uuidSchema.nullable(),
} as const;

export const projectAppointmentCommandV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...commandBase,
    kind: z.literal("create_appointment"),
    ...editableFields,
  }),
  z.strictObject({
    ...mutationBase,
    kind: z.literal("update_appointment"),
    ...editableFields,
  }),
  z.strictObject({
    ...mutationBase,
    kind: z.literal("delete_appointment"),
  }),
]).superRefine((value, ctx) => {
  if (value.kind === "delete_appointment") return;
  const start = wallClockMs(value.start);
  const end = wallClockMs(value.end);
  if (!(end > start)) {
    ctx.addIssue({ code: "custom", path: ["end"], message: "end must be after start" });
  }
  if (value.allDay && end < start + DAY_MS) {
    ctx.addIssue({
      code: "custom",
      path: ["end"],
      message: "allDay appointments must span at least one full day",
    });
  }
});

export type ProjectAppointmentCommandV1 = z.infer<
  typeof projectAppointmentCommandV1Schema
>;
export type ProjectAppointmentCommandResult = {
  projectId: string;
  appointmentId: string;
  revision: number;
  changed: boolean;
};

export const appointmentErrorCodeSchema = z.enum([
  "invalid",
  "not_found",
  "conflict",
  "denied",
  "unauthenticated",
]);

// Minimiertes DTO (Spec §4.4): verbotene Felder (workspace_id, rohe
// domain_events-/audit_log-Daten, Reonic-calendarId, Fremd-PII) sind nicht Teil
// des Schemas und scheitern daher an strictObject.
const projectedAttendeeSchema = z.strictObject({
  membershipId: canonicalUuidSchema,
  label: z.string().min(1),
});

export const projectAppointmentItemV1Schema = z.strictObject({
  id: canonicalUuidSchema,
  revision: revisionSchema,
  title: z.string().min(1).max(APPOINTMENT_TITLE_MAX_LENGTH),
  description: z.string().max(APPOINTMENT_DESCRIPTION_MAX_LENGTH).nullable(),
  location: z.string().max(APPOINTMENT_LOCATION_MAX_LENGTH).nullable(),
  start: z.string().min(1),
  end: z.string().min(1),
  allDay: z.boolean(),
  type: typeSchema,
  categoryId: canonicalUuidSchema.nullable(),
  categoryName: z.string().min(1).max(CALENDAR_CATEGORY_NAME_MAX_LENGTH).nullable(),
  attendees: z.array(projectedAttendeeSchema).max(PROJECT_APPOINTMENT_MAX_ATTENDEES),
});

export type ProjectAppointmentItemV1 = z.infer<typeof projectAppointmentItemV1Schema>;

export const calendarCategoryItemV1Schema = z.strictObject({
  id: canonicalUuidSchema,
  name: z.string().min(1).max(CALENDAR_CATEGORY_NAME_MAX_LENGTH),
  order: z.number().int().nonnegative(),
});

export type CalendarCategoryItemV1 = z.infer<typeof calendarCategoryItemV1Schema>;

export const projectAppointmentRangeV1Schema = z.strictObject({
  schemaVersion: z.literal(PROJECT_APPOINTMENT_RANGE_VERSION),
  projectId: canonicalUuidSchema,
  permissions: z.strictObject({ canWrite: z.boolean() }),
  rangeStart: z.string().min(1),
  rangeEnd: z.string().min(1),
  view: z.enum(["month", "week", "list"]),
  items: z.array(projectAppointmentItemV1Schema),
  categories: z.array(calendarCategoryItemV1Schema),
  members: z.array(projectedAttendeeSchema).max(200),
});

export type ProjectAppointmentRangeV1 = z.infer<
  typeof projectAppointmentRangeV1Schema
>;
