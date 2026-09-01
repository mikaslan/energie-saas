import { describe, expect, it } from "vitest";
import {
  PROJECT_TASK_COMMAND_VERSION,
  PROJECT_TASK_MAX_ASSIGNEES,
  PROJECT_TASK_MAX_CHECKLIST_ITEMS,
  PROJECT_TASK_MAX_LABELS,
  PROJECT_TASK_MEMBER_SEARCH_LIMIT,
  projectTaskCursorTokenSchema,
  projectTaskMemberSearchV1Schema,
  TASK_RICH_TEXT_MAX_BYTES,
  TASK_RICH_TEXT_MAX_DEPTH,
  TASK_RICH_TEXT_MAX_NODES,
  TASK_RICH_TEXT_MAX_TEXT,
  projectTaskCommandV1Schema,
  taskRichTextV1Schema,
} from "@/lib/integrations/tasks/contract";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const TASK_ID = "20000000-0000-4000-8000-000000000002";
const MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000003";
const CHECKLIST_ID = "40000000-0000-4000-8000-000000000004";
const LABEL_ID = "50000000-0000-4000-8000-000000000005";

const body = {
  schemaVersion: "task-rich-text.v1" as const,
  doc: {
    type: "doc" as const,
    content: [
      {
        type: "heading" as const,
        attrs: { level: 2 as const },
        content: [{ type: "text" as const, text: "Montage" }],
      },
      {
        type: "paragraph" as const,
        content: [{ type: "text" as const, text: "Termin abstimmen", marks: [{ type: "bold" as const }] }],
      },
    ],
  },
};

