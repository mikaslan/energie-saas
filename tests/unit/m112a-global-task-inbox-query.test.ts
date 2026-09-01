import { describe, expect, it } from "vitest";
import {
  globalTaskInboxHref,
  parseGlobalTaskInboxRouteQuery,
} from "@/app/w/[workspaceId]/aufgaben/query";

const AS_OF = "2026-09-01T08:15:00.000Z";
const CURSOR = "eyJ2IjoxfQ";

describe("M1-12a Inbox-Routenquery — Längengrenze nach NFKC", () => {
  // Das Suchfeld begrenzt vor der Normalisierung, der Vertrag prüft danach.
  // Eine vom Formular akzeptierte Eingabe darf die Seite nie auf 404 schicken.
  it("kürzt eine erst durch NFKC zu lange Eingabe, statt sie abzulehnen", () => {
    for (const [zeichen, anzahl] of [["™", 51], ["…", 34], ["Ⅷ", 34]] as const) {
      const raw = zeichen.repeat(anzahl);
      expect(raw.length).toBeLessThanOrEqual(100);
      expect(raw.normalize("NFKC").length).toBeGreaterThan(100);
      const parsed = parseGlobalTaskInboxRouteQuery({ query: raw });
      expect(parsed, `"${zeichen}" × ${anzahl} darf die Route nicht sprengen`)
        .not.toBeNull();
      expect(parsed?.query).not.toBeNull();
      expect((parsed?.query ?? "").length).toBeLessThanOrEqual(100);
      expect(parsed?.query).toBe(parsed?.query?.normalize("NFKC"));
    }
  });

  it("lässt eine bereits kanonische Eingabe unverändert", () => {
    const raw = "a".repeat(100);
    expect(parseGlobalTaskInboxRouteQuery({ query: raw })?.query).toBe(raw);
  });

  it("zerschneidet kein Surrogatpaar", () => {
    const parsed = parseGlobalTaskInboxRouteQuery({ query: "😀".repeat(80) });
    const value = parsed?.query ?? "";
    expect(value.length).toBeLessThanOrEqual(100);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
      .test(value)).toBe(false);
  });
});

describe("M1-12a Inbox-Routenquery", () => {
  it("setzt ausschließlich bei fehlenden Feldern die geschlossenen Defaults", () => {
    expect(parseGlobalTaskInboxRouteQuery({})).toEqual({
      schemaVersion: "global-task-inbox-query.v1",
      filter: "mine",
      state: "open",
      dueBucket: "any",
      query: null,
      timeZone: "Europe/Berlin",
      asOf: null,
      cursor: null,
    });
  });

  it("normalisiert die Suche und akzeptiert eine vollständige Folgeseite", () => {
    expect(parseGlobalTaskInboxRouteQuery({
      filter: "assigned_by_me",
      state: "done",
      dueBucket: "today",
      query: "  O\u0308lwechsel  ",
      asOf: AS_OF,
      cursor: CURSOR,
    })).toEqual({
      schemaVersion: "global-task-inbox-query.v1",
      filter: "assigned_by_me",
      state: "done",
      dueBucket: "today",
      query: "Ölwechsel",
      timeZone: "Europe/Berlin",
      asOf: AS_OF,
      cursor: CURSOR,
    });
  });

  it.each([
    { filter: ["mine"] },
    { state: ["open", "done"] },
    { dueBucket: ["any"] },
    { query: ["eins"] },
    { asOf: [AS_OF] },
    { cursor: [CURSOR] },
    { unbekannt: "wert" },
    { filter: "external" },
    { state: "all" },
    { dueBucket: "tomorrow" },
    { query: "privat\n@example.test" },
    { query: "x".repeat(101) },
    { asOf: AS_OF },
    { cursor: CURSOR },
  ])("lehnt Mehrfach-, Fremd- und ungültige Parameter kontrolliert ab: %o", (raw) => {
    expect(parseGlobalTaskInboxRouteQuery(raw)).toBeNull();
  });

  it("baut kanonische Erst- und Folgeseitenlinks ohne Cursordrift", () => {
    const first = {
      filter: "all" as const,
      state: "open" as const,
      dueBucket: "upcoming" as const,
      query: "Dach & Speicher",
      asOf: null,
      cursor: null,
    };
    expect(globalTaskInboxHref("workspace-id", first)).toBe(
      "/w/workspace-id/aufgaben?filter=all&state=open&dueBucket=upcoming&query=Dach+%26+Speicher",
    );
    expect(globalTaskInboxHref("workspace-id", {
      ...first,
      asOf: AS_OF,
      cursor: CURSOR,
    })).toBe(
      `/w/workspace-id/aufgaben?filter=all&state=open&dueBucket=upcoming&query=Dach+%26+Speicher&asOf=${encodeURIComponent(AS_OF)}&cursor=${CURSOR}`,
    );
    expect(() => globalTaskInboxHref("workspace-id", {
      ...first,
      asOf: AS_OF,
    })).toThrow(TypeError);
  });
});
