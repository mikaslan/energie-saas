import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const DETAIL = "app/w/[workspaceId]/anfragen/[projectId]";

describe("M1-13 Notiz-UI-Core-Vertrag", () => {
  it("rendert Notiz-Markdown ausschließlich strukturell ohne HTML-Sink", async () => {
    const renderer = await readFile(`${DETAIL}/note-markdown-renderer.tsx`, "utf8");
    expect(renderer).toContain("markdownToNoteRichText");
    expect(renderer).toContain("<strong>");
    expect(renderer).toContain("<em>");
    expect(renderer).toContain("<a");
    expect(renderer).toContain("noopener noreferrer");
    expect(renderer).not.toContain("dangerouslySetInnerHTML");
    expect(renderer).not.toContain("innerHTML");
  });

  it("hält Editor, Pin/Unpin, Delete und Viewer-Grenze zugänglich", async () => {
    const section = await readFile(`${DETAIL}/project-notes-section.tsx`, "utf8");
    expect(section).toContain("useActionState");
    expect(section).toContain("changeProjectNote.bind(null, workspaceId, projectId)");
    expect(section).toContain('value="set_note_pinned"');
    expect(section).toContain('value="delete_note"');
    expect(section).toContain("Löschen");
    expect(section).toContain("Anpinnen");
    expect(section).toContain('role={isError ? "alert" : "status"}');
    expect(section).toContain("page.permissions.canWrite");
    expect(section).toContain("min-h-11");
    expect(section).toContain("Noch keine Notizen vorhanden.");
    expect(section).not.toContain("dangerouslySetInnerHTML");
  });

  it("baut einen echten Tiptap-Notizeditor mit Link-Hygiene", async () => {
    const editor = await readFile(`${DETAIL}/note-editor-dialog.tsx`, "utf8");
    const model = await readFile(`${DETAIL}/note-editor-model.ts`, "utf8");
    expect(editor).toContain("useEditor");
    expect(editor).toContain("StarterKit.configure");
    expect(editor).toContain('role="dialog"');
    expect(editor).toContain('aria-modal="true"');
    expect(editor).toContain("toggleBold()");
    expect(editor).toContain("toggleStrike()");
    expect(editor).toContain("toggleCode()");
    expect(editor).toContain("setLink");
    expect(editor).toContain('name="textMarkdown"');
    expect(editor).not.toContain("dangerouslySetInnerHTML");
    expect(model).toContain("HTTP_MAILTO_HREF");
    expect(model).toContain("mailto:");
    expect(model).not.toContain("javascript");
  });

  it("lädt Notizen erst nach der External-Verzweigung", async () => {
    const page = await readFile(`${DETAIL}/page.tsx`, "utf8");
    const externalBoundary = page.indexOf('if (pageDetail.audience === "assigned_external")');
    const noteRead = page.indexOf("loadProjectNotePage(", externalBoundary);
    expect(externalBoundary).toBeGreaterThan(-1);
    expect(noteRead).toBeGreaterThan(externalBoundary);
    expect(page).toContain('"note.read"');
    expect(page).toContain("<ProjectNotesSection");
  });

  it("trennt Client-Verträge von der serverseitigen Notiz-API", async () => {
    const editor = await readFile(`${DETAIL}/note-editor-dialog.tsx`, "utf8");
    const section = await readFile(`${DETAIL}/project-notes-section.tsx`, "utf8");
    const model = await readFile(`${DETAIL}/note-editor-model.ts`, "utf8");
    const renderer = await readFile(`${DETAIL}/note-markdown-renderer.tsx`, "utf8");
    const page = await readFile(`${DETAIL}/page.tsx`, "utf8");
    const actions = await readFile(`${DETAIL}/note-actions.ts`, "utf8");
    const service = await readFile("modules/notes/service.ts", "utf8");
    for (const clientFile of [editor, section, model, renderer]) {
      expect(clientFile).not.toContain('from "@/modules/notes');
      expect(clientFile).toContain('from "@/lib/integrations/notes/');
    }
    for (const serverFile of [page, actions]) {
      expect(serverFile).toContain('from "@/modules/notes"');
      expect(serverFile).not.toContain('from "@/modules/notes/');
    }
    expect(service.startsWith('import "server-only";')).toBe(true);
  });
});
