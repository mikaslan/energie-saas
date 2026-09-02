import type { ReactNode } from "react";
import {
  markdownToNoteRichText,
  type NoteTextBlockNode,
  type NoteTextInlineNode,
  type NoteTextListItemNode,
} from "@/lib/integrations/notes/note-markdown";

function unreachable(value: never): never {
  throw new Error(`Unbekannter Notiz-Knoten: ${JSON.stringify(value)}`);
}

function renderInline(node: NoteTextInlineNode, key: string): ReactNode {
  const marks = new Set(node.marks?.map(({ type }) => type) ?? []);
  let content: ReactNode = node.text;
  if (marks.has("code")) content = <code>{content}</code>;
  if (marks.has("strike")) content = <s>{content}</s>;
  if (marks.has("bold")) content = <strong>{content}</strong>;
  if (marks.has("italic")) content = <em>{content}</em>;
  const link = node.marks?.find(({ type }) => type === "link");
  if (link?.type === "link") {
    const href = link.attrs.href;
    const external = /^https?:\/\//iu.test(href);
    content = (
      <a
        href={href}
        rel="noopener noreferrer"
        {...(external ? { target: "_blank" } : {})}
        className="underline decoration-slate-400 underline-offset-2 hover:text-blue-800"
      >
        {content}
      </a>
    );
  }
  return <span key={key}>{content}</span>;
}

function renderListItem(node: NoteTextListItemNode, key: string): ReactNode {
  return (
    <li key={key} className="my-1 pl-1">
      {node.content.map((child, index) => renderBlock(child, `${key}-${index}`))}
    </li>
  );
}

function renderBlock(node: NoteTextBlockNode, key: string): ReactNode {
  switch (node.type) {
    case "paragraph":
      return (
        <p key={key} className="my-2 break-words leading-6">
          {node.content.map((child, index) => renderInline(child, `${key}-${index}`))}
        </p>
      );
    case "heading": {
      const content = node.content.map((child, index) => renderInline(child, `${key}-${index}`));
      if (node.attrs.level === 1) {
        return <h4 key={key} className="mb-2 mt-4 break-words text-base font-semibold">{content}</h4>;
      }
      if (node.attrs.level === 2) {
        return <h5 key={key} className="mb-2 mt-3 break-words text-sm font-semibold">{content}</h5>;
      }
      return <h6 key={key} className="mb-2 mt-3 break-words text-sm font-semibold">{content}</h6>;
    }
    case "bulletList":
      return (
        <ul key={key} className="my-2 list-disc space-y-1 pl-5">
          {node.content.map((child, index) => renderListItem(child, `${key}-${index}`))}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} start={node.attrs?.start} className="my-2 list-decimal space-y-1 pl-5">
          {node.content.map((child, index) => renderListItem(child, `${key}-${index}`))}
        </ol>
      );
    default:
      return unreachable(node);
  }
}

export function NoteMarkdownRenderer({ textMarkdown }: { textMarkdown: string }) {
  const doc = markdownToNoteRichText(textMarkdown);
  if (doc.content.length === 0) return null;
  return (
    <div className="min-w-0 text-sm text-slate-700">
      {doc.content.map((node, index) => renderBlock(node, `note-block-${index}`))}
    </div>
  );
}
