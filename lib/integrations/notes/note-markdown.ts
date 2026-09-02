// Schmaler Markdown-Serializer für den note-text.v1-Vertrag (ADR 0019, O5).
//
// Unterstützte Teilmenge (beide Richtungen, JSON↔Markdown):
//   - Blöcke: Absatz, H1–H3, UL (flat), OL (flat)
//   - Inline: bold, italic, strike, code, Links (http/https/mailto)
//
// Alles andere wird serverseitig abgelehnt. Es gibt bewusst KEINEN hardBreak,
// KEINE verschachtelten Listen, KEINE Images/Blockquotes/Codeblöcke/Tabellen
// und KEIN Roh-HTML (P1-1: Stored-XSS-Hygiene).

export const NOTE_RICH_TEXT_VERSION = "note-text.v1" as const;
export const NOTE_TEXT_MAX_LENGTH = 10_000 as const;
export const NOTE_TEXT_MAX_DEPTH = 12 as const;
export const NOTE_TEXT_MAX_NODES = 500 as const;

export type NoteTextMark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "strike" }
  | { type: "code" }
  | { type: "link"; attrs: { href: string } };

export type NoteTextTextNode = {
  type: "text";
  text: string;
  marks?: NoteTextMark[];
};
export type NoteTextInlineNode = NoteTextTextNode;
export type NoteTextParagraphNode = { type: "paragraph"; content: NoteTextInlineNode[] };
export type NoteTextHeadingNode = {
  type: "heading";
  attrs: { level: 1 | 2 | 3 };
  content: NoteTextInlineNode[];
};
export type NoteTextListItemNode = {
  type: "listItem";
  content: NoteTextParagraphNode[];
};
export type NoteTextBulletListNode = { type: "bulletList"; content: NoteTextListItemNode[] };
export type NoteTextOrderedListNode = {
  type: "orderedList";
  attrs?: { start: number };
  content: NoteTextListItemNode[];
};
export type NoteTextBlockNode =
  | NoteTextParagraphNode
  | NoteTextHeadingNode
  | NoteTextBulletListNode
  | NoteTextOrderedListNode;
export type NoteTextRichTextDoc = { type: "doc"; content: NoteTextBlockNode[] };

export const EMPTY_NOTE_RICH_TEXT: NoteTextRichTextDoc = { type: "doc", content: [] };

const HTML_PATTERN = /<\/?[a-zA-Z][^>]*>|<!--|<!|<\?/u;
const HREF_CONTROL_PATTERN = /[<>"'\u0000-\u001f\u007f]/u;

export class NoteMarkdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteMarkdownError";
  }
}

