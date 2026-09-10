import { describe, expect, it } from "vitest";

import {
  fillClosureTrendMonths,
  monthLabel,
} from "@/lib/integrations/dashboard/closure-trend-v1";

describe("DASH-07 Abschlusstrend-Helfer", () => {
  it("fuellt Luecken auf und sortiert aeltester zuerst", () => {
    const months = fillClosureTrendMonths(
      { "2026-09": { won: 2, lost: 1 } },
      "2026-09",
      3,
    );
    expect(months.map((item) => item.month)).toEqual([
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    expect(months[0]).toMatchObject({ won: 0, lost: 0, total: 0 });
    expect(months[2]).toMatchObject({ won: 2, lost: 1, total: 3 });
  });

  it("wechselt das Jahr korrekt und labelt deutsch", () => {
    const months = fillClosureTrendMonths({}, "2026-01", 2);
    expect(months.map((item) => item.month)).toEqual(["2025-12", "2026-01"]);
    expect(monthLabel("2025-12")).toBe("Dez 2025");
    expect(monthLabel("2026-09")).toBe("Sep 2026");
  });

  it("klaempft negative/gebrochene Zaehler auf 0", () => {
    const months = fillClosureTrendMonths(
      { "2026-09": { won: -3, lost: 1.9 } },
      "2026-09",
      1,
    );
    expect(months[0]).toMatchObject({ won: 0, lost: 1, total: 1 });
  });
});
