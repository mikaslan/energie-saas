import { describe, expect, it } from "vitest";

import {
  buildCreateHref,
  composeEndWall,
  isValidEndDate,
  normalizeSpan,
  resolveEndDate,
} from "@/app/w/[workspaceId]/plantafel/drag-span";

const BASE = "/w/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/plantafel";
const WEEK = "2026-06-08";
const MEMBER = "11111111-1111-4111-8111-111111111111";

describe("F7-05c normalizeSpan", () => {
  it("U-01: vertauschtes Paar wird geordnet (frühestes zuerst)", () => {
    expect(normalizeSpan("2026-06-11", "2026-06-09")).toEqual(["2026-06-09", "2026-06-11"]);
    expect(normalizeSpan("2026-06-09", "2026-06-11")).toEqual(["2026-06-09", "2026-06-11"]);
  });

  it("U-02: gleiche Tage bleiben Eintag-Spanne", () => {
    expect(normalizeSpan("2026-06-09", "2026-06-09")).toEqual(["2026-06-09", "2026-06-09"]);
  });
});

describe("F7-05c buildCreateHref", () => {
  it("U-03: Eintag ohne end-Param (exakte heutige URL-Form)", () => {
    expect(buildCreateHref(BASE, WEEK, MEMBER, "2026-06-09", "2026-06-09")).toBe(
      `${BASE}?week=${WEEK}&create=2026-06-09&member=${MEMBER}`,
    );
  });

  it("U-04: Mehrtag mit &end=", () => {
    expect(buildCreateHref(BASE, WEEK, MEMBER, "2026-06-09", "2026-06-11")).toBe(
      `${BASE}?week=${WEEK}&create=2026-06-09&member=${MEMBER}&end=2026-06-11`,
    );
  });
});

describe("F7-05c composeEndWall", () => {
  it("U-05: end wird aus endDate komponiert", () => {
    expect(composeEndWall("2026-06-11", "11:00")).toBe("2026-06-11T11:00:00");
    expect(composeEndWall("2026-06-09", "15:30")).toBe("2026-06-09T15:30:00");
  });
});

describe("F7-05c Guards", () => {
  it("U-06: end vor start ist ungültig", () => {
    expect(isValidEndDate("2026-06-09", "2026-06-08")).toBe(false);
    expect(isValidEndDate("2026-06-09", "2026-06-09")).toBe(true);
  });

  it("U-07: Spanne über 7 Tage ist ungültig, Gate fällt auf start zurück", () => {
    expect(isValidEndDate("2026-06-08", "2026-06-14")).toBe(true);
    expect(isValidEndDate("2026-06-08", "2026-06-15")).toBe(false);
    expect(resolveEndDate("2026-06-08", "2026-06-15")).toBe("2026-06-08");
    expect(resolveEndDate("2026-06-09", "2026-06-08")).toBe("2026-06-09");
    expect(resolveEndDate("2026-06-09", null)).toBe("2026-06-09");
    expect(resolveEndDate("2026-06-09", "kein-datum")).toBe("2026-06-09");
    expect(resolveEndDate("2026-06-09", "2026-06-11")).toBe("2026-06-11");
  });
});
