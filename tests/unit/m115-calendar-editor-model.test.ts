import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_TYPE_COLORS,
  APPOINTMENT_TYPE_LABELS,
  APPOINTMENT_TYPE_OPTIONS,
  fromDateInput,
  fromDateTimeInput,
  toBerlinDateValue,
  toBerlinDateTimeValue,
} from "@/app/w/[workspaceId]/anfragen/[projectId]/appointment-editor-model";

describe("M1-15 Termin-Editor-Modell", () => {
  it("deckt alle sechs Typen mit Label und Farbe ab (nie Farbsignal-only)", () => {
    const types = APPOINTMENT_TYPE_OPTIONS.map(({ value }) => value);
    expect(types).toEqual([
      "on_site",
      "phone",
      "installation",
      "maintenance",
      "consultation",
      "other",
    ]);
    for (const type of types) {
      expect(APPOINTMENT_TYPE_LABELS[type].length).toBeGreaterThan(0);
      expect(APPOINTMENT_TYPE_COLORS[type]).toMatch(/^#[0-9a-f]{6}$/u);
    }
  });

  it("normalisiert Eingaben zu Berliner Wanduhrzeit", () => {
    expect(fromDateTimeInput("2026-07-01T10:00")).toBe("2026-07-01T10:00:00");
    expect(fromDateTimeInput("2026-07-01T10:00:00")).toBe("2026-07-01T10:00:00");
    expect(fromDateInput("2026-07-01")).toBe("2026-07-01T00:00:00");
  });

  it("kürzt Wanduhrzeit für Formularfelder", () => {
    expect(toBerlinDateTimeValue("2026-07-01T10:00:00.000")).toBe("2026-07-01T10:00");
    expect(toBerlinDateValue("2026-07-01T10:00:00.000")).toBe("2026-07-01");
  });
});