describe("M1-10 Project-Task-Vertrag", () => {
  it("akzeptiert Quick Create und kanonisiert ausschließlich seine IDs und den Titel", () => {
    expect(projectTaskCommandV1Schema.parse({
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "quick_create",
      projectId: PROJECT_ID.toUpperCase(),
      title: "  Unterlagen prüfen  ",
    })).toEqual({
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "quick_create",
      projectId: PROJECT_ID,
      title: "Unterlagen prüfen",
    });
  });

  it("akzeptiert eine vollständige Anlage mit streng begrenzten Kinddaten", () => {
    expect(projectTaskCommandV1Schema.parse({
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "create",
      projectId: PROJECT_ID,
      title: "Montage vorbereiten",
      body,
      dueDate: "2026-10-25",
      assigneeMembershipIds: [MEMBERSHIP_ID.toUpperCase()],
      checklist: [
        { text: "Gerüst prüfen", done: false },
        { text: "Zählerschrank fotografieren", done: true },
      ],
      labels: [
        { name: "Vor Ort", color: "emerald" },
        { name: "Netz", color: "blue" },
      ],
    })).toMatchObject({
      kind: "create",
      projectId: PROJECT_ID,
      title: "Montage vorbereiten",
      dueDate: "2026-10-25",
      assigneeMembershipIds: [MEMBERSHIP_ID],
    });
  });

  it("normalisiert Labels vor finalem Trim, Längencheck und Duplikatvergleich", () => {
    const command = {
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "create" as const,
      projectId: PROJECT_ID,
      title: "Montage vorbereiten",
      body,
      dueDate: null,
      assigneeMembershipIds: [],
      checklist: [],
      labels: [{ name: "  Ｖｏｒ　Ｏｒｔ  ", color: "emerald" as const }],
    };

    const parsed = projectTaskCommandV1Schema.parse(command);
    expect(parsed.kind).toBe("create");
    if (parsed.kind !== "create") throw new Error("expected create command");
    expect(parsed.labels).toEqual([
      { name: "Vor Ort", color: "emerald" },
    ]);
    expect(projectTaskCommandV1Schema.safeParse({
      ...command,
      labels: [{ name: "ﬃ".repeat(14), color: "emerald" }],
    }).success).toBe(false);
    expect(projectTaskCommandV1Schema.safeParse({
      ...command,
      labels: [
        { name: "Ａ", color: "emerald" },
        { name: "A", color: "blue" },
      ],
    }).success).toBe(false);
  });

  it("bindet Full Edit, Checklist und Zustandswechsel an die Taskrevision", () => {
    expect(projectTaskCommandV1Schema.safeParse({
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "update",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      expectedRevision: 7,
      title: "Montage vorbereiten",
      body,
      dueDate: null,
      assigneeMembershipIds: [MEMBERSHIP_ID],
      checklist: [{ id: CHECKLIST_ID, text: "Gerüst prüfen", done: false }],
      labels: [{ id: LABEL_ID, name: "Vor Ort", color: "emerald" }],
    }).success).toBe(true);

    for (const command of [
      { kind: "toggle_checklist_item", checklistItemId: CHECKLIST_ID, done: true },
      { kind: "complete" },
      { kind: "reopen" },
      { kind: "archive", archiveConfirmation: "archive" },
    ] as const) {
      expect(projectTaskCommandV1Schema.safeParse({
        schemaVersion: PROJECT_TASK_COMMAND_VERSION,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        expectedRevision: 7,
        ...command,
      }).success).toBe(true);
    }
  });

  it("weist Fremdfelder, unkanonische Daten, Duplikate und übergroße Arrays ab", () => {
    const valid = {
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "create" as const,
      projectId: PROJECT_ID,
      title: "Montage vorbereiten",
      body,
      dueDate: null,
      assigneeMembershipIds: [MEMBERSHIP_ID],
      checklist: [{ text: "Gerüst prüfen", done: false }],
      labels: [{ name: "Vor Ort", color: "emerald" as const }],
    };

    for (const candidate of [
      { ...valid, workspaceId: PROJECT_ID },
      { ...valid, actorId: MEMBERSHIP_ID },
      { ...valid, email: "private@example.test" },
      { ...valid, dueDate: "2026-02-30" },
      { ...valid, assigneeMembershipIds: [MEMBERSHIP_ID, MEMBERSHIP_ID] },
      { ...valid, labels: [...valid.labels, { name: " vor ort ", color: "blue" }] },
      { ...valid, checklist: Array.from({ length: PROJECT_TASK_MAX_CHECKLIST_ITEMS + 1 }, (_, index) => ({ text: `Punkt ${index}`, done: false })) },
      { ...valid, assigneeMembershipIds: Array.from({ length: PROJECT_TASK_MAX_ASSIGNEES + 1 }, (_, index) => `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`) },
      { ...valid, labels: Array.from({ length: PROJECT_TASK_MAX_LABELS + 1 }, (_, index) => ({ name: `Label ${index}`, color: "slate" })) },
    ]) {
      expect(projectTaskCommandV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("akzeptiert nur die v1-Richtext-Allowlist und ihre exakten Attribute", () => {
    expect(taskRichTextV1Schema.parse(body)).toEqual(body);
    for (const candidate of [
      { schemaVersion: "task-rich-text.v2", doc: body.doc },
      { ...body, html: "<script>alert(1)</script>" },
      { ...body, doc: { type: "doc", content: [{ type: "image", attrs: { src: "https://example.test/x" } }] } },
      { ...body, doc: { type: "doc", content: [{ type: "paragraph", attrs: { style: "color:red" } }] } },
      { ...body, doc: { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [] }] } },
      { ...body, doc: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [] }] } },
      { ...body, doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] } },
      { ...body, doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "nul\u0000byte" }] }] } },
    ]) {
      expect(taskRichTextV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("erzwingt Richtext-Byte-, Knoten-, Tiefen- und Textgrenzen", () => {
    const byteBomb = {
      schemaVersion: "task-rich-text.v1",
      doc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "🙂".repeat(9_000) }] }],
      },
    };
    const nodeBomb = {
      schemaVersion: "task-rich-text.v1",
      doc: {
        type: "doc",
        content: Array.from({ length: TASK_RICH_TEXT_MAX_NODES }, () => ({
          type: "paragraph",
          content: [],
        })),
      },
    };
    let nested: unknown = { type: "paragraph", content: [] };
    for (let index = 0; index < TASK_RICH_TEXT_MAX_DEPTH; index += 1) {
      nested = { type: "bulletList", content: [{ type: "listItem", content: [nested] }] };
    }
    const depthBomb = {
      schemaVersion: "task-rich-text.v1",
      doc: { type: "doc", content: [nested] },
    };
    const textBomb = {
      schemaVersion: "task-rich-text.v1",
      doc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(TASK_RICH_TEXT_MAX_TEXT + 1) }] }],
      },
    };

    expect(new TextEncoder().encode(JSON.stringify(byteBomb)).byteLength)
      .toBeGreaterThan(TASK_RICH_TEXT_MAX_BYTES);
    for (const candidate of [byteBomb, nodeBomb, depthBomb, textBomb]) {
      expect(taskRichTextV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("pinnt die geschlossenen Mengenlimits", () => {
    expect(PROJECT_TASK_MAX_ASSIGNEES).toBe(50);
    expect(PROJECT_TASK_MAX_CHECKLIST_ITEMS).toBe(100);
    expect(PROJECT_TASK_MAX_LABELS).toBe(15);
    expect(TASK_RICH_TEXT_MAX_BYTES).toBe(32 * 1024);
    expect(TASK_RICH_TEXT_MAX_NODES).toBe(500);
    expect(TASK_RICH_TEXT_MAX_DEPTH).toBe(8);
    expect(TASK_RICH_TEXT_MAX_TEXT).toBe(10_000);
    expect(PROJECT_TASK_MEMBER_SEARCH_LIMIT).toBe(20);
  });

  it("kanonisiert die task.write-gated Membersuche und begrenzt Cursortokens", () => {
    expect(projectTaskMemberSearchV1Schema.parse({ query: "  Ｍｉｋａ  " }))
      .toEqual({ query: "Mika" });
    for (const query of ["x", "x".repeat(81), "Mika\nAdmin"]) {
      expect(projectTaskMemberSearchV1Schema.safeParse({ query }).success).toBe(false);
    }
    expect(projectTaskCursorTokenSchema.safeParse("eyJ2IjoxfQ").success).toBe(true);
    expect(projectTaskCursorTokenSchema.safeParse("../cursor").success).toBe(false);
    expect(projectTaskCursorTokenSchema.safeParse("x".repeat(513)).success).toBe(false);
  });
});
