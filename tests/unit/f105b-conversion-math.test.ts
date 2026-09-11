import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { applyConversionRatios } from "@/modules/boards/service";

describe("F1-05b Gewichtungsmathematik (rein)", () => {
  it("gewichtet je Spalte, rundet kaufmännisch, summiert", () => {
    const result = applyConversionRatios([
      { id: "a", totalNetCents: 10_000, conversionRatioBps: 5_000 },
      { id: "b", totalNetCents: 101, conversionRatioBps: 5_000 },
      { id: "c", totalNetCents: 7_500, conversionRatioBps: 0 },
      { id: "d", totalNetCents: 99_999, conversionRatioBps: null },
    ]);
    expect(result.columns.map((column) => column.weightedNetCents)).toEqual([
      5_000, 51, 0, null,
    ]);
    expect(result.weightedTotalNetCents).toBe(5_051);
  });

  it("ohne Ratio kein Total (null statt 0)", () => {
    const empty = applyConversionRatios([]);
    expect(empty.weightedTotalNetCents).toBeNull();
    const none = applyConversionRatios([
      { id: "a", totalNetCents: 10_000, conversionRatioBps: null },
    ]);
    expect(none.columns[0]?.weightedNetCents).toBeNull();
    expect(none.weightedTotalNetCents).toBeNull();
  });
});
