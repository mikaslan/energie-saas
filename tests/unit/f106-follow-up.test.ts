import { describe, expect, it } from "vitest";

import {
  berlinDateToIso,
  FOLLOW_UP_ESCALATION_DAYS,
  followUpBandForDate,
  parseFollowUpAt,
} from "@/lib/follow-up";

// Fixer Referenzzeitpunkt (Berlin, Normalzeit): 2026-01-15 12:00+01:00.
const NOW = new Date("2026-01-15T12:00:00+01:00");

const at = (iso: string): Date => new Date(iso);

describe("F1-06 Wiedervorlage-Bänder (Unit)", () => {
  it("F106-U-01: heute und morgen sind fällig", () => {
    expect(followUpBandForDate(at("2026-01-15T08:00:00+01:00"), NOW)).toBe("due");
    expect(followUpBandForDate(at("2026-01-15T23:59:00+01:00"), NOW)).toBe("due");
    expect(followUpBandForDate(at("2026-01-16T09:00:00+01:00"), NOW)).toBe("due");
  });

  it("F106-U-02: übermorgen ist anstehend", () => {
    expect(followUpBandForDate(at("2026-01-17T00:00:00+01:00"), NOW)).toBe("scheduled");
    expect(followUpBandForDate(at("2026-03-01T12:00:00+01:00"), NOW)).toBe("scheduled");
  });

  it("F106-U-03: gestern bis 7 Tage zurück ist überfällig", () => {
    expect(followUpBandForDate(at("2026-01-14T12:00:00+01:00"), NOW)).toBe("overdue");
    expect(followUpBandForDate(at("2026-01-08T12:00:00+01:00"), NOW)).toBe("overdue");
  });

  it("F106-U-04: mehr als 7 Tage zurück ist eskaliert (ESTIMATE)", () => {
    expect(FOLLOW_UP_ESCALATION_DAYS).toBe(7);
    expect(followUpBandForDate(at("2026-01-07T12:00:00+01:00"), NOW)).toBe("escalated");
    expect(followUpBandForDate(at("2025-12-01T12:00:00+01:00"), NOW)).toBe("escalated");
  });

  it("F106-U-05: Zeitzonen-Grenze zählt in Berlin-Tagen", () => {
    // 00:30 Berlin = neuer Tag, obwohl UTC noch Vortag ist.
    expect(followUpBandForDate(at("2026-01-16T00:30:00+01:00"), NOW)).toBe("due");
    expect(followUpBandForDate(at("2026-01-14T23:30:00+01:00"), NOW)).toBe("overdue");
  });

  it("F106-U-06: Parser fail-closed bei Müll, null bleibt null", () => {
    expect(parseFollowUpAt(null)).toBeNull();
    expect(parseFollowUpAt(undefined)).toBeNull();
    expect(parseFollowUpAt("kein-datum")).toBeNull();
    expect(parseFollowUpAt("2026-01-20T10:00:00+01:00")).toEqual(
      new Date("2026-01-20T10:00:00+01:00"),
    );
  });

  it("F106-U-07: Kalenderdatum wird 09:00 Berlin (Winter +01:00, Sommer +02:00)", () => {
    expect(berlinDateToIso("2026-01-20")).toBe("2026-01-20T08:00:00.000Z");
    expect(berlinDateToIso("2026-07-20")).toBe("2026-07-20T07:00:00.000Z");
    expect(berlinDateToIso("kein-datum")).toBeNull();
    expect(berlinDateToIso("2026-02-30")).toBeNull();
    expect(berlinDateToIso("2019-01-01")).toBeNull();
  });
});
