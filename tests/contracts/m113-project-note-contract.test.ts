import { describe, expect, it } from "vitest";
import {
  PROJECT_NOTE_COMMAND_VERSION,
  PROJECT_NOTE_ITEM_VERSION,
  PROJECT_NOTE_MAX_REVISION,
  PROJECT_NOTE_PAGE_VERSION,
  noteTextV1Schema,
  projectNoteCommandV1Schema,
  projectNoteItemV1Schema,
  projectNotePageV1Schema,
} from "@/lib/integrations/notes/note-contract";
import { NOTE_TEXT_MAX_LENGTH } from "@/lib/integrations/notes/note-markdown";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const NOTE_ID = "20000000-0000-4000-8000-000000000002";

describe("M1-13 Projektnotiz-Vertrag", () => {
  it("akzeptiert create_note und kanonisiert IDs", () => {
    expect(projectNoteCommandV1Schema.parse({
      schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
      kind: "create_note",
      projectId: PROJECT_ID.toUpperCase(),
      textMarkdown: "Erste Notiz",
      pinned: true,
    })).toMatchObject({ kind: "create_note", projectId: PROJECT_ID, pinned: true });
  });

  it("bindet alle drei Mutationen an expectedRevision", () => {
    for (const command of [
      { kind: "update_note_text", textMarkdown: "Neu" },
      { kind: "set_note_pinned", pinned: true },
      { kind: "delete_note" },
    ]) {
      expect(projectNoteCommandV1Schema.safeParse({
        schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
        projectId: PROJECT_ID,
        noteId: NOTE_ID,
        expectedRevision: 3,
        ...command,
      }).success).toBe(true);
      expect(projectNoteCommandV1Schema.safeParse({
        schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
        projectId: PROJECT_ID,
        noteId: NOTE_ID,
        ...command,
      }).success).toBe(false);
    }
  });

  it("weist Fremdfelder und javascript:-Links ab", () => {
    const valid = {
      schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
      kind: "create_note" as const,
      projectId: PROJECT_ID,
      textMarkdown: "Notiz",
      pinned: false,
    };
    for (const candidate of [
      { ...valid, workspaceId: PROJECT_ID },
      { ...valid, actorId: NOTE_ID },
      { ...valid, textMarkdown: "[x](javascript:alert(1))" },
      { ...valid, textMarkdown: "<script>alert(1)</script>" },
      { ...valid, textMarkdown: "x".repeat(NOTE_TEXT_MAX_LENGTH + 1) },
    ]) {
      expect(projectNoteCommandV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("minimiert das DTO und lehnt verbotene Felder ab", () => {
    const item = {
      id: NOTE_ID,
      revision: 1,
      textPlain: "Notiz",
      textMarkdown: "Notiz",
      pinned: false,
      createdAt: "2026-09-02T12:00:00.000Z",
      createdByLabel: "editor@test.local",
      editedAt: null,
      editedByLabel: null,
      pinnedAt: null,
      pinnedByLabel: null,
    };
    expect(projectNoteItemV1Schema.parse(item)).toEqual(item);
    for (const forbidden of [
      { ...item, workspaceId: PROJECT_ID },
      { ...item, parentType: "project" },
      { ...item, domainEvents: [] },
      { ...item, auditLog: [] },
    ]) {
      expect(projectNoteItemV1Schema.safeParse(forbidden).success).toBe(false);
    }
  });

  it("validiert note-text.v1 plain als serverseitige Ableitung", () => {
    expect(noteTextV1Schema.parse({ plain: "Hallo", markdown: "Hallo" })).toEqual({
      plain: "Hallo",
      markdown: "Hallo",
    });
    expect(noteTextV1Schema.safeParse({ plain: "falsch", markdown: "Hallo" }).success).toBe(false);
  });

  it("pinnt geschlossene Mengenlimits und Versionsliterale", () => {
    expect(PROJECT_NOTE_COMMAND_VERSION).toBe("project-note-command.v1");
    expect(PROJECT_NOTE_ITEM_VERSION).toBe("project-note-item.v1");
    expect(PROJECT_NOTE_PAGE_VERSION).toBe("project-note-page.v1");
    expect(PROJECT_NOTE_MAX_REVISION).toBe(2_147_483_647);
    expect(NOTE_TEXT_MAX_LENGTH).toBe(10_000);
    expect(projectNotePageV1Schema.parse({
      schemaVersion: PROJECT_NOTE_PAGE_VERSION,
      projectId: PROJECT_ID,
      permissions: { canWrite: true },
      notes: [],
    }).notes).toEqual([]);
  });
});
