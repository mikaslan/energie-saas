// F1-09 RED: @-Mention-Extraktor (DB-frei).
import { describe, expect, it } from "vitest";

import {
  extractNoteMentionRefs,
  NOTE_MENTION_MAX_COUNT,
  NoteMentionLimitError,
} from "@/lib/integrations/notes/note-mentions";

describe("extractNoteMentionRefs", () => {
  it("findet einzelne und mehrere Refs in Erscheinungsreihenfolge", () => {
    expect(
      extractNoteMentionRefs("Hallo @anna@beispiel.de und @bob@beispiel.de!"),
    ).toEqual([{ emailLower: "anna@beispiel.de" }, { emailLower: "bob@beispiel.de" }]);
  });

  it("entdupliziert case-insensitiv", () => {
    expect(
      extractNoteMentionRefs("@Anna@Beispiel.de trifft @anna@beispiel.de"),
    ).toEqual([{ emailLower: "anna@beispiel.de" }]);
  });

  it("ignoriert Refs in Code-Spans", () => {
    expect(
      extractNoteMentionRefs("`@code@beispiel.de` und `@a@b.de`"),
    ).toEqual([]);
  });

  it("ignoriert Link-Ziele, zählt Link-Text", () => {
    expect(
      extractNoteMentionRefs("[@text@beispiel.de](https://x.test/@weg@beispiel.de)"),
    ).toEqual([{ emailLower: "text@beispiel.de" }]);
  });

  it("ignoriert nackte URLs und E-Mail-ähnliche Pfade", () => {
    expect(
      extractNoteMentionRefs("siehe https://portal.test/a@b.de/info"),
    ).toEqual([]);
  });

  it("wirft über dem Limit (kein stilles Abschneiden)", () => {
    const many = Array.from(
      { length: NOTE_MENTION_MAX_COUNT + 1 },
      (_, i) => `@u${i}@beispiel.de`,
    ).join(" ");
    expect(() => extractNoteMentionRefs(many)).toThrow(NoteMentionLimitError);
  });

  it("leerer Text ohne Refs", () => {
    expect(extractNoteMentionRefs("ohne Refs, nur @ kein Treffer")).toEqual([]);
  });
});
