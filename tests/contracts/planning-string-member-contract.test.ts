import { describe, expect, it } from "vitest";

import {
  PLANNING_STRING_MEMBER_VERSION,
  effectiveMemberCount,
  planningStringMemberAddV1Schema,
  rangesOverlap,
} from "@/lib/integrations/planning/contracts/string-member";

/**
 * F3-05c String-Member — Contract-RED.
 * Vertrag: docs/spec/F3-05c-members.md
 * Modul fehlt → Import-RED.
 */

const STRING_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_A = "22222222-2222-4222-8222-222222222222";
const GROUP_B = "33333333-3333-4333-8333-333333333333";

function goodAdd(): Record<string, unknown> {
  return {
    schemaVersion: PLANNING_STRING_MEMBER_VERSION,
    stringId: STRING_ID,
    groupId: GROUP_A,
    rowFrom: 1,
    rowTo: 2,
    colFrom: 1,
    colTo: 3,
  };
}

describe("F3-05c String-Member-Contract", () => {
  it("F305c-CON-01: Version pinnt, gültiger Add parst", () => {
    expect(PLANNING_STRING_MEMBER_VERSION).toBe("planning-string-member.v1");
    expect(planningStringMemberAddV1Schema.safeParse(goodAdd()).success).toBe(true);
    // from==to ist gültig (Einzel-Zeile/Spalte).
    expect(
      planningStringMemberAddV1Schema.safeParse({
        ...goodAdd(),
        rowFrom: 2,
        rowTo: 2,
        colFrom: 3,
        colTo: 3,
      }).success,
    ).toBe(true);
  });

  it("F305c-CON-02: Range- und Typ-Rejects (fail-closed)", () => {
    const good = goodAdd();
    const bad = [
      // ints ≥1.
      { ...good, rowFrom: 0 },
      { ...good, rowTo: 0 },
      { ...good, colFrom: 0 },
      { ...good, colTo: 0 },
      { ...good, rowFrom: -1 },
      { ...good, colTo: -1 },
      // ganzzahlig.
      { ...good, rowFrom: 2.5 },
      { ...good, rowTo: 1.5 },
      { ...good, colFrom: 2.5 },
      { ...good, colTo: 1.5 },
      // NaN ist keine gültige Koordinate.
      { ...good, rowFrom: Number.NaN },
      { ...good, rowTo: Number.NaN },
      { ...good, colFrom: Number.NaN },
      { ...good, colTo: Number.NaN },
      // from≤to je Achse.
      { ...good, rowFrom: 3, rowTo: 2 },
      { ...good, colFrom: 4, colTo: 3 },
      // UUIDs.
      { ...good, stringId: "kein-uuid" },
      { ...good, groupId: "kein-uuid" },
      // Falsche Schema-Version.
      { ...good, schemaVersion: "planning-string-member.v999" },
      // Strict: extra Top-Level.
      { ...good, extra: 1 },
    ];
    for (const candidate of bad) {
      expect(
        planningStringMemberAddV1Schema.safeParse(candidate).success,
        JSON.stringify(candidate),
      ).toBe(false);
    }
  });

  it("F305c-CON-03: rangesOverlap (Schnitt, disjunkt, fremde Gruppe, Kante)", () => {
    const base = { groupId: GROUP_A, rowFrom: 1, rowTo: 2, colFrom: 1, colTo: 3 };
    // Rechteck-Schnitt → true.
    expect(
      rangesOverlap(base, { groupId: GROUP_A, rowFrom: 2, rowTo: 4, colFrom: 2, colTo: 5 }),
    ).toBe(true);
    // Disjunkt (keine gemeinsame Zeile/Spalte) → false.
    expect(
      rangesOverlap(base, { groupId: GROUP_A, rowFrom: 5, rowTo: 6, colFrom: 5, colTo: 6 }),
    ).toBe(false);
    // Fremde Gruppe, gleiche Geometrie → false.
    expect(
      rangesOverlap(base, { groupId: GROUP_B, rowFrom: 1, rowTo: 2, colFrom: 1, colTo: 3 }),
    ).toBe(false);
    // Kanten berühren (Zeile 3 direkt nach Zeile 2) → kein Schnitt → false.
    expect(
      rangesOverlap(base, { groupId: GROUP_A, rowFrom: 3, rowTo: 4, colFrom: 1, colTo: 3 }),
    ).toBe(false);
    // Kanten berühren (Spalte 4 direkt nach Spalte 3) → kein Schnitt → false.
    expect(
      rangesOverlap(base, { groupId: GROUP_A, rowFrom: 1, rowTo: 2, colFrom: 4, colTo: 5 }),
    ).toBe(false);
  });

  it("F305c-CON-04: effectiveMemberCount (Zellen minus Deselects)", () => {
    // 2×3-Range = 6 Zellen minus 2 Deselects innerhalb = 4.
    expect(
      effectiveMemberCount({
        ranges: [{ groupId: GROUP_A, rowFrom: 1, rowTo: 2, colFrom: 1, colTo: 3 }],
        deselected: [
          { row: 1, col: 1 },
          { row: 2, col: 3 },
        ],
      }),
    ).toBe(4);
    // Deselect außerhalb der Range → 6.
    expect(
      effectiveMemberCount({
        ranges: [{ groupId: GROUP_A, rowFrom: 1, rowTo: 2, colFrom: 1, colTo: 3 }],
        deselected: [{ row: 9, col: 9 }],
      }),
    ).toBe(6);
  });
});
