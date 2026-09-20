import { describe, expect, it } from "vitest";

import {
  PLANNING_STRING_EQUIPMENT_VERSION,
  planningStringEquipmentAttachV1Schema,
  stringEquipmentAdvisories,
} from "@/lib/integrations/planning/contracts/string-equipment";

/**
 * F3-05b String-Equipment — Contract-RED.
 * Vertrag: docs/spec/F3-05b-equipment.md
 * Modul fehlt → Import-RED.
 */

const STRING_ID = "33333333-3333-4333-8333-333333333333";
const GROUP_A = "11111111-1111-4111-8111-111111111111";

function goodOptimizer(): Record<string, unknown> {
  return {
    schemaVersion: PLANNING_STRING_EQUIPMENT_VERSION,
    stringId: STRING_ID,
    scope: "string",
    equipment: "optimizer",
  };
}

function goodMicro(): Record<string, unknown> {
  return {
    schemaVersion: PLANNING_STRING_EQUIPMENT_VERSION,
    stringId: STRING_ID,
    scope: "panel",
    panelRef: { groupId: GROUP_A, row: 1, col: 2 },
    equipment: "micro_inverter",
  };
}

describe("F3-05b String-Equipment-Contract", () => {
  it("F305b-CON-01: Version pinnt, gültige Anlage parst", () => {
    expect(PLANNING_STRING_EQUIPMENT_VERSION).toBe("planning-string-equipment.v1");
    expect(planningStringEquipmentAttachV1Schema.safeParse(goodOptimizer()).success).toBe(true);
    expect(planningStringEquipmentAttachV1Schema.safeParse(goodMicro()).success).toBe(true);
    // Optimierer je Panel ist zulässig (Mikro nur Panel, nicht umgekehrt).
    expect(
      planningStringEquipmentAttachV1Schema.safeParse({
        ...goodMicro(),
        equipment: "optimizer",
      }).success,
    ).toBe(true);
  });

  it("F305b-CON-02: Range- und Kreuzregel-Rejects (fail-closed)", () => {
    const optimizer = goodOptimizer();
    const micro = goodMicro();
    const microPanel = micro.panelRef as Record<string, unknown>;
    const bad = [
      // Mengen: scope / equipment.
      { ...optimizer, scope: "module" },
      { ...optimizer, equipment: "string_inverter" },
      // Kreuz: scope=string → kein panelRef.
      { ...optimizer, panelRef: { groupId: GROUP_A, row: 1, col: 1 } },
      // Kreuz: scope=panel → panelRef Pflicht.
      { ...micro, panelRef: undefined },
      // Kreuz: Mikro nur scope=panel.
      { ...optimizer, equipment: "micro_inverter" },
      // Panel-Ref-Ranges.
      { ...micro, panelRef: { ...microPanel, row: 0 } },
      { ...micro, panelRef: { ...microPanel, col: -1 } },
      { ...micro, panelRef: { ...microPanel, row: 1.5 } },
      { ...micro, panelRef: { ...microPanel, row: Number.NaN } },
      { ...micro, panelRef: { ...microPanel, col: Number.NaN } },
      { ...micro, panelRef: { ...microPanel, groupId: "kein-uuid" } },
      { ...micro, panelRef: { ...microPanel, extra: 1 } },
      { ...micro, panelRef: "x" },
      // Ref-UUID.
      { ...optimizer, stringId: "kein-uuid" },
      // Kein Label-Feld im Attach-Schema.
      { ...optimizer, label: "WR 1" },
      // Strict: extra Top-Level.
      { ...optimizer, extra: 1 },
      { ...micro, extra: 1 },
    ];
    for (const candidate of bad) {
      expect(
        planningStringEquipmentAttachV1Schema.safeParse(candidate).success,
        JSON.stringify(candidate),
      ).toBe(false);
    }
  });

  it("F305b-CON-03: Advisory ableiten (teil/volle/keine)", () => {
    // Teilabdeckung → partial-coverage.
    const partial = stringEquipmentAdvisories({ microCount: 2, moduleCount: 4 });
    expect(partial.map((a) => a.code)).toContain("partial-coverage");
    for (const advisory of partial) {
      expect(advisory.message.length).toBeGreaterThan(0);
    }

    // Volle Abdeckung → leer.
    expect(stringEquipmentAdvisories({ microCount: 4, moduleCount: 4 })).toEqual([]);

    // Keine Mikros → leer.
    expect(stringEquipmentAdvisories({ microCount: 0, moduleCount: 4 })).toEqual([]);
  });
});
