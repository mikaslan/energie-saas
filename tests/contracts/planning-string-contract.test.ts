import { describe, expect, it } from "vitest";

import {
  PLANNING_STRING_VERSION,
  planningInverterCreateV1Schema,
  planningStringCreateV1Schema,
  stringAdvisories,
} from "@/lib/integrations/planning/contracts/string-plan";

/**
 * F3-05a Stringplanung — Contract-RED.
 * Vertrag: docs/spec/F3-05a-strings.md
 * Modul fehlt → Import-RED.
 */

const GROUP_A = "11111111-1111-4111-8111-111111111111";
const GROUP_B = "22222222-2222-4222-8222-222222222222";
const INVERTER_ID = "33333333-3333-4333-8333-333333333333";

function goodInverter(): Record<string, unknown> {
  return {
    schemaVersion: PLANNING_STRING_VERSION,
    label: "WR 1",
    mppTrackers: 2,
    maxStringModules: 24,
  };
}

function goodString(): Record<string, unknown> {
  return {
    schemaVersion: PLANNING_STRING_VERSION,
    inverterId: INVERTER_ID,
    trackerSlot: 1,
    label: "String 1",
    members: [{ groupId: GROUP_A }, { groupId: GROUP_B }],
  };
}

function membersOf(n: number): Array<{ groupId: string }> {
  return Array.from({ length: n }, () => ({ groupId: GROUP_A }));
}

describe("F3-05a Stringplan-Contract", () => {
  it("F305a-CON-01: Version pinnt, gültige Anlage parst", () => {
    expect(PLANNING_STRING_VERSION).toBe("planning-string.v1");
    expect(planningInverterCreateV1Schema.safeParse(goodInverter()).success).toBe(true);
    // maxStringModules weglassbar (NULL = keine Advisory-Grenze): parst ohne Feld.
    const { maxStringModules: _dropped, ...withoutMax } = goodInverter();
    void _dropped;
    expect(planningInverterCreateV1Schema.safeParse(withoutMax).success).toBe(true);
    expect(planningStringCreateV1Schema.safeParse(goodString()).success).toBe(true);
  });

  it("F305a-CON-02: Range-Rejects (fail-closed)", () => {
    const inverter = goodInverter();
    const inverterBad = [
      { ...inverter, mppTrackers: 0 },
      { ...inverter, mppTrackers: 13 },
      { ...inverter, mppTrackers: 2.5 },
      { ...inverter, mppTrackers: Number.NaN },
      { ...inverter, maxStringModules: 0 },
      { ...inverter, maxStringModules: -1 },
      { ...inverter, maxStringModules: 2.5 },
      { ...inverter, maxStringModules: Number.NaN },
      { ...inverter, label: "" },
      { ...inverter, extra: 1 },
    ];
    for (const candidate of inverterBad) {
      expect(
        planningInverterCreateV1Schema.safeParse(candidate).success,
        JSON.stringify(candidate),
      ).toBe(false);
    }

    const str = goodString();
    const stringBad = [
      { ...str, trackerSlot: 0 },
      { ...str, trackerSlot: -1 },
      { ...str, trackerSlot: 1.5 },
      { ...str, trackerSlot: Number.NaN },
      { ...str, inverterId: "kein-uuid" },
      { ...str, label: "" },
      { ...str, members: [] },
      { ...str, members: membersOf(201) },
      { ...str, members: [{ groupId: "kein-uuid" }] },
      { ...str, members: [{ groupId: GROUP_A, extra: 1 }] },
      { ...str, members: "x" },
      { ...str, extra: 1 },
    ];
    for (const candidate of stringBad) {
      expect(
        planningStringCreateV1Schema.safeParse(candidate).success,
        JSON.stringify(candidate),
      ).toBe(false);
    }
  });

  it("F305a-CON-03: Advisory ableiten (Mix/Überlänge/sauber)", () => {
    // H/V-Mix → orientation-mix.
    const mixed = stringAdvisories({
      groups: [
        { id: GROUP_A, kind: "h", moduleCount: 4 },
        { id: GROUP_B, kind: "v", moduleCount: 4 },
      ],
      maxStringModules: 24,
    });
    expect(mixed.map((a) => a.code)).toContain("orientation-mix");
    for (const advisory of mixed) {
      expect(advisory.message.length).toBeGreaterThan(0);
    }

    // Summe Module > max → over-length.
    const overlong = stringAdvisories({
      groups: [
        { id: GROUP_A, kind: "h", moduleCount: 10 },
        { id: GROUP_B, kind: "h", moduleCount: 10 },
      ],
      maxStringModules: 12,
    });
    expect(overlong.map((a) => a.code)).toContain("over-length");

    // Sauber → leer.
    expect(
      stringAdvisories({
        groups: [
          { id: GROUP_A, kind: "h", moduleCount: 4 },
          { id: GROUP_B, kind: "h", moduleCount: 4 },
        ],
        maxStringModules: 24,
      }),
    ).toEqual([]);
  });
});
