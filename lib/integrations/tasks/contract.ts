import { z } from "zod";

export const PROJECT_TASK_COMMAND_VERSION = "project-task-command.v1" as const;
export const TASK_RICH_TEXT_VERSION = "task-rich-text.v1" as const;
export const PROJECT_TASK_MAX_ASSIGNEES = 50 as const;
export const PROJECT_TASK_MAX_CHECKLIST_ITEMS = 100 as const;
export const PROJECT_TASK_MAX_CHECKLIST_TEXT_LENGTH = 500 as const;
export const PROJECT_TASK_MAX_LABELS = 15 as const;
export const PROJECT_TASK_MEMBER_SEARCH_LIMIT = 20 as const;
export const PROJECT_TASK_PAGE_LIMIT = 50 as const;
export const PROJECT_TASK_CURSOR_TOKEN_MAX_LENGTH = 512 as const;
export const PROJECT_TASK_MAX_REVISION = 2_147_483_647 as const;
export const TASK_RICH_TEXT_MAX_BYTES = 32 * 1024;
export const TASK_RICH_TEXT_MAX_NODES = 500;
export const TASK_RICH_TEXT_MAX_DEPTH = 8;
export const TASK_RICH_TEXT_MAX_TEXT = 10_000;

export const taskLabelColors = [
  "slate",
  "blue",
  "emerald",
  "amber",
  "rose",
  "violet",
] as const;

export type TaskLabelColor = (typeof taskLabelColors)[number];
export type TaskRichTextMark = { type: "bold" | "italic" };
export type TaskRichTextTextNode = {
  type: "text";
  text: string;
  marks?: TaskRichTextMark[];
};
export type TaskRichTextHardBreakNode = { type: "hardBreak" };
export type TaskRichTextInlineNode = TaskRichTextTextNode | TaskRichTextHardBreakNode;
export type TaskRichTextParagraphNode = {
  type: "paragraph";
  content: TaskRichTextInlineNode[];
};
export type TaskRichTextHeadingNode = {
  type: "heading";
  attrs: { level: 2 | 3 };
  content: TaskRichTextInlineNode[];
};
export type TaskRichTextListItemNode = {
  type: "listItem";
  content: Array<
    TaskRichTextParagraphNode | TaskRichTextBulletListNode | TaskRichTextOrderedListNode
  >;
};
export type TaskRichTextBulletListNode = {
  type: "bulletList";
  content: TaskRichTextListItemNode[];
};
export type TaskRichTextOrderedListNode = {
  type: "orderedList";
  attrs?: { start: number };
  content: TaskRichTextListItemNode[];
};
export type TaskRichTextBlockNode =
  | TaskRichTextParagraphNode
  | TaskRichTextHeadingNode
  | TaskRichTextBulletListNode
  | TaskRichTextOrderedListNode;
export type TaskRichTextV1 = {
  schemaVersion: typeof TASK_RICH_TEXT_VERSION;
  doc: { type: "doc"; content: TaskRichTextBlockNode[] };
};

const markSchema: z.ZodType<TaskRichTextMark> = z.strictObject({
  type: z.enum(["bold", "italic"]),
});

const textNodeSchema: z.ZodType<TaskRichTextTextNode> = z.strictObject({
  type: z.literal("text"),
  text: z.string().min(1).max(TASK_RICH_TEXT_MAX_TEXT).refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value),
    "control characters are not allowed",
  ),
  marks: z.array(markSchema).max(2).optional(),
}).superRefine((value, ctx) => {
  const marks = value.marks?.map(({ type }) => type) ?? [];
  if (new Set(marks).size !== marks.length) {
    ctx.addIssue({ code: "custom", path: ["marks"], message: "duplicate marks" });
  }
});

