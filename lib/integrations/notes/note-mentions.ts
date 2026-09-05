// F1-09: @-Mention-Extraktor für note-text.v1 (rein, DB-frei).
//
// Mentions sind Roh-Refs im Markdown (`@lizenzierte-e-mail`) und
// überleben den Editor-Roundtrip als Text. Auflösung gegen
// Membership passiert im Service (nicht hier).

export const NOTE_MENTION_MAX_COUNT = 20 as const;
export const NOTE_MENTION_MAX_EMAIL_LENGTH = 254 as const;

export type NoteMentionRef = {
  emailLower: string;
};

export class NoteMentionLimitError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(`Zu viele @-Mentions (${count}, max. ${NOTE_MENTION_MAX_COUNT}).`);
    this.name = "NoteMentionLimitError";
    this.count = count;
  }
}

const LOCAL_PART = "[A-Za-z0-9._%+-]{1,64}";
const DOMAIN_PART = "[A-Za-z0-9.-]{1,253}\\.[A-Za-z]{2,}";
const MENTION_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_@./-])@(${LOCAL_PART}@${DOMAIN_PART})`,
  "gu",
);

function stripCodeSpans(markdown: string): string {
  // Ungerade Segmente liegen in Backticks (inline/fenced) — dort gilt
  // kein @ als Mention (Muster note-markdown: code ist Inline-Mark).
  return markdown
    .split("`")
    .filter((_, index) => index % 2 === 0)
    .join(" ");
}

function stripLinkDestinations(markdown: string): string {
  // Link-Ziele `](url)` enthalten oft @ (mailto:/URLs) — nur der
  // Link-Text darf Mentions tragen. Einfache Klammer-Heuristik
  // (keine Schachtelung in Zielen erwartet).
  return markdown.replace(/\]\([^()\s]*\)/gu, "]()");
}

export function extractNoteMentionRefs(markdown: string): NoteMentionRef[] {
  const visible = stripLinkDestinations(stripCodeSpans(markdown));
  const seen = new Set<string>();
  const refs: NoteMentionRef[] = [];
  for (const match of visible.matchAll(MENTION_PATTERN)) {
    const email = match[2] ?? "";
    if (email.length === 0 || email.length > NOTE_MENTION_MAX_EMAIL_LENGTH) continue;
    const emailLower = email.toLowerCase();
    if (seen.has(emailLower)) continue;
    seen.add(emailLower);
    refs.push({ emailLower });
  }
  if (refs.length > NOTE_MENTION_MAX_COUNT) {
    throw new NoteMentionLimitError(refs.length);
  }
  return refs;
}
