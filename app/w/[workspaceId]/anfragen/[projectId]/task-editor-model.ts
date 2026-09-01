import {
  EMPTY_TASK_RICH_TEXT_V1,
  TASK_RICH_TEXT_VERSION,
  taskRichTextV1Schema,
  type TaskRichTextV1,
} from "@/lib/integrations/tasks/contract";

type JsonRecord = Record<string, unknown>;

class InvalidEditorDocumentError extends Error {}

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidEditorDocumentError();
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, allowed: readonly string[]): void {
  const allowlist = new Set(allowed);
  if (Object.keys(value).some((key) => !allowlist.has(key))) {
    throw new InvalidEditorDocumentError();
  }
}

function content(value: JsonRecord, depth: number): unknown[] {
  if (depth > 12) throw new InvalidEditorDocumentError();
  if (value.content === undefined) return [];
  if (!Array.isArray(value.content)) throw new InvalidEditorDocumentError();
  return value.content;
}

function parseMarks(value: unknown): Array<{ type: "bold" | "italic" }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new InvalidEditorDocumentError();
  const found = new Set<"bold" | "italic">();
  for (const candidate of value) {
    const mark = record(candidate);
    exactKeys(mark, ["type"]);
    if (mark.type !== "bold" && mark.type !== "italic") {
      throw new InvalidEditorDocumentError();
    }
    if (found.has(mark.type)) throw new InvalidEditorDocumentError();
    found.add(mark.type);
  }
  const normalized = (["bold", "italic"] as const)
    .filter((type) => found.has(type))
    .map((type) => ({ type }));
  return normalized.length > 0 ? normalized : undefined;
}

function parseInline(value: unknown): unknown {
  const node = record(value);
  if (node.type === "hardBreak") {
    exactKeys(node, ["type"]);
    return { type: "hardBreak" };
  }
  if (node.type !== "text") throw new InvalidEditorDocumentError();
  exactKeys(node, ["type", "text", "marks"]);
  if (typeof node.text !== "string") throw new InvalidEditorDocumentError();
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
  if (node.type !== "paragraph") throw new InvalidEditorDocumentError();
  return {
    type: "paragraph",
    content: content(node, depth).map(parseInline),
  };
}

function parseHeading(value: unknown, depth: number): unknown {
  const node = record(value);
  exactKeys(node, ["type", "attrs", "content"]);
  if (node.type !== "heading") throw new InvalidEditorDocumentError();
  const attrs = record(node.attrs);
  exactKeys(attrs, ["level"]);
  if (attrs.level !== 2 && attrs.level !== 3) throw new InvalidEditorDocumentError();
  return {
    type: "heading",
    attrs: { level: attrs.level },
    content: content(node, depth).map(parseInline),
  };
}

function parseListItem(value: unknown, depth: number): unknown {
  const node = record(value);
  exactKeys(node, ["type", "content"]);
  if (node.type !== "listItem") throw new InvalidEditorDocumentError();
  return {
    type: "listItem",
    content: content(node, depth).map((child) => {
      const childNode = record(child);
      if (childNode.type === "paragraph") return parseParagraph(child, depth + 1);
      if (childNode.type === "bulletList" || childNode.type === "orderedList") {
        return parseList(child, depth + 1);
      }
      throw new InvalidEditorDocumentError();
    }),
  };
}

function parseOrderedListAttributes(value: unknown): { start: number } | undefined {
  if (value === undefined) return undefined;
  const attrs = record(value);
  exactKeys(attrs, ["start", "type"]);
  if (attrs.type !== undefined && attrs.type !== null && attrs.type !== "1") {
    throw new InvalidEditorDocumentError();
  }
  if (attrs.start === undefined) return undefined;
  if (!Number.isInteger(attrs.start)) throw new InvalidEditorDocumentError();
  return { start: attrs.start as number };
}

function parseList(value: unknown, depth: number): unknown {
  const node = record(value);
  if (node.type === "bulletList") {
    exactKeys(node, ["type", "content"]);
    return {
      type: "bulletList",
      content: content(node, depth).map((child) => parseListItem(child, depth + 1)),
    };
  }
  if (node.type === "orderedList") {
    exactKeys(node, ["type", "attrs", "content"]);
    const attrs = parseOrderedListAttributes(node.attrs);
    return {
      type: "orderedList",
      ...(attrs ? { attrs } : {}),
      content: content(node, depth).map((child) => parseListItem(child, depth + 1)),
    };
  }
  throw new InvalidEditorDocumentError();
}

function parseBlock(value: unknown, depth: number): unknown {
  const node = record(value);
  if (node.type === "paragraph") return parseParagraph(value, depth + 1);
  if (node.type === "heading") return parseHeading(value, depth + 1);
  if (node.type === "bulletList" || node.type === "orderedList") {
    return parseList(value, depth + 1);
  }
  throw new InvalidEditorDocumentError();
}

function parseDocument(value: unknown): unknown {
  const document = record(value);
  exactKeys(document, ["type", "content"]);
  if (document.type !== "doc") throw new InvalidEditorDocumentError();
  return {
    type: "doc",
    content: content(document, 1).map((node) => parseBlock(node, 2)),
  };
}

export function taskBodyFromEditor(document: unknown): {
  body: unknown;
  valid: boolean;
} {
  const fallback = { schemaVersion: TASK_RICH_TEXT_VERSION, doc: document };
  try {
    const candidate = {
      schemaVersion: TASK_RICH_TEXT_VERSION,
      doc: parseDocument(document),
    };
    const parsed = taskRichTextV1Schema.safeParse(candidate);
    if (
      parsed.success
      && parsed.data.doc.content.length === 1
      && parsed.data.doc.content[0]?.type === "paragraph"
      && parsed.data.doc.content[0].content.length === 0
    ) {
      return { body: EMPTY_TASK_RICH_TEXT_V1, valid: true };
    }
    return parsed.success
      ? { body: parsed.data, valid: true }
      : { body: candidate, valid: false };
  } catch (error) {
    if (error instanceof InvalidEditorDocumentError) {
      return { body: fallback, valid: false };
    }
    throw error;
  }
}

export function taskBodyToEditorDocument(body: TaskRichTextV1): TaskRichTextV1["doc"] {
  if (body.doc.content.length > 0) return body.doc;
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [] }],
  };
}
