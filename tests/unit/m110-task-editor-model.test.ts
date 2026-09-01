import { describe, expect, it } from "vitest";
import { EMPTY_TASK_RICH_TEXT_V1 } from "@/lib/integrations/tasks/contract";
import {
  taskBodyFromEditor,
  taskBodyToEditorDocument,
} from "@/app/w/[workspaceId]/anfragen/[projectId]/task-editor-model";

describe("M1-10 Task-Editor-Sicherheitsadapter", () => {
  it("normalisiert ausschließlich bekannte Tiptap-Werte in den App-Vertrag", () => {
    const result = taskBodyFromEditor({
      type: "doc",
      content: [
        { type: "paragraph" },
        {
          type: "orderedList",
          attrs: { start: 1, type: null },
          content: [{
            type: "listItem",
            content: [{
              type: "paragraph",
              content: [{
                type: "text",
                text: "Prüfen",
                marks: [{ type: "italic" }, { type: "bold" }],
              }],
            }],
          }],
        },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.body).toEqual({
      schemaVersion: "task-rich-text.v1",
      doc: {
        type: "doc",
        content: [
          { type: "paragraph", content: [] },
          {
            type: "orderedList",
            attrs: { start: 1 },
            content: [{
              type: "listItem",
              content: [{
                type: "paragraph",
                content: [{
                  type: "text",
                  text: "Prüfen",
                  marks: [{ type: "bold" }, { type: "italic" }],
                }],
              }],
            }],
          },
        ],
      },
    });
  });

  it.each([
    {
      label: "unbekanntes Attribut",
      document: { type: "doc", content: [{ type: "paragraph", attrs: { style: "display:none" } }] },
    },
    {
      label: "unbekannter Node",
      document: { type: "doc", content: [{ type: "image", attrs: { src: "data:text/html,x" } }] },
    },
    {
      label: "Überschrift im Listenelement",
      document: {
        type: "doc",
        content: [{
          type: "bulletList",
          content: [{
            type: "listItem",
            content: [{ type: "heading", attrs: { level: 2 }, content: [] }],
          }],
        }],
      },
    },
  ])("verweigert $label", ({ document }) => {
    expect(taskBodyFromEditor(document).valid).toBe(false);
  });

  it("gibt dem Tiptap-block+-Schema für den leeren Vertragsbody einen Absatz", () => {
    expect(taskBodyToEditorDocument(EMPTY_TASK_RICH_TEXT_V1)).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [] }],
    });
  });

  it("kanonisiert den unveränderten Tiptap-Leerzustand zurück zum leeren Vertrag", () => {
    expect(taskBodyFromEditor(taskBodyToEditorDocument(EMPTY_TASK_RICH_TEXT_V1)))
      .toEqual({ body: EMPTY_TASK_RICH_TEXT_V1, valid: true });
  });
});
