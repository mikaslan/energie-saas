import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  PLANNING_PANEL_COLLISION_VERSION,
  groupRestrictionCollisions,
  planningPanelCollisionCheckV1Schema,
} from "@/lib/integrations/planning/contracts/panel-collision";

/**
 * F3-04c Panel-Collision — Contract-RED.
 * Vertrag: docs/spec/F3-04c-collision.md
 * Modul fehlt → Import-RED.
 */

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const ZONE_A = "22222222-2222-4222-8222-222222222222";
const ZONE_B = "33333333-3333-4333-8333-333333333333";
const ZONE_C = "44444444-4444-4444-8444-444444444444";

type CheckInput = Parameters<typeof groupRestrictionCollisions>[0];

function goodCheck(): CheckInput {
  return {
    group: {
      id: GROUP_ID,
      rect: { x: 0, y: 0, width: 10, height: 10 },
    },
    restrictions: [
      {
        id: ZONE_A,
        kind: "chimney",
        label: "Schornstein",
        rect: { x: 5, y: 5, width: 10, height: 10 },
      },
    ],
  };
}

describe("F3-04c Panel-Collision-Contract", () => {
  it("F304c-CON-01: Version pinnt, eine Zone schneidet → ein Eintrag mit Fläche", () => {
    expect(PLANNING_PANEL_COLLISION_VERSION).toBe("planning-panel-collision.v1");
    expect(planningPanelCollisionCheckV1Schema.safeParse(goodCheck()).success).toBe(true);
    // Schnitt x:[5,10] × y:[5,10] → 5×5 = 25.
    expect(groupRestrictionCollisions(goodCheck())).toEqual([
      {
        restrictionId: ZONE_A,
        kind: "chimney",
        label: "Schornstein",
        overlapArea: 25,
      },
    ]);
  });

  it("F304c-CON-02: kein Schnitt (disjunkt, leer, Kante) → []", () => {
    const group = goodCheck().group;
    const zone = (
      id: string,
      rect: { x: number; y: number; width: number; height: number },
    ): CheckInput["restrictions"][number] => ({
      id,
      kind: "chimney",
      label: "Schornstein",
      rect,
    });
    // Disjunkt (Zone weit weg) → [].
    expect(
      groupRestrictionCollisions({
        group,
        restrictions: [zone(ZONE_A, { x: 50, y: 50, width: 5, height: 5 })],
      }),
    ).toEqual([]);
    // Leere Restrictions → [].
    expect(groupRestrictionCollisions({ group, restrictions: [] })).toEqual([]);
    // Kante rechts anliegend (x=10) → kein Schnitt → [].
    expect(
      groupRestrictionCollisions({
        group,
        restrictions: [zone(ZONE_A, { x: 10, y: 0, width: 5, height: 5 })],
      }),
    ).toEqual([]);
    // Kante oben anliegend (y=10) → kein Schnitt → [].
    expect(
      groupRestrictionCollisions({
        group,
        restrictions: [zone(ZONE_A, { x: 0, y: 10, width: 5, height: 5 })],
      }),
    ).toEqual([]);
    // Nur Eckenberührung (10,10) → kein Schnitt → [].
    expect(
      groupRestrictionCollisions({
        group,
        restrictions: [zone(ZONE_A, { x: 10, y: 10, width: 5, height: 5 })],
      }),
    ).toEqual([]);
  });

  it("F304c-CON-03: mehrere Zonen (2 Treffer + 1 daneben)", () => {
    const group = goodCheck().group;
    const hits = groupRestrictionCollisions({
      group,
      restrictions: [
        // Schnitt x:[5,10] × y:[5,10] → 25.
        {
          id: ZONE_A,
          kind: "chimney",
          label: "Schornstein",
          rect: { x: 5, y: 5, width: 10, height: 10 },
        },
        // Schnitt x:[0,2] × y:[0,3] → 6.
        {
          id: ZONE_B,
          kind: "window",
          label: "Dachfenster",
          rect: { x: -4, y: -2, width: 6, height: 5 },
        },
        // Daneben → kein Eintrag.
        {
          id: ZONE_C,
          kind: "chimney",
          label: "Abgas",
          rect: { x: 50, y: 50, width: 5, height: 5 },
        },
      ],
    });
    expect(hits).toEqual([
      {
        restrictionId: ZONE_A,
        kind: "chimney",
        label: "Schornstein",
        overlapArea: 25,
      },
      {
        restrictionId: ZONE_B,
        kind: "window",
        label: "Dachfenster",
        overlapArea: 6,
      },
    ]);
  });

  it("F304c-CON-04: Strict-Rejects (Rect-Maße, NaN, extra Felder)", () => {
    const good = goodCheck();
    const rect = (
      overrides: Partial<{ x: number; y: number; width: number; height: number }>,
    ) => ({ x: 0, y: 0, width: 10, height: 10, ...overrides });
    const bad: unknown[] = [
      // width/height > 0 (Gruppe).
      { ...good, group: { ...good.group, rect: rect({ width: 0 }) } },
      { ...good, group: { ...good.group, rect: rect({ width: -2 }) } },
      { ...good, group: { ...good.group, rect: rect({ height: 0 }) } },
      { ...good, group: { ...good.group, rect: rect({ height: -1 }) } },
      // width/height > 0 (Restriction).
      {
        ...good,
        restrictions: [{ ...good.restrictions[0], rect: rect({ width: 0 }) }],
      },
      {
        ...good,
        restrictions: [{ ...good.restrictions[0], rect: rect({ height: -3 }) }],
      },
      // NaN ist kein gültiges Maß.
      { ...good, group: { ...good.group, rect: rect({ x: Number.NaN }) } },
      { ...good, group: { ...good.group, rect: rect({ width: Number.NaN }) } },
      {
        ...good,
        restrictions: [{ ...good.restrictions[0], rect: rect({ y: Number.NaN }) }],
      },
      // Nicht-finit ist kein gültiges Maß.
      { ...good, group: { ...good.group, rect: rect({ x: Number.POSITIVE_INFINITY }) } },
      {
        ...good,
        restrictions: [
          { ...good.restrictions[0], rect: rect({ width: Number.POSITIVE_INFINITY }) },
        ],
      },
      // Strict: extra Top-Level.
      { ...good, extra: 1 },
      // Strict: extra in Gruppe / Rect / Restriction.
      { ...good, group: { ...good.group, extra: 1 } },
      { ...good, group: { ...good.group, rect: { ...good.group.rect, extra: 1 } } },
      {
        ...good,
        restrictions: [{ ...good.restrictions[0], extra: 1 }],
      },
      {
        ...good,
        restrictions: [
          { ...good.restrictions[0], rect: { ...good.restrictions[0].rect, extra: 1 } },
        ],
      },
    ];
    for (const candidate of bad) {
      expect(
        planningPanelCollisionCheckV1Schema.safeParse(candidate).success,
        JSON.stringify(candidate),
      ).toBe(false);
    }
    // Ungültige Rects werfen ZodError aus der Funktion.
    for (const candidate of bad) {
      expect(() =>
        groupRestrictionCollisions(candidate as CheckInput),
      ).toThrow(ZodError);
    }
    // kind ist ein beliebiger String → ok.
    expect(
      planningPanelCollisionCheckV1Schema.safeParse({
        ...good,
        restrictions: [{ ...good.restrictions[0], kind: "sonder-zone-xyz" }],
      }).success,
    ).toBe(true);
  });
});
