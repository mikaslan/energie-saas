import { z } from "zod";
import {
  PROJECT_TASK_MAX_ASSIGNEES,
  PROJECT_TASK_MAX_CHECKLIST_ITEMS,
  PROJECT_TASK_MAX_LABELS,
  PROJECT_TASK_MAX_REVISION,
} from "./contract";

export const GLOBAL_TASK_INBOX_QUERY_VERSION = "global-task-inbox-query.v1" as const;
export const GLOBAL_TASK_INBOX_PAGE_VERSION = "global-task-inbox-page.v1" as const;
export const GLOBAL_TASK_INBOX_CURSOR_VERSION = 1 as const;
export const GLOBAL_TASK_INBOX_TIME_ZONE = "Europe/Berlin" as const;
export const GLOBAL_TASK_INBOX_ORDER =
  "due_at_asc_nulls_last_created_at_desc_id_asc" as const;
export const GLOBAL_TASK_INBOX_PAGE_LIMIT = 50 as const;
export const GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH = 100 as const;
// Der Cursor traegt die kanonisierte Query woertlich. Ihre Grenze zaehlt
// UTF-16-Codeunits, base64url zaehlt UTF-8-Bytes: ein BMP-Zeichen kostet bis
// zu drei Bytes je Codeunit. Eine fest gesetzte Cursorgrenze wuerde deshalb
// bei einer vertraglich erlaubten Query ein Token erzeugen, das der eigene
// Seitenvertrag wieder ablehnt. Die Grenze ist darum abgeleitet, nicht geraten.
// `GLOBAL_TASK_INBOX_CURSOR_FRAME_BYTES` deckt Bindung und Position ohne Query;
// der gemessene Worst Case steht im Contracttest.
const GLOBAL_TASK_INBOX_CURSOR_FRAME_BYTES = 576;
export const GLOBAL_TASK_INBOX_CURSOR_MAX_LENGTH = Math.ceil(
  (GLOBAL_TASK_INBOX_CURSOR_FRAME_BYTES + GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH * 3)
    * 4 / 3,
);

export const globalTaskInboxFilterSchema = z.enum([
  "mine",
  "assigned_by_me",
  "all",
]);
export const globalTaskInboxStateSchema = z.enum(["open", "done"]);
export const globalTaskInboxDueBucketSchema = z.enum([
  "any",
  "overdue",
  "today",
  "upcoming",
  "no_due",
]);
export const globalTaskInboxProjectOutcomeSchema = z.enum([
  "open",
  "won",
  "lost",
  "cannot_fulfill",
]);
export const globalTaskInboxErrorCodeSchema = z.enum([
  "invalid_global_task_inbox_query",
  "invalid_global_task_inbox_cursor",
  "invalid_global_task_inbox_projection",
]);

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const canonicalUuidSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  "UUID must be canonical lowercase",
);
// JavaScript akzeptiert das Jahr 0000 und gibt es kanonisch zurück, PostgreSQL
// kennt kein Jahr null und bricht jeden `::timestamptz`-Cast darauf mit
// SQLSTATE 22008 ab. Ohne diese Schranke verließe ein gefälschter Cursor den
// kontrollierten Fehlervertrag: statt `invalid_global_task_inbox_cursor` käme
// ein roher Datenbankfehler samt Eingabewert bis in die Error Boundary.
const canonicalInstantSchema = z.string()
  .regex(/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
  }, "instant must be a canonical UTC timestamp");
const visibleSingleLineSchema = (maximumLength: number) => z.string()
  .min(1)
  .max(maximumLength)
  .refine((value) => value === value.trim(), "text must be trimmed")
  .refine((value) => !controlCharacters.test(value), "control characters are not allowed");

const normalizedQueryInputSchema = z.string()
  .transform((value) => value.normalize("NFKC").trim())
  .pipe(z.string()
    .max(GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH)
    .refine((value) => !controlCharacters.test(value), {
      message: "control characters are not allowed",
    }))
  .transform((value) => value === "" ? null : value);
// Die Route parst die URL und übergibt das Ergebnis an den Service, der als
// Vertrauensgrenze erneut parst. Das Schema muss seine eigene Ausgabe deshalb
// unverändert wieder annehmen; ohne den null-Zweig scheitert jede Anfrage ohne
// Suchbegriff — also der Normalfall — am zweiten Parse.
const idempotentQueryInputSchema = z.union([
  z.null(),
  normalizedQueryInputSchema,
]);
const canonicalQuerySchema = z.string()
  .max(GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH)
  .refine(
    (value) => value === value.normalize("NFKC").trim(),
    "query must be canonical NFKC and trimmed",
  )
  .refine((value) => !controlCharacters.test(value), {
    message: "control characters are not allowed",
  })
  .nullable();

