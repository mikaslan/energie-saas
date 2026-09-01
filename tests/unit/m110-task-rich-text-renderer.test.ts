import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskRichTextRenderer } from "@/app/w/[workspaceId]/anfragen/[projectId]/task-rich-text-renderer";
import type { TaskRichTextV1 } from "@/lib/integrations/tasks/contract";

describe("M1-10 sicherer Task-Richtext-Renderer", () => {
  it("rendert ausschließlich die geschlossene Struktur und escaped Text", () => {
    const body: TaskRichTextV1 = {
      schemaVersion: "task-rich-text.v1",
      doc: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Planung <script>alert(1)</script>" }],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Wichtig", marks: [{ type: "bold" }, { type: "italic" }] },
              { type: "hardBreak" },
              { type: "text", text: "prüfen" },
            ],
          },
          {
            type: "orderedList",
            attrs: { start: 3 },
            content: [{
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Netzanfrage" }] }],
            }],
          },
        ],
      },
    };
    const html = renderToStaticMarkup(createElement(TaskRichTextRenderer, { body }));
    expect(html).toContain("<h2");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<strong><em>Wichtig</em></strong>");
    expect(html).toContain("<br/>");
    expect(html).toContain('<ol start="3"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("verweigert unbekannte Runtime-Nodes statt sie still zu rendern", () => {
    const body = {
      schemaVersion: "task-rich-text.v1",
      doc: { type: "doc", content: [{ type: "image", attrs: { src: "data:text/html,x" } }] },
    } as unknown as TaskRichTextV1;
    expect(() => renderToStaticMarkup(createElement(TaskRichTextRenderer, { body })))
      .toThrow();
  });

  it("stuft Überschriften innerhalb einer Taskkarte semantisch ab", () => {
    const body: TaskRichTextV1 = {
      schemaVersion: "task-rich-text.v1",
      doc: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Teil" }] },
          { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Detail" }] },
        ],
      },
    };
    const html = renderToStaticMarkup(createElement(TaskRichTextRenderer, {
      body,
      headingOffset: 3,
    }));
    expect(html).toContain("<h5");
    expect(html).toContain("<h6");
    expect(html).not.toContain("<h2");
    expect(html).not.toContain("<h3");
    expect(html).not.toContain("<h4");
  });
});