const hardBreakNodeSchema: z.ZodType<TaskRichTextHardBreakNode> = z.strictObject({
  type: z.literal("hardBreak"),
});
const inlineNodeSchema: z.ZodType<TaskRichTextInlineNode> = z.union([
  textNodeSchema,
  hardBreakNodeSchema,
]);
const paragraphNodeSchema: z.ZodType<TaskRichTextParagraphNode> = z.strictObject({
  type: z.literal("paragraph"),
  content: z.array(inlineNodeSchema).max(TASK_RICH_TEXT_MAX_NODES),
});
const headingNodeSchema: z.ZodType<TaskRichTextHeadingNode> = z.strictObject({
  type: z.literal("heading"),
  attrs: z.strictObject({ level: z.union([z.literal(2), z.literal(3)]) }),
  content: z.array(inlineNodeSchema).min(1).max(TASK_RICH_TEXT_MAX_NODES),
});
const listItemNodeSchema: z.ZodType<TaskRichTextListItemNode> = z.lazy(() =>
  z.strictObject({
    type: z.literal("listItem"),
    content: z.array(z.union([
      paragraphNodeSchema,
      bulletListNodeSchema,
      orderedListNodeSchema,
    ])).min(1).max(TASK_RICH_TEXT_MAX_NODES),
  }),
);
const bulletListNodeSchema: z.ZodType<TaskRichTextBulletListNode> = z.strictObject({
  type: z.literal("bulletList"),
  content: z.array(listItemNodeSchema).min(1).max(TASK_RICH_TEXT_MAX_NODES),
});
const orderedListNodeSchema: z.ZodType<TaskRichTextOrderedListNode> = z.strictObject({
  type: z.literal("orderedList"),
  attrs: z.strictObject({ start: z.number().int().min(1).max(1_000_000) }).optional(),
  content: z.array(listItemNodeSchema).min(1).max(TASK_RICH_TEXT_MAX_NODES),
});
const blockNodeSchema: z.ZodType<TaskRichTextBlockNode> = z.union([
  paragraphNodeSchema,
  headingNodeSchema,
  bulletListNodeSchema,
  orderedListNodeSchema,
]);

function richTextMetrics(value: TaskRichTextV1): {
  depth: number;
  nodes: number;
  text: number;
} {
  let depth = 1;
  let nodes = 1;
  let text = 0;

  const visit = (node: TaskRichTextBlockNode | TaskRichTextListItemNode | TaskRichTextInlineNode, currentDepth: number) => {
    nodes += 1;
    depth = Math.max(depth, currentDepth);
    if (node.type === "text") {
      text += Array.from(node.text).length;
      return;
    }
    if (node.type === "hardBreak") return;
    for (const child of node.content) visit(child, currentDepth + 1);
  };

  for (const node of value.doc.content) visit(node, 2);
  return { depth, nodes, text };
}

const taskRichTextV1StructuralSchema: z.ZodType<TaskRichTextV1> = z.strictObject({
  schemaVersion: z.literal(TASK_RICH_TEXT_VERSION),
  doc: z.strictObject({
    type: z.literal("doc"),
    content: z.array(blockNodeSchema).max(TASK_RICH_TEXT_MAX_NODES),
  }),
});

export const taskRichTextV1Schema = taskRichTextV1StructuralSchema.superRefine(
  (value, ctx) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const metrics = richTextMetrics(value);
    if (bytes > TASK_RICH_TEXT_MAX_BYTES) {
      ctx.addIssue({ code: "custom", message: "rich text exceeds byte limit" });
    }
    if (metrics.nodes > TASK_RICH_TEXT_MAX_NODES) {
      ctx.addIssue({ code: "custom", message: "rich text exceeds node limit" });
    }
    if (metrics.depth > TASK_RICH_TEXT_MAX_DEPTH) {
      ctx.addIssue({ code: "custom", message: "rich text exceeds depth limit" });
    }
    if (metrics.text > TASK_RICH_TEXT_MAX_TEXT) {
      ctx.addIssue({ code: "custom", message: "rich text exceeds text limit" });
    }
  },
);

export const EMPTY_TASK_RICH_TEXT_V1: TaskRichTextV1 = {
  schemaVersion: TASK_RICH_TEXT_VERSION,
  doc: { type: "doc", content: [] },
};

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const revisionSchema = z.number().int().min(1).max(PROJECT_TASK_MAX_REVISION);
const singleLine = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  "control characters are not allowed",
);
const titleSchema = singleLine(200);
const checklistTextSchema = singleLine(PROJECT_TASK_MAX_CHECKLIST_TEXT_LENGTH);
const labelNameSchema = z.string()
  .transform((value) => value.normalize("NFKC"))
  .pipe(singleLine(40));
const colorSchema = z.enum(taskLabelColors);

