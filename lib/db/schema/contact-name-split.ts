// M1-14 · Geteilte Namens-Normalisierung (Vertragsteil, ADR 0020 Entsch. 7).
//
// Diese Funktion ist die kanonische, unit-getestete Implementierung der
// Split-Regeln (Spec §4 / §15 R1-04 / R1-07). Die Migration 0042 hält eine
// byte-identische SQL-Variante `public.contact_name_split_v1(text)` für den
// Backfill; M114-CONTRACT-07 pinnt das TS-Verhalten, und der DB-Test
// M114-DB-01 verifiziert, dass die SQL-Variante für repräsentative Eingaben
// dasselbe Ergebnis liefert.
//
// Regeln:
//   1. btrim (NUR U+0020 Leerzeichen, wie PostgreSQL btrim(text)) + interne
//      Whitespace-Läufe der Menge {Leerzeichen, Tab, CR, LF} auf genau ein
//      Leerzeichen kollabieren.
//   2. Am ersten Whitespace-Lauf teilen.
//   3. Zwei+ Tokens → first = Teil vor dem Lauf, last = btrim(Teil danach).
//   4. Ein Token → first = token, last = token.
//
// Divergenz-Pin (P2-3): JS `String.trim()` entfernt ALLE Unicode-Whitespace,
// PostgreSQL `btrim(text)` nur U+0020. Deshalb wird hier bewusst NICHT
// `String.trim()` verwendet, sondern exakt btrim nachgebildet. Zeichen
// außerhalb der Menge {Leerzeichen, Tab, CR, LF} (z. B. NBSP) sind in beiden
// Implementierungen LITERALE Zeichen — sie werden weder getrimmt noch
// kollabiert. Ein Legacy-Wert mit führendem Tab/Zeilenumbruch erzeugt daher
// ein leeres first-Token und scheitert am DB-CHECK `1..200` — laut und
// fail-safe statt stiller Re-Derivation.

export const CONTACT_NAME_SPLIT_VERSION = "contact-name-split.v1" as const;

export type ContactNameSplitV1 = {
  firstName: string;
  lastName: string;
};

// btrim(text) in PostgreSQL trimmt ausschließlich U+0020 Leerzeichen.
const BTRIM_SPACE = /^ +| +$/gu;
const INTERNAL_WHITESPACE_RUN = /[ \t\r\n]+/gu;

export function contactNameSplitV1(raw: string): ContactNameSplitV1 {
  const collapsed = raw.replace(BTRIM_SPACE, "").replace(INTERNAL_WHITESPACE_RUN, " ");
  const firstSpace = collapsed.indexOf(" ");
  if (firstSpace === -1) {
    return { firstName: collapsed, lastName: collapsed };
  }
  return {
    firstName: collapsed.slice(0, firstSpace),
    lastName: collapsed.slice(firstSpace + 1).replace(BTRIM_SPACE, ""),
  };
}
