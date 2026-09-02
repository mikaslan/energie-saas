import {
  markdownToNoteRichText,
  noteRichTextToMarkdown,
  validateNoteMarkdown,
  type NoteTextMark,
  type NoteTextRichTextDoc,
} from "@/lib/integrations/notes/note-markdown";

type JsonRecord = Record<string, unknown>;

class InvalidNoteDocumentError extends Error {}

const HTTP_MAILTO_HREF = /^(?:https?:\/\/|mailto:)/iu;

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidNoteDocumentError();
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, allowed: readonly string[]): void {
  const allowlist = new Set(allowed);
  if (Object.keys(value).some((key) => !allowlist.has(key))) {
    throw new InvalidNoteDocumentError();
  }
}

function content(value: JsonRecord, depth: number): unknown[] {
  if (depth > 12) throw new InvalidNoteDocumentError();
  if (value.content === undefined) return [];
  if (!Array.isArray(value.content)) throw new InvalidNoteDocumentError();
  return value.content;
}

function safeHref(value: string): string {
  const trimmed = value.trim();
  if (!HTTP_MAILTO_HREF.test(trimmed) || /[<>"'\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new InvalidNoteDocumentError();
  }
  return trimmed;
}

function parseMarks(value: unknown): NoteTextMark[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new InvalidNoteDocumentError();
  const found = new Set<string>();
  const marks: NoteTextMark[] = [];
  for (const candidate of value) {
    const mark = record(candidate);
    if (mark.type === "bold" || mark.type === "italic" || mark.type === "strike" || mark.type === "code") {
      exactKeys(mark, ["type"]);
    } else if (mark.type === "link") {
      exactKeys(mark, ["type", "attrs"]);
      const attrs = record(mark.attrs);
      exactKeys(attrs, ["href"]);
      if (typeof attrs.href !== "string") throw new InvalidNoteDocumentError();
      marks.push({ type: "link", attrs: { href: safeHref(attrs.href) } });
      continue;
    } else {
      throw new InvalidNoteDocumentError();
    }
    if (found.has(mark.type)) throw new InvalidNoteDocumentError();
    found.add(mark.type);
    marks.push({ type: mark.type } as NoteTextMark);
  }
  const normalized = (["bold", "italic", "strike", "code"] as const)
    .filter((type) => found.has(type))
    .map((type) => ({ type }));
  const link = marks.find(({ type }) => type === "link");
  const ordered = [...normalized, ...(link ? [link] : [])];
  return ordered.length > 0 ? ordered : undefined;
}

function parseInline(value: unknown): unknown {
  const node = record(value);
  if (node.type !== "text") throw new InvalidNoteDocumentError();
  exactKeys(node, ["type", "text", "marks"]);
  if (typeof node.text !== "string") throw new InvalidNoteDocumentError();
  const marks = parseMarks(node.marks);
  return {
    type: "text",
    text: node.text,
    ...(marks ? { marks } : {}),
  };
}

function parseParagraph(value: unknown, depth: number): unknown {
  const node = record(value);
  exactKeys(node, ["type", "content"]);
  if (node.type !== "paragraph") throw new InvalidNoteDocumentError();
  return { type: "paragraph", content: content(node, depth).map(parseInline) };
}

function parseHeading(value: unknown, depth: number): unknown {
  const node = record(value);
  exactKeys(node, ["type", "attrs", "content"]);
  if (node.type !== "heading") throw new InvalidNoteDocumentError();
  const attrs = record(node.attrs);
  exactKeys(attrs, ["level"]);
  if (attrs.level !== 1 && attrs.level !== 2 && attrs.level !== 3) {
    throw new InvalidNoteDocumentError();
  }
  return {
    type: "heading",
    attrs: { level: attrs.level },
    content: content(node, depth).map(parseInline),
  };
}

function parseListItem(value: unknown, depth: number): unknown {
  const node = record(value);
  exactKeys(node, ["type", "content"]);
  if (node.type !== "listItem") throw new InvalidNoteDocumentError();
  const children = content(node, depth).map((child) => {
    const childNode = record(child);
    if (childNode.type === "paragraph") return parseParagraph(child, depth + 1);
    throw new InvalidNoteDocumentError();
  });
  if (children.length !== 1) throw new InvalidNoteDocumentError();
  return { type: "listItem", content: children };
}

function parseList(value: unknown, depth: number): unknown {
  const node = record(value);
  if (node.type === "bulletList") {
    exactKeys(node, ["type", "content"]);
    return { type: "bulletList", content: content(node, depth).map((child) => parseListItem(child, depth + 1)) };
  }
  if (node.type === "orderedList") {
    exactKeys(node, ["type", "attrs", "content"]);
    const attrs = node.attrs === undefined ? undefined : record(node.attrs);
    let start: number | undefined;
    if (attrs !== undefined) {
      exactKeys(attrs, ["start"]);
      if (!Number.isInteger(attrs.start)) throw new InvalidNoteDocumentError();
      start = attrs.start as number;
    }
    return {
      type: "orderedList",
      ...(start !== undefined ? { attrs: { start } } : {}),
      content: content(node, depth).map((child) => parseListItem(child, depth + 1)),
    };
  }
  throw new InvalidNoteDocumentError();
}

function parseBlock(value: unknown, depth: number): unknown {
  const node = record(value);
  if (node.type === "paragraph") return parseParagraph(value, depth + 1);
  if (node.type === "heading") return parseHeading(value, depth + 1);
  if (node.type === "bulletList" || node.type === "orderedList") {
    return parseList(value, depth + 1);
  }
  throw new InvalidNoteDocumentError();
}

function parseDocument(value: unknown): NoteTextRichTextDoc {
  const document = record(value);
  exactKeys(document, ["type", "content"]);
  if (document.type !== "doc") throw new InvalidNoteDocumentError();
  return {
    type: "doc",
    content: content(document, 1).map((node) => parseBlock(node, 2)) as NoteTextRichTextDoc["content"],
  };
}

export function noteMarkdownFromEditor(document: unknown): {
  markdown: string;
  valid: boolean;
} {
  try {
    const doc = parseDocument(document);
    const markdown = noteRichTextToMarkdown(doc);
    const validated = validateNoteMarkdown(markdown);
    return validated.ok
      ? { markdown, valid: true }
      : { markdown, valid: false };
  } catch (error) {
    if (error instanceof InvalidNoteDocumentError) {
      return { markdown: "", valid: false };
    }
    throw error;
  }
}

export function noteEditorDocumentFromMarkdown(markdown: string): NoteTextRichTextDoc {
  const doc = markdownToNoteRichText(markdown);
  if (doc.content.length > 0) return doc;
  return { type: "doc", content: [{ type: "paragraph", content: [] }] };
}
