import { z } from "zod";

export const PROJECT_OUTCOME_COMMAND_VERSION = "project-outcome-command.v1" as const;
export const PROJECT_LOSS_REASON_COMMAND_VERSION = "project-loss-reason-command.v1" as const;
export const PROJECT_OUTCOME_MAX_REVISION = 2_147_483_647 as const;
export const PROJECT_OUTCOME_TEXT_MAX_LENGTH = 500 as const;
export const PROJECT_LOSS_REASON_LABEL_MAX_LENGTH = 80 as const;
export const PROJECT_CLOSED_REQUEST_PAGE_LIMIT = 50 as const;
export const PROJECT_CLOSED_REQUEST_CURSOR_MAX_LENGTH = 512 as const;

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const outcomeRevisionSchema = z.number()
  .int()
  .min(0)
  .max(PROJECT_OUTCOME_MAX_REVISION - 1);
const reasonRevisionSchema = z.number()
  .int()
  .min(1)
  .max(PROJECT_OUTCOME_MAX_REVISION - 1);

function normalizedSingleLine(maximumLength: number) {
  return z.string()
    .transform((value) => value.normalize("NFKC").trim())
    .pipe(z.string()
      .min(1)
      .max(maximumLength)
      .refine((value) => !controlCharacters.test(value), {
        message: "control characters are not allowed",
      }));
}

const projectCommandBase = {
  schemaVersion: z.literal(PROJECT_OUTCOME_COMMAND_VERSION),
  projectId: uuidSchema,
  expectedOutcomeRevision: outcomeRevisionSchema,
} as const;

export const projectOutcomeCommandV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...projectCommandBase,
    kind: z.literal("mark_won"),
    confirmation: z.literal("mark_won"),
  }),
  z.strictObject({
    ...projectCommandBase,
    kind: z.literal("mark_lost"),
    lossReasonId: uuidSchema,
    lossReasonText: normalizedSingleLine(PROJECT_OUTCOME_TEXT_MAX_LENGTH).nullable(),
    confirmation: z.literal("mark_lost"),
  }),
  z.strictObject({
    ...projectCommandBase,
    kind: z.literal("reopen"),
    confirmation: z.literal("reopen"),
  }),
  z.strictObject({
    ...projectCommandBase,
    kind: z.literal("mark_cannot_fulfill"),
    confirmation: z.literal("mark_cannot_fulfill"),
  }),
]);

const reasonCommandBase = {
  schemaVersion: z.literal(PROJECT_LOSS_REASON_COMMAND_VERSION),
} as const;
const existingReasonCommandBase = {
  ...reasonCommandBase,
  reasonId: uuidSchema,
  expectedRevision: reasonRevisionSchema,
} as const;

export const projectLossReasonCommandV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...reasonCommandBase,
    kind: z.literal("create"),
    label: normalizedSingleLine(PROJECT_LOSS_REASON_LABEL_MAX_LENGTH),
  }),
  z.strictObject({
    ...existingReasonCommandBase,
    kind: z.literal("archive"),
    archiveConfirmation: z.literal("archive"),
  }),
  z.strictObject({
    ...existingReasonCommandBase,
    kind: z.literal("reactivate"),
  }),
]);

export const projectClosedRequestFilterSchema = z.enum(["all", "won", "lost", "cannot_fulfill"]);
export const projectClosedRequestCursorSchema = z.string()
  .min(1)
  .max(PROJECT_CLOSED_REQUEST_CURSOR_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/u);

export type ProjectOutcomeCommandV1 = z.infer<typeof projectOutcomeCommandV1Schema>;
export type ProjectLossReasonCommandV1 = z.infer<typeof projectLossReasonCommandV1Schema>;
export type ProjectClosedRequestFilter = z.infer<typeof projectClosedRequestFilterSchema>;