export const globalTaskInboxCursorTokenSchema = z.string()
  .min(1)
  .max(GLOBAL_TASK_INBOX_CURSOR_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const globalTaskInboxQueryV1Schema = z.strictObject({
  schemaVersion: z.literal(GLOBAL_TASK_INBOX_QUERY_VERSION),
  filter: globalTaskInboxFilterSchema,
  state: globalTaskInboxStateSchema,
  dueBucket: globalTaskInboxDueBucketSchema,
  query: idempotentQueryInputSchema,
  timeZone: z.literal(GLOBAL_TASK_INBOX_TIME_ZONE),
  asOf: canonicalInstantSchema.nullable(),
  cursor: globalTaskInboxCursorTokenSchema.nullable(),
}).superRefine((value, ctx) => {
  if ((value.cursor === null) !== (value.asOf === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["cursor"],
      message: "cursor and asOf must either both be null or both be present",
    });
  }
});

export const globalTaskInboxCursorBindingV1Schema = z.strictObject({
  workspaceId: canonicalUuidSchema,
  actorId: canonicalUuidSchema,
  membershipId: canonicalUuidSchema,
  filter: globalTaskInboxFilterSchema,
  state: globalTaskInboxStateSchema,
  dueBucket: globalTaskInboxDueBucketSchema,
  query: canonicalQuerySchema,
  timeZone: z.literal(GLOBAL_TASK_INBOX_TIME_ZONE),
  asOf: canonicalInstantSchema,
  order: z.literal(GLOBAL_TASK_INBOX_ORDER),
});

export const globalTaskInboxCursorPayloadV1Schema = z.strictObject({
  v: z.literal(GLOBAL_TASK_INBOX_CURSOR_VERSION),
  binding: globalTaskInboxCursorBindingV1Schema,
  position: z.strictObject({
    dueAt: canonicalInstantSchema.nullable(),
    createdAt: canonicalInstantSchema,
    taskId: canonicalUuidSchema,
  }),
});

const countsSchema = z.strictObject({
  checklistDone: z.number().int().min(0).max(PROJECT_TASK_MAX_CHECKLIST_ITEMS),
  checklistTotal: z.number().int().min(0).max(PROJECT_TASK_MAX_CHECKLIST_ITEMS),
  labels: z.number().int().min(0).max(PROJECT_TASK_MAX_LABELS),
}).superRefine((value, ctx) => {
  if (value.checklistDone > value.checklistTotal) {
    ctx.addIssue({
      code: "custom",
      path: ["checklistDone"],
      message: "completed checklist count exceeds total",
    });
  }
});

const inboxItemSchema = z.strictObject({
  id: uuidSchema,
  revision: z.number().int().min(1).max(PROJECT_TASK_MAX_REVISION),
  title: visibleSingleLineSchema(200),
  status: globalTaskInboxStateSchema,
  dueAt: canonicalInstantSchema.nullable(),
  counts: countsSchema,
  project: z.strictObject({
    id: uuidSchema,
    name: visibleSingleLineSchema(200),
    outcome: globalTaskInboxProjectOutcomeSchema,
  }),
  assignedToCurrentActor: z.boolean(),
  createdByCurrentActor: z.boolean(),
  assigneeCount: z.number().int().min(0).max(PROJECT_TASK_MAX_ASSIGNEES),
});

export const globalTaskInboxItemV1Schema = inboxItemSchema;

export const globalTaskInboxPageV1Schema = z.strictObject({
  schemaVersion: z.literal(GLOBAL_TASK_INBOX_PAGE_VERSION),
  filter: globalTaskInboxFilterSchema,
  state: globalTaskInboxStateSchema,
  dueBucket: globalTaskInboxDueBucketSchema,
  query: canonicalQuerySchema,
  timeZone: z.literal(GLOBAL_TASK_INBOX_TIME_ZONE),
  asOf: canonicalInstantSchema,
  order: z.literal(GLOBAL_TASK_INBOX_ORDER),
  pageLimit: z.literal(GLOBAL_TASK_INBOX_PAGE_LIMIT),
  items: z.array(inboxItemSchema).max(GLOBAL_TASK_INBOX_PAGE_LIMIT),
  nextCursor: globalTaskInboxCursorTokenSchema.nullable(),
}).superRefine((value, ctx) => {
  const ids = value.items.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "duplicate task" });
  }
});

export type GlobalTaskInboxFilter = z.infer<typeof globalTaskInboxFilterSchema>;
export type GlobalTaskInboxState = z.infer<typeof globalTaskInboxStateSchema>;
export type GlobalTaskInboxDueBucket = z.infer<typeof globalTaskInboxDueBucketSchema>;
export type GlobalTaskInboxErrorCode = z.infer<typeof globalTaskInboxErrorCodeSchema>;
export type GlobalTaskInboxQueryV1 = z.infer<typeof globalTaskInboxQueryV1Schema>;
export type GlobalTaskInboxCursorBindingV1 = z.infer<
  typeof globalTaskInboxCursorBindingV1Schema
