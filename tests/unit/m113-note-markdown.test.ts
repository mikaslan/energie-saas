import { describe, expect, it } from "vitest";
import {
  markdownToNoteRichText,
  markdownToPlainText,
  noteRichTextToMarkdown,
  validateNoteMarkdown,
} from "@/lib/integrations/notes/note-markdown";

describe("M1-13 note-text.v1 Markdown-Serializer", () => {
  it("roundtrippt die unterstützte Teilmenge deterministisch", () => {
    const doc = {
      type: "doc" as const,
      content: [
        { type: "heading" as const, attrs: { level: 1 as const }, content: [{ type: "text" as const, text: "Titel" }] },
        {
          type: "paragraph" as const,
          content: [
            { type: "text" as const, text: "Fett", marks: [{ type: "bold" as const }] },
            { type: "text" as const, text: " " },
            { type: "text" as const, text: "Kursiv", marks: [{ type: "italic" as const }] },
            { type: "text" as const, text: " " },
            { type: "text" as const, text: "Code", marks: [{ type: "code" as const }] },
          ],
        },
        {
          type: "bulletList" as const,
          content: [{ type: "listItem" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Punkt" }] }] }],
        },
        {
          type: "orderedList" as const,
          content: [{ type: "listItem" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Schritt" }] }] }],
        },
      ],
    };
    const markdown = noteRichTextToMarkdown(doc);
    expect(markdown).toBe("# Titel\n\n**Fett** *Kursiv* `Code`\n\n- Punkt\n\n1. Schritt");
    expect(markdownToNoteRichText(markdown)).toEqual(doc);
    expect(validateNoteMarkdown(markdown).ok).toBe(true);
  });

  it("serialisiert Links nur mit http/https/mailto und leitet plain ab", () => {
    const doc = {
      type: "doc" as const,
      content: [{
        type: "paragraph" as const,
        content: [{
          type: "text" as const,
          text: "Beispiel",
          marks: [{ type: "link" as const, attrs: { href: "https://example.test/x" } }],
        }],
      }],
    };
    const markdown = noteRichTextToMarkdown(doc);
    expect(markdown).toBe("[Beispiel](https://example.test/x)");
    expect(markdownToPlainText(markdown)).toBe("Beispiel");
  });

  it("lehnt javascript:- und data:-Links serverseitig ab (P1-1)", () => {
    for (const markdown of [
      "[x](javascript:alert(1))",
      "[x](data:text/html,<script>alert(1)</script>)",
      "[x](vbscript:msgbox(1))",
      "[x](//evil.example/path)",
    ]) {
      expect(validateNoteMarkdown(markdown).ok).toBe(false);
      expect(() => markdownToNoteRichText(markdown)).toThrow();
    }
  });

  it("lehnt Roh-HTML im Markdown serverseitig ab (P1-1)", () => {
    for (const markdown of [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "Text <b>fett</b>",
      "<!-- comment -->",
      "<!DOCTYPE html>",
    ]) {
      expect(validateNoteMarkdown(markdown)).toEqual({ ok: false, reason: "html" });
    }
  });

  it("lehnt leere, zu lange und nicht-kanonische Eingaben ab", () => {
    expect(validateNoteMarkdown("").ok).toBe(false);
    expect(validateNoteMarkdown("x".repeat(10_001)).ok).toBe(false);
    expect(validateNoteMarkdown("#### H4").ok).toBe(false);
    expect(validateNoteMarkdown("**a *b* c**").ok).toBe(false);
  });

  it("akzeptiert mailto: als einziges Nicht-Web-Scheme", () => {
    expect(validateNoteMarkdown("[Mail](mailto:a@b.test)").ok).toBe(true);
    expect(validateNoteMarkdown("[Mail](ftp://x.test)").ok).toBe(false);
  });
});
