import { z } from "zod";
import {
  NOTE_TEXT_MAX_LENGTH,
  validateNoteMarkdown,
} from "./note-markdown";

export const PROJECT_NOTE_COMMAND_VERSION = "project-note-command.v1" as const;
export const PROJECT_NOTE_ITEM_VERSION = "project-note-item.v1" as const;
export const PROJECT_NOTE_PAGE_VERSION = "project-note-page.v1" as const;
export const PROJECT_NOTE_MAX_REVISION = 2_147_483_647 as const;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const canonicalUuidSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  "UUID must be canonical lowercase",
);
const revisionSchema = z.number().int().min(1).max(PROJECT_NOTE_MAX_REVISION);

const canonicalInstantSchema = z.string()
  .regex(/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
  }, "instant must be a canonical UTC timestamp");

const labelSchema = z.string().min(1).max(320);

const textMarkdownSchema = z.string()
  .min(1)
  .max(NOTE_TEXT_MAX_LENGTH)
  .superRefine((value, ctx) => {
    const result = validateNoteMarkdown(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: `note markdown invalid: ${result.reason}` });
    }
  });

// note-text.v1: { plain, markdown } — plain ist stets die serverseitige
// Ableitung des validierten Markdowns (P2-4) und wird hier mitgeprüft.
export const noteTextV1Schema = z.strictObject({
  plain: z.string().min(1).max(NOTE_TEXT_MAX_LENGTH),
  markdown: textMarkdownSchema,
}).superRefine((value, ctx) => {
  const result = validateNoteMarkdown(value.markdown);
  if (result.ok && result.plain !== value.plain) {
    ctx.addIssue({
      code: "custom",
      path: ["plain"],
      message: "plain must equal the server-derived plain text",
    });
  }
});

export type NoteTextV1 = z.infer<typeof noteTextV1Schema>;

const commandBase = {
  schemaVersion: z.literal(PROJECT_NOTE_COMMAND_VERSION),
  projectId: uuidSchema,
} as const;
const mutationBase = {
  ...commandBase,
  noteId: uuidSchema,
  expectedRevision: revisionSchema,
} as const;

export const projectNoteCommandV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...commandBase,
    kind: z.literal("create_note"),
    textMarkdown: textMarkdownSchema,
    pinned: z.boolean(),
  }),
  z.strictObject({
    ...mutationBase,
    kind: z.literal("update_note_text"),
    textMarkdown: textMarkdownSchema,
  }),
  z.strictObject({
    ...mutationBase,
    kind: z.literal("set_note_pinned"),
    pinned: z.boolean(),
  }),
  z.strictObject({
    ...mutationBase,
    kind: z.literal("delete_note"),
  }),
]);

export type ProjectNoteCommandV1 = z.infer<typeof projectNoteCommandV1Schema>;
export type ProjectNoteCommandResult = {
  projectId: string;
  noteId: string;
  revision: number;
  changed: boolean;
};

// Minimiertes DTO (Spec §4.3): verbotene Felder (workspace_id, parent_type,
// Fremd-IDs, domain_events-/audit_log-Daten, MDCV_2) sind nicht Teil des
// Schemas und scheitern daher an strictObject.
export const projectNoteMentionV1Schema = z.strictObject({
  userIdentityId: canonicalUuidSchema,
  emailLower: z.string().min(3).max(254),
});

export type ProjectNoteMentionV1 = z.infer<typeof projectNoteMentionV1Schema>;

export const projectNoteItemV1Schema = z.strictObject({
  id: canonicalUuidSchema,
  revision: revisionSchema,
  textPlain: z.string().min(1).max(NOTE_TEXT_MAX_LENGTH),
  textMarkdown: textMarkdownSchema,
  pinned: z.boolean(),
  createdAt: canonicalInstantSchema,
  createdByLabel: labelSchema,
  editedAt: canonicalInstantSchema.nullable(),
  editedByLabel: labelSchema.nullable(),
  pinnedAt: canonicalInstantSchema.nullable(),
  pinnedByLabel: labelSchema.nullable(),
  mentions: z.array(projectNoteMentionV1Schema),
});

export type ProjectNoteItemV1 = z.infer<typeof projectNoteItemV1Schema>;

export const projectNotePageV1Schema = z.strictObject({
  schemaVersion: z.literal(PROJECT_NOTE_PAGE_VERSION),
  projectId: canonicalUuidSchema,
  permissions: z.strictObject({ canWrite: z.boolean() }),
  notes: z.array(projectNoteItemV1Schema),
});

export type ProjectNotePageV1 = z.infer<typeof projectNotePageV1Schema>;

export const noteErrorCodeSchema = z.enum([
  "invalid",
  "not_found",
  "conflict",
  "denied",
  "unauthenticated",
]);
