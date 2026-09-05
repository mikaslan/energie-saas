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

export type NoteMentionMatch = {
  index: number;
  length: number;
  emailLower: string;
};

type ExcludedRange = { start: number; end: number };

function excludedRanges(markdown: string): ExcludedRange[] {
  // Ungerade Backtick-Segmente sind Code (kein @ gilt dort);
  // `](...)`-Ziele enthalten oft @ (mailto:/URLs) — nur Link-Text zählt.
  const ranges: ExcludedRange[] = [];
  const parts = markdown.split("`");
  let cursor = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (i % 2 === 1) ranges.push({ start: cursor, end: cursor + part.length });
    cursor += part.length + 1;
  }
  for (const match of markdown.matchAll(/\]\([^()\s]*\)/gu)) {
    const at = match.index ?? 0;
    ranges.push({ start: at + 1, end: at + match[0].length });
  }
  return ranges;
}

function inExcluded(ranges: ExcludedRange[], index: number, length: number): boolean {
  return ranges.some((range) => index < range.end && index + length > range.start);
}

export function findNoteMentionMatches(markdown: string): NoteMentionMatch[] {
  const ranges = excludedRanges(markdown);
  const matches: NoteMentionMatch[] = [];
  for (const match of markdown.matchAll(MENTION_PATTERN)) {
    const email = match[2] ?? "";
    const at = (match.index ?? 0) + (match[1]?.length ?? 0);
    if (email.length === 0 || email.length > NOTE_MENTION_MAX_EMAIL_LENGTH) continue;
    if (inExcluded(ranges, at, match[0].length - (match[1]?.length ?? 0))) continue;
    matches.push({ index: at, length: email.length + 1, emailLower: email.toLowerCase() });
  }
  return matches;
}

export function extractNoteMentionRefs(markdown: string): NoteMentionRef[] {
  const seen = new Set<string>();
  const refs: NoteMentionRef[] = [];
  for (const match of findNoteMentionMatches(markdown)) {
    if (seen.has(match.emailLower)) continue;
    seen.add(match.emailLower);
    refs.push({ emailLower: match.emailLower });
  }
  if (refs.length > NOTE_MENTION_MAX_COUNT) {
    throw new NoteMentionLimitError(refs.length);
  }
  return refs;
}

export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; emailLower: string };

// Render-Pfad (nie werfend): teilt Text an bekannten Refs; Unbekanntes
// und Ausgeschlossenes bleibt Text. Limit gilt hier nicht (Anzeige).
export function splitTextByKnownMentions(
  text: string,
  known: ReadonlySet<string>,
): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of findNoteMentionMatches(text)) {
    if (!known.has(match.emailLower)) continue;
    if (match.index < cursor) continue;
    if (match.index > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, match.index) });
    }
    segments.push({ type: "mention", emailLower: match.emailLower });
    cursor = match.index + match.length;
  }
  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
  if (segments.length === 0) segments.push({ type: "text", text });
  return segments;
}