function isHttpMailtoHref(value: string): boolean {
  const href = value.trim();
  if (href === "" || HREF_CONTROL_PATTERN.test(href)) return false;
  if (/^https?:\/\//iu.test(href)) return true;
  if (/^mailto:[^\s@]+@?[^\s]*/iu.test(href)) return true;
  return false;
}

// ── Inline-Serialisierung ──────────────────────────────────────────────────

function applyMarks(text: string, marks: readonly NoteTextMark[]): string {
  let output = text;
  // Reihenfolge: code innen, dann strike, dann bold, dann italic, Link außen.
  if (marks.some(({ type }) => type === "code")) output = `\`${output}\``;
  if (marks.some(({ type }) => type === "strike")) output = `~~${output}~~`;
  if (marks.some(({ type }) => type === "bold")) output = `**${output}**`;
  if (marks.some(({ type }) => type === "italic")) output = `*${output}*`;
  const link = marks.find(({ type }) => type === "link");
  if (link?.type === "link") output = `[${output}](${link.attrs.href})`;
  return output;
}

function inlineToMarkdown(nodes: readonly NoteTextInlineNode[]): string {
  let result = "";
  for (const node of nodes) {
    if (node.type !== "text") throw new NoteMarkdownError("unexpected inline node");
    result += applyMarks(node.text, node.marks ?? []);
  }
  return result;
}

function blockToMarkdown(node: NoteTextBlockNode): string {
  switch (node.type) {
    case "paragraph":
      return inlineToMarkdown(node.content);
    case "heading":
      return `${"#".repeat(node.attrs.level)} ${inlineToMarkdown(node.content)}`;
    case "bulletList":
      return node.content
        .map((item) => `- ${paragraphContentToMarkdown(item.content)}`)
        .join("\n");
    case "orderedList": {
      const start = node.attrs?.start ?? 1;
      return node.content
        .map((item, index) => `${start + index}. ${paragraphContentToMarkdown(item.content)}`)
        .join("\n");
    }
  }
}

function paragraphContentToMarkdown(content: readonly NoteTextParagraphNode[]): string {
  if (content.length !== 1) {
    throw new NoteMarkdownError("list item must contain exactly one paragraph");
  }
  return inlineToMarkdown(content[0].content);
}

export function noteRichTextToMarkdown(doc: NoteTextRichTextDoc): string {
  const blocks = doc.content.map(blockToMarkdown);
  return blocks.join("\n\n");
}

// ── Inline-Parsing ─────────────────────────────────────────────────────────

function pushText(nodes: NoteTextInlineNode[], text: string): void {
  if (text === "") return;
  const previous = nodes[nodes.length - 1];
  if (previous?.type === "text" && (previous.marks?.length ?? 0) === 0) {
    previous.text += text;
    return;
  }
  nodes.push({ type: "text", text });
}

function parseInline(text: string): NoteTextInlineNode[] {
  const nodes: NoteTextInlineNode[] = [];
  let buffer = "";
  let index = 0;

  const findClosing = (needle: string): number => {
    const position = text.indexOf(needle, index + needle.length);
    if (position === -1) throw new NoteMarkdownError("unclosed inline marker");
    return position;
  };

  while (index < text.length) {
    const char = text[index];

    if (char === "`") {
      const close = findClosing("`");
      const inner = text.slice(index + 1, close);
      if (inner === "" || inner.includes("`")) throw new NoteMarkdownError("invalid code span");
      pushText(nodes, buffer);
      buffer = "";
      nodes.push({ type: "text", text: inner, marks: [{ type: "code" }] });
      index = close + 1;
      continue;
    }

    if (char === "[") {
      const closeBracket = text.indexOf("](", index + 1);
      if (closeBracket === -1) {
        buffer += char;
        index += 1;
        continue;
      }
      const closeParen = text.indexOf(")", closeBracket + 2);
      if (closeParen === -1) throw new NoteMarkdownError("unclosed link");
      const label = text.slice(index + 1, closeBracket);
      const href = text.slice(closeBracket + 2, closeParen);
      if (!isHttpMailtoHref(href)) throw new NoteMarkdownError("unsafe link href");
      if (label === "") throw new NoteMarkdownError("empty link label");
      pushText(nodes, buffer);
      buffer = "";
      nodes.push({
        type: "text",
        text: label,
        marks: [{ type: "link", attrs: { href: href.trim() } }],
      });
      index = closeParen + 1;
      continue;
    }

    if (text.startsWith("**", index)) {
      const close = findClosing("**");
      const inner = text.slice(index + 2, close);
      if (inner === "") throw new NoteMarkdownError("empty bold span");
      pushText(nodes, buffer);
      buffer = "";
      nodes.push(...withMark(parseInline(inner), "bold"));
      index = close + 2;
      continue;
    }

    if (char === "*") {
      const close = findClosing("*");
      const inner = text.slice(index + 1, close);
      if (inner === "") throw new NoteMarkdownError("empty italic span");
      pushText(nodes, buffer);
      buffer = "";
      nodes.push(...withMark(parseInline(inner), "italic"));
      index = close + 1;
      continue;
    }

    if (text.startsWith("~~", index)) {
      const close = findClosing("~~");
      const inner = text.slice(index + 2, close);
      if (inner === "") throw new NoteMarkdownError("empty strike span");
      pushText(nodes, buffer);
      buffer = "";
      nodes.push(...withMark(parseInline(inner), "strike"));
      index = close + 2;
      continue;
    }

    buffer += char;
    index += 1;
  }

  pushText(nodes, buffer);
  return nodes;
}

function withMark(
  nodes: NoteTextInlineNode[],
  markType: Exclude<NoteTextMark["type"], "link">,
): NoteTextInlineNode[] {
  return nodes.map((node) => {
    if (node.type !== "text") return node;
    return { ...node, marks: [...(node.marks ?? []), { type: markType }] };
  });
}

// ── Block-Parsing ──────────────────────────────────────────────────────────

function parseBlock(lines: string[]): NoteTextBlockNode {
  const first = lines[0];
  if (first === undefined) throw new NoteMarkdownError("empty block");

  if (/^#{4,}/u.test(first)) throw new NoteMarkdownError("heading level out of range");
  const heading = /^(#{1,3})\s+(.+)$/u.exec(first);
  if (heading && lines.length === 1) {
    const level = heading[1].length as 1 | 2 | 3;
    return { type: "heading", attrs: { level }, content: parseInline(heading[2]) };
  }

  const bulletItem = /^[-*]\s+(.+)$/u;
  const orderedItem = /^(\d+)\.\s+(.+)$/u;
  if (lines.every((line) => bulletItem.test(line))) {
    return {
      type: "bulletList",
      content: lines.map((line) => {
        const match = bulletItem.exec(line);
        return { type: "listItem", content: [{ type: "paragraph", content: parseInline(match![1]) }] };
      }),
    };
  }
  if (lines.every((line) => orderedItem.test(line))) {
    const starts = lines.map((line) => Number(orderedItem.exec(line)![1]));
    const start = starts[0] ?? 1;
    if (!starts.every((value, index) => value === start + index)) {
      throw new NoteMarkdownError("ordered list numbers must be consecutive");
    }
    return {
      type: "orderedList",
      ...(start !== 1 ? { attrs: { start } } : {}),
      content: lines.map((line) => {
        const match = orderedItem.exec(line);
        return { type: "listItem", content: [{ type: "paragraph", content: parseInline(match![2]) }] };
      }),
    };
  }

  return { type: "paragraph", content: parseInline(lines.join(" ")) };
}

export function markdownToNoteRichText(markdown: string): NoteTextRichTextDoc {
  const blocks = splitMarkdownBlocks(markdown);
  return { type: "doc", content: blocks.map(parseBlock) };
}

function splitMarkdownBlocks(markdown: string): string[][] {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

// ── Plain-Text-Ableitung ───────────────────────────────────────────────────

export function markdownToPlainText(markdown: string): string {
  // Re-Derivation aus dem validierten Markdown: Blöcke wieder ausparsen und die
  // Inline-Markierung entfernen. Für Listen wird das Markierungssymbol entfernt.
  const doc = markdownToNoteRichText(markdown);
  const parts: string[] = [];
  for (const block of doc.content) {
    if (block.type === "paragraph" || block.type === "heading") {
      const text = block.content
        .map((node) => (node.type === "text" ? node.text : ""))
        .join("");
      if (text !== "") parts.push(text);
    } else {
      for (const item of block.content) {
        const text = item.content
          .map((paragraph) => paragraph.content.map((node) => (node.type === "text" ? node.text : "")).join(""))
          .join(" ");
        if (text !== "") parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

// ── Serverseitige Validierung ──────────────────────────────────────────────

export type NoteMarkdownValidation =
  | { ok: true; plain: string }
  | { ok: false; reason: "too_long" | "html" | "invalid_markdown" | "empty" };

export function validateNoteMarkdown(markdown: string): NoteMarkdownValidation {
  if (markdown.length === 0) return { ok: false, reason: "empty" };
  if (markdown.length > NOTE_TEXT_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (HTML_PATTERN.test(markdown)) return { ok: false, reason: "html" };

  let doc: NoteTextRichTextDoc;
  try {
    doc = markdownToNoteRichText(markdown);
  } catch {
    return { ok: false, reason: "invalid_markdown" };
  }

  const metrics = richTextMetrics(doc);
  if (metrics.nodes > NOTE_TEXT_MAX_NODES || metrics.depth > NOTE_TEXT_MAX_DEPTH) {
    return { ok: false, reason: "invalid_markdown" };
  }
  if (noteRichTextToMarkdown(doc) !== markdown) {
    // Nicht-kanonisches Markdown (z. B. "**a *b* c**"-Verschachtelung) wird
    // nicht akzeptiert, damit die gespeicherte Form deterministisch roundtrippt.
    return { ok: false, reason: "invalid_markdown" };
  }

  const plain = markdownToPlainText(markdown);
  if (plain === "") return { ok: false, reason: "empty" };
  return { ok: true, plain };
}

function richTextMetrics(doc: NoteTextRichTextDoc): { nodes: number; depth: number } {
  let nodes = 1;
  let depth = 1;
  const visit = (node: unknown, currentDepth: number): void => {
    nodes += 1;
    depth = Math.max(depth, currentDepth);
    if (typeof node !== "object" || node === null) return;
    const record = node as { content?: unknown[] };
    for (const child of record.content ?? []) visit(child, currentDepth + 1);
  };
  for (const child of doc.content) visit(child, 2);
  return { nodes, depth };
}
