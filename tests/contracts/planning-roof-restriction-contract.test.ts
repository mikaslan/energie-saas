import { describe, expect, it } from "vitest";

import {
  PLANNING_ROOF_RESTRICTION_VERSION,
  planningRoofRestrictionCreateV1Schema,
  planningRoofRestrictionRectV1Schema,
  rectInsidePolygon,
} from "@/lib/integrations/planning/contracts/roof-restriction";

/**
 * F3-03b Sperrzonen — Contract-RED.
 * Vertrag: docs/spec/F3-03b-sperrzonen.md
 * Modul fehlt → Import-RED.
 */

const RECTANGLE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 6 },
  { x: 0, y: 6 },
];

describe("F3-03b Sperrzonen-Contract", () => {
  it("F303b-CON-01: Version pinnt, gültige Anlage parst", () => {
    expect(PLANNING_ROOF_RESTRICTION_VERSION).toBe("planning-roof-restriction.v1");
    const parsed = planningRoofRestrictionCreateV1Schema.safeParse({
      schemaVersion: PLANNING_ROOF_RESTRICTION_VERSION,
      kind: "chimney",
      label: "Schornstein Nord",
      rect: { x: 1, y: 1, width: 2, height: 1 },
      heightM: 1.2,
    });
    expect(parsed.success).toBe(true);
  });

  it("F303b-CON-02: Rect-/Kind-Rejects (fail-closed)", () => {
    const good = { x: 1, y: 1, width: 2, height: 1 };
    const badRects = [
      { ...good, width: 0 },
      { ...good, height: -1 },
      { ...good, x: Number.NaN },
      { ...good, extra: 1 },
    ];
    for (const rect of badRects) {
      expect(
        planningRoofRestrictionRectV1Schema.safeParse(rect).success,
        JSON.stringify(rect),
      ).toBe(false);
    }
    const base = {
      schemaVersion: PLANNING_ROOF_RESTRICTION_VERSION,
      kind: "chimney",
      label: "S",
      rect: good,
    };
    for (const candidate of [
      { ...base, kind: "dormer" },
      { ...base, heightM: -1 },
      { ...base, heightM: 51 },
      { ...base, label: "" },
    ]) {
      expect(
        planningRoofRestrictionCreateV1Schema.safeParse(candidate).success,
        JSON.stringify(candidate),
      ).toBe(false);
    }
  });

  it("F303b-CON-03: Rechteck-in-Polygon (Ecken-Test, Kante = drin)", () => {
    expect(rectInsidePolygon({ x: 1, y: 1, width: 2, height: 1 }, RECTANGLE)).toBe(true);
    expect(rectInsidePolygon({ x: 9, y: 5, width: 2, height: 2 }, RECTANGLE)).toBe(false);
    expect(rectInsidePolygon({ x: 0, y: 0, width: 10, height: 6 }, RECTANGLE)).toBe(true);
    expect(rectInsidePolygon({ x: 2, y: 2, width: 1, height: 1 }, [])).toBe(false);
  });
});