export const projectTaskCursorTokenSchema = z.string()
  .min(1)
  .max(PROJECT_TASK_CURSOR_TOKEN_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const projectTaskMemberSearchV1Schema = z.strictObject({
  query: z.string()
    .transform((value) => value.normalize("NFKC"))
    .pipe(singleLine(80).refine(
      (value) => Array.from(value).length >= 2,
      "search query is too short",
    )),
});

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const monthLengths = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  return day <= monthLengths[month - 1]!;
}

export const projectTaskDueDateSchema = z.string().refine(isCalendarDate, "invalid date");

const assigneeIdsSchema = z.array(uuidSchema).max(PROJECT_TASK_MAX_ASSIGNEES)
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "duplicate assignee" });
    }
  });
const createChecklistItemSchema = z.strictObject({
  text: checklistTextSchema,
  done: z.boolean(),
});
const updateChecklistItemSchema = z.strictObject({
  id: uuidSchema.nullable(),
  text: checklistTextSchema,
  done: z.boolean(),
});
const createLabelSchema = z.strictObject({
  name: labelNameSchema,
  color: colorSchema,
});
const updateLabelSchema = z.strictObject({
  id: uuidSchema.nullable(),
  name: labelNameSchema,
  color: colorSchema,
});

function uniqueLabels<T extends { name: string }>(labels: T[], ctx: z.RefinementCtx): void {
  const keys = labels.map(({ name }) => name.toLowerCase());
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: "custom", message: "duplicate label" });
  }
}

const createChecklistSchema = z.array(createChecklistItemSchema)
  .max(PROJECT_TASK_MAX_CHECKLIST_ITEMS);
const updateChecklistSchema = z.array(updateChecklistItemSchema)
  .max(PROJECT_TASK_MAX_CHECKLIST_ITEMS)
  .superRefine((items, ctx) => {
    const ids = items.flatMap(({ id }) => id === null ? [] : [id]);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "duplicate checklist item" });
    }
  });
const createLabelsSchema = z.array(createLabelSchema).max(PROJECT_TASK_MAX_LABELS)
  .superRefine(uniqueLabels);
const updateLabelsSchema = z.array(updateLabelSchema).max(PROJECT_TASK_MAX_LABELS)
  .superRefine((labels, ctx) => {
    uniqueLabels(labels, ctx);
    const ids = labels.flatMap(({ id }) => id === null ? [] : [id]);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "duplicate label id" });
    }
  });

const commandBase = {
  schemaVersion: z.literal(PROJECT_TASK_COMMAND_VERSION),
  projectId: uuidSchema,
} as const;
const revisionBase = {
  ...commandBase,
  taskId: uuidSchema,
  expectedRevision: revisionSchema,
} as const;

export const projectTaskCommandV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...commandBase,
    kind: z.literal("quick_create"),
    title: titleSchema,
  }),
  z.strictObject({
    ...commandBase,
    kind: z.literal("create"),
    title: titleSchema,
    body: taskRichTextV1Schema,
    dueDate: projectTaskDueDateSchema.nullable(),
    assigneeMembershipIds: assigneeIdsSchema,
    checklist: createChecklistSchema,
    labels: createLabelsSchema,
  }),
  z.strictObject({
    ...revisionBase,
    kind: z.literal("update"),
    title: titleSchema,
    body: taskRichTextV1Schema,
    dueDate: projectTaskDueDateSchema.nullable(),
    assigneeMembershipIds: assigneeIdsSchema,
    checklist: updateChecklistSchema,
    labels: updateLabelsSchema,
  }),
  z.strictObject({
    ...revisionBase,
    kind: z.literal("toggle_checklist_item"),
    checklistItemId: uuidSchema,
    done: z.boolean(),
  }),
  z.strictObject({ ...revisionBase, kind: z.literal("complete") }),
  z.strictObject({ ...revisionBase, kind: z.literal("reopen") }),
  z.strictObject({
    ...revisionBase,
    kind: z.literal("archive"),
    archiveConfirmation: z.literal("archive"),
  }),
]);

export type ProjectTaskCommandV1 = z.infer<typeof projectTaskCommandV1Schema>;
export type ProjectTaskMemberSearchV1 = z.infer<typeof projectTaskMemberSearchV1Schema>;

