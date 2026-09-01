import type { ReactNode } from "react";
import {
  taskRichTextV1Schema,
  type TaskRichTextBlockNode,
  type TaskRichTextV1,
} from "@/lib/integrations/tasks/contract";

type InlineNode = Extract<
  TaskRichTextBlockNode,
  { type: "paragraph" }
>["content"][number];
type ListItemNode = Extract<
  TaskRichTextBlockNode,
  { type: "bulletList" }
>["content"][number];

function unreachable(value: never): never {
  throw new Error(`Unbekannter Richtext-Knoten: ${JSON.stringify(value)}`);
}

function renderInline(node: InlineNode, key: string): ReactNode {
  if (node.type === "hardBreak") return <br key={key} />;
  if (node.type !== "text") return unreachable(node);

  const marks = new Set(node.marks?.map(({ type }) => type) ?? []);
  let content: ReactNode = node.text;
  if (marks.has("italic")) content = <em>{content}</em>;
  if (marks.has("bold")) content = <strong>{content}</strong>;
  return <span key={key}>{content}</span>;
}

function renderListItem(node: ListItemNode, key: string, headingOffset: 0 | 3): ReactNode {
  return (
    <li key={key} className="my-1 pl-1">
      {node.content.map((child, index) => renderBlock(child, `${key}-${index}`, headingOffset))}
    </li>
  );
}

function renderBlock(
  node: TaskRichTextBlockNode,
  key: string,
  headingOffset: 0 | 3,
): ReactNode {
  switch (node.type) {
    case "paragraph":
      return (
        <p key={key} className="my-2 break-words leading-6">
          {node.content.map((child, index) => renderInline(child, `${key}-${index}`))}
        </p>
      );
    case "heading": {
      const content = node.content.map((child, index) => (
        renderInline(child, `${key}-${index}`)
      ));
      if (headingOffset === 3) {
        return node.attrs.level === 2
          ? <h5 key={key} className="mb-2 mt-4 break-words text-base font-semibold">{content}</h5>
          : <h6 key={key} className="mb-2 mt-3 break-words text-sm font-semibold">{content}</h6>;
      }
      return node.attrs.level === 2
        ? <h2 key={key} className="mb-2 mt-4 break-words text-base font-semibold">{content}</h2>
        : <h3 key={key} className="mb-2 mt-3 break-words text-sm font-semibold">{content}</h3>;
    }
    case "bulletList":
      return (
        <ul key={key} className="my-2 list-disc space-y-1 pl-5">
          {node.content.map((child, index) => renderListItem(child, `${key}-${index}`, headingOffset))}
        </ul>
      );
    case "orderedList":
      return (
        <ol
          key={key}
          start={node.attrs?.start}
          className="my-2 list-decimal space-y-1 pl-5"
        >
          {node.content.map((child, index) => renderListItem(child, `${key}-${index}`, headingOffset))}
        </ol>
      );
    default:
      return unreachable(node);
  }
}

export function TaskRichTextRenderer({
  body,
  headingOffset = 0,
}: {
  body: TaskRichTextV1;
  headingOffset?: 0 | 3;
}) {
  const validated = taskRichTextV1Schema.parse(body);
  if (validated.doc.content.length === 0) return null;

  return (
    <div className="min-w-0 text-sm text-slate-700">
      {validated.doc.content.map((node, index) => (
        renderBlock(node, `block-${index}`, headingOffset)
      ))}
    </div>
  );
}