>;
export type GlobalTaskInboxCursorPayloadV1 = z.infer<
  typeof globalTaskInboxCursorPayloadV1Schema
>;
export type GlobalTaskInboxItemV1 = z.infer<typeof globalTaskInboxItemV1Schema>;
export type GlobalTaskInboxPageV1 = z.infer<typeof globalTaskInboxPageV1Schema>;

const contractErrorMessages = {
  invalid_global_task_inbox_query: "global task inbox query is invalid",
  invalid_global_task_inbox_cursor: "global task inbox cursor is invalid",
  invalid_global_task_inbox_projection: "global task inbox projection is invalid",
} as const satisfies Record<GlobalTaskInboxErrorCode, string>;

export class GlobalTaskInboxContractError extends Error {
  constructor(public readonly code: GlobalTaskInboxErrorCode) {
    super(contractErrorMessages[code]);
    this.name = "GlobalTaskInboxContractError";
  }
}

export function parseGlobalTaskInboxQueryV1(input: unknown): GlobalTaskInboxQueryV1 {
  const parsed = globalTaskInboxQueryV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new GlobalTaskInboxContractError("invalid_global_task_inbox_query");
  }
  return parsed.data;
}

export function parseGlobalTaskInboxCursorPayloadV1(
  input: unknown,
): GlobalTaskInboxCursorPayloadV1 {
  const parsed = globalTaskInboxCursorPayloadV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new GlobalTaskInboxContractError("invalid_global_task_inbox_cursor");
  }
  return parsed.data;
}

export function globalTaskInboxCursorMatchesBinding(
  payload: GlobalTaskInboxCursorPayloadV1,
  expected: GlobalTaskInboxCursorBindingV1,
): boolean {
  const actual = payload.binding;
  return actual.workspaceId === expected.workspaceId
    && actual.actorId === expected.actorId
    && actual.membershipId === expected.membershipId
    && actual.filter === expected.filter
    && actual.state === expected.state
    && actual.dueBucket === expected.dueBucket
    && actual.query === expected.query
    && actual.timeZone === expected.timeZone
    && actual.asOf === expected.asOf
    && actual.order === expected.order;
}

export function parseGlobalTaskInboxPageV1(input: unknown): GlobalTaskInboxPageV1 {
  const parsed = globalTaskInboxPageV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new GlobalTaskInboxContractError("invalid_global_task_inbox_projection");
  }
  return parsed.data;
}

type CalendarDate = { year: number; month: number; day: number };

const berlinDateFormatter = new Intl.DateTimeFormat("en-CA-u-ca-iso8601", {
  timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const berlinDateTimeFormatter = new Intl.DateTimeFormat("en-CA-u-ca-iso8601", {
  timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function numberPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) {
    throw new GlobalTaskInboxContractError("invalid_global_task_inbox_query");
  }
  return Number(value);
}

function berlinCalendarDate(instant: Date): CalendarDate {
  const parts = berlinDateFormatter.formatToParts(instant);
  return {
    year: numberPart(parts, "year"),
    month: numberPart(parts, "month"),
    day: numberPart(parts, "day"),
  };
}

function nextCalendarDate(value: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(value.year, value.month - 1, value.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function berlinMidnight(value: CalendarDate): string {
  const localMidnightAsUtc = Date.UTC(value.year, value.month - 1, value.day);
  let candidate = localMidnightAsUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = berlinDateTimeFormatter.formatToParts(new Date(candidate));
    const renderedAsUtc = Date.UTC(
      numberPart(parts, "year"),
      numberPart(parts, "month") - 1,
      numberPart(parts, "day"),
      numberPart(parts, "hour"),
      numberPart(parts, "minute"),
      numberPart(parts, "second"),
    );
    const next = localMidnightAsUtc - (renderedAsUtc - candidate);
    if (next === candidate) break;
    candidate = next;
  }

  return new Date(candidate).toISOString();
}

export type GlobalTaskInboxBerlinDayBounds = {
  dayStart: string;
  nextDayStart: string;
};

export function globalTaskInboxBerlinDayBounds(
  canonicalAsOf: string,
): GlobalTaskInboxBerlinDayBounds {
  const parsed = canonicalInstantSchema.safeParse(canonicalAsOf);
  if (!parsed.success) {
    throw new GlobalTaskInboxContractError("invalid_global_task_inbox_query");
  }
  const date = berlinCalendarDate(new Date(parsed.data));
  return {
    dayStart: berlinMidnight(date),
    nextDayStart: berlinMidnight(nextCalendarDate(date)),
  };
}