export type ProjectTaskAssigneeV1 = { membershipId: string; label: string };
export type ProjectTaskMemberOptionV1 = { membershipId: string; label: string };
export type ProjectTaskChecklistItemV1 = {
  id: string;
  position: number;
  text: string;
  done: boolean;
};
export type ProjectTaskLabelV1 = {
  id: string;
  position: number;
  name: string;
  color: TaskLabelColor;
};
export type ProjectTaskItemV1 = {
  id: string;
  revision: number;
  title: string;
  body: TaskRichTextV1;
  dueAt: string | null;
  status: "open" | "done";
  completedAt: string | null;
  archivedAt: string | null;
  assignees: ProjectTaskAssigneeV1[];
  checklist: ProjectTaskChecklistItemV1[];
  labels: ProjectTaskLabelV1[];
};
export type ProjectTaskWorkspaceV1 = {
  schemaVersion: "project-task-workspace.v1";
  projectId: string;
  permissions: { canWrite: boolean };
  taskPageLimit: typeof PROJECT_TASK_PAGE_LIMIT;
  nextTaskCursor: string | null;
  open: ProjectTaskItemV1[];
  done: ProjectTaskItemV1[];
  archived: ProjectTaskItemV1[];
  archivedCount: number;
};
export type ProjectTaskActivityKind =
  | "task_created"
  | "task_updated"
  | "task_checklist_changed"
  | "task_completed"
  | "task_reopened"
  | "task_archived";
export type ProjectOutcomeActivityKind =
  | "outcome_won"
  | "outcome_lost"
  | "outcome_reopened";
export type ProjectNoteActivityKind =
  | "note_created"
  | "note_updated"
  | "note_deleted"
  | "note_pinned"
  | "note_unpinned";
export type ProjectActivityKind =
  | ProjectTaskActivityKind
  | ProjectOutcomeActivityKind
  | ProjectNoteActivityKind;
export const projectActivityLabels = {
  task_created: "Aufgabe erstellt",
  task_updated: "Aufgabe aktualisiert",
  task_checklist_changed: "Checkliste aktualisiert",
  task_completed: "Aufgabe abgeschlossen",
  task_reopened: "Aufgabe wieder geöffnet",
  task_archived: "Aufgabe archiviert",
  outcome_won: "Anfrage gewonnen",
  outcome_lost: "Anfrage verloren",
  outcome_reopened: "Anfrage wieder geöffnet",
  note_created: "Notiz erstellt",
  note_updated: "Notiz bearbeitet",
  note_deleted: "Notiz gelöscht",
  note_pinned: "Notiz angepinnt",
  note_unpinned: "Notiz losgelöst",
} as const satisfies Record<ProjectActivityKind, string>;
export type ProjectActivityCursor = { occurredAt: string; id: string };
type ProjectActivityItemBaseV1 = {
  id: string;
  occurredAt: string;
  actorLabel: string;
};
export type ProjectActivityItemV1 =
  | (ProjectActivityItemBaseV1 & {
      kind: ProjectTaskActivityKind;
      label: (typeof projectActivityLabels)[ProjectTaskActivityKind];
      taskId: string;
      taskTitle: string | null;
    })
  | (ProjectActivityItemBaseV1 & {
      kind: ProjectOutcomeActivityKind | ProjectNoteActivityKind;
      label: (typeof projectActivityLabels)[
        ProjectOutcomeActivityKind | ProjectNoteActivityKind
      ];
      taskId: null;
      taskTitle: null;
    });
export type ProjectActivityPageV1 = {
  schemaVersion: "project-activity-page.v1";
  items: ProjectActivityItemV1[];
  nextCursor: ProjectActivityCursor | null;
};
export type ProjectTaskPageV1 = {
  schemaVersion: "project-task-page.v1";
  workspace: ProjectTaskWorkspaceV1;
  activity: ProjectActivityPageV1;
};
export type ProjectTaskMemberSearchPageV1 = {
  schemaVersion: "project-task-member-search-page.v1";
  query: string;
  members: ProjectTaskMemberOptionV1[];
  hasMore: boolean;
};
export type ProjectTaskCommandResult = {
  projectId: string;
  taskId: string;
  revision: number;
  changed: boolean;
};
