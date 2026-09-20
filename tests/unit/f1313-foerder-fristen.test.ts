import { describe, expect, it } from "vitest";

import {
  addBusinessDaysBerlin,
  SUBSIDY_CASE_BND_DUE_WORKDAYS,
  SUBSIDY_CASE_BZA_DUE_WORKDAYS,
} from "@/lib/subsidy-case";
import { bundHolidaysBerlin } from "@/lib/subsidy-holidays";

// F13-13 AT-Fristen (Owner-Härtung, rein, kein DB-Boot): Feiertagsquelle
// Bund (Computus + 9 Bundestage, ESTIMATE) und AT-Kanten der
// Fälligkeitsrechnung (Spec §2). Ostersonntage sind belegte
// Kalenderdaten (2024-03-31, 2025-04-20, 2026-04-05).
describe("F13-13 Feiertage + AT-Rechnung (Bund)", () => {
  it("F1313-U-05: Bund-Feiertage enthalten die beweglichen Ostertage korrekt", () => {
    expect(bundHolidaysBerlin(2024)).toContain("2024-03-29"); // Karfreitag
    expect(bundHolidaysBerlin(2024)).toContain("2024-04-01"); // Ostermontag
    expect(bundHolidaysBerlin(2025)).toContain("2025-04-18");
    expect(bundHolidaysBerlin(2025)).toContain("2025-04-21");
    expect(bundHolidaysBerlin(2026)).toContain("2026-04-03");
    expect(bundHolidaysBerlin(2026)).toContain("2026-04-06");
    expect(bundHolidaysBerlin(2026)).toContain("2026-05-14"); // Himmelfahrt
    expect(bundHolidaysBerlin(2026)).toContain("2026-05-25"); // Pfingstmontag
    // 9 Bundestage, keine Landes-Feiertage (z. B. kein 2026-03-08 Berlin).
    expect(bundHolidaysBerlin(2026)).toHaveLength(9);
    expect(bundHolidaysBerlin(2026)).not.toContain("2026-03-08");
  });

  it("F1313-U-06: AT-Rechnung (Mo–Fr, Starttag = Tag 0, Feiertage raus)", () => {
    expect(SUBSIDY_CASE_BZA_DUE_WORKDAYS).toBe(3);
    expect(SUBSIDY_CASE_BND_DUE_WORKDAYS).toBe(5);
    // Mo +3 AT = Do (kein Feiertag im Weg).
    expect(addBusinessDaysBerlin("2026-01-05", 3, bundHolidaysBerlin(2026))).toBe("2026-01-08");
    // Fr +1 AT = Mo (Wochenende übersprungen).
    expect(addBusinessDaysBerlin("2026-01-09", 1, bundHolidaysBerlin(2026))).toBe("2026-01-12");
    // Do vor Karfreitag +1 = Di (Fr Feiertag, Sa/So WE, Mo Ostermontag).
    expect(addBusinessDaysBerlin("2026-04-02", 1, bundHolidaysBerlin(2026))).toBe("2026-04-07");
    // 0 Tage = Starttag selbst.
    expect(addBusinessDaysBerlin("2026-01-05", 0, bundHolidaysBerlin(2026))).toBe("2026-01-05");
  });

  it("F1313-U-07: Fehlform fail-closed (kein stilles Raten)", () => {
    expect(() => addBusinessDaysBerlin("2026-02-30", 1)).toThrow();
    expect(() => addBusinessDaysBerlin("kein-datum", 1)).toThrow();
    expect(() => addBusinessDaysBerlin("2026-01-05", 1.5)).toThrow();
    expect(() => bundHolidaysBerlin(1500)).toThrow();
  });
});
