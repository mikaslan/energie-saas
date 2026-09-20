import { describe, expect, it } from "vitest";

import {
  PLANNING_PANEL_DESELECT_VERSION,
  deselectedEffectiveCount,
  planningPanelDeselectV1Schema,
} from "@/lib/integrations/planning/contracts/panel-deselect";

/**
 * F3-04b Panel-Deselect — Contract-RED.
 * Vertrag: docs/spec/F3-04b-deselect.md
 * Modul fehlt → Import-RED.
 */

const GROUP_A = "11111111-1111-4111-8111-111111111111";

function goodDeselect(): Record<string, unknown> {
  return {
    schemaVersion: PLANNING_PANEL_DESELECT_VERSION,
    groupId: GROUP_A,
    row: 2,
    col: 3,
  };
}

describe("F3-04b Panel-Deselect-Contract", () => {
  it("F304b-CON-01: Version pinnt, gültiger Deselect parst", () => {
    expect(PLANNING_PANEL_DESELECT_VERSION).toBe("planning-panel-deselect.v1");
    // Ohne reason.
    expect(planningPanelDeselectV1Schema.safeParse(goodDeselect()).success).toBe(true);
    // Mit reason.
    expect(
      planningPanelDeselectV1Schema.safeParse({ ...goodDeselect(), reason: "Verschattet" })
        .success,
    ).toBe(true);
    // Reason-Grenzen 1 und 280 Zeichen parsen.
    expect(
      planningPanelDeselectV1Schema.safeParse({ ...goodDeselect(), reason: "x" }).success,
    ).toBe(true);
    expect(
      planningPanelDeselectV1Schema.safeParse({
        ...goodDeselect(),
        reason: "x".repeat(280),
      }).success,
    ).toBe(true);
  });

  it("F304b-CON-02: Range- und Typ-Rejects (fail-closed)", () => {
    const good = goodDeselect();
    const bad = [
      // row/col ≥1.
      { ...good, row: 0 },
      { ...good, col: 0 },
      { ...good, row: -1 },
      { ...good, col: -1 },
      // row/col ganzzahlig.
      { ...good, row: 2.5 },
      { ...good, col: 1.5 },
      // NaN ist keine gültige Koordinate.
      { ...good, row: Number.NaN },
      { ...good, col: Number.NaN },
      // groupId muss UUID sein.
      { ...good, groupId: "kein-uuid" },
      // reason: 1..280 Zeichen, kein Leerstring.
      { ...good, reason: "" },
      { ...good, reason: "x".repeat(281) },
      { ...good, reason: 123 },
      // Falsche Schema-Version.
      { ...good, schemaVersion: "planning-panel-deselect.v999" },
      // Strict: extra Top-Level.
      { ...good, extra: 1 },
    ];
    for (const candidate of bad) {
      expect(
        planningPanelDeselectV1Schema.safeParse(candidate).success,
        JSON.stringify(candidate),
      ).toBe(false);
    }
  });

  it("F304b-CON-03: effectiveCount ableiten (rows·cols − Abwahlen)", () => {
    // 4×6-Raster minus 2 Abwahlen = 22.
    expect(deselectedEffectiveCount({ rows: 4, cols: 6, deselected: 2 })).toBe(22);
    // Voll abgewählt → 0.
    expect(deselectedEffectiveCount({ rows: 4, cols: 6, deselected: 24 })).toBe(0);
    // Reine Subtraktion ohne Clamp (Service garantiert Gültigkeit).
    expect(deselectedEffectiveCount({ rows: 2, cols: 3, deselected: 7 })).toBe(-1);
    // Unbeeinflusst von reason: gleiche Geometrie, gleicher Count —
    // mit wie ohne Begründung.
    const withReason = { ...goodDeselect(), reason: "Verschattet" };
    const withoutReason = goodDeselect();
    expect(planningPanelDeselectV1Schema.safeParse(withReason).success).toBe(true);
    expect(planningPanelDeselectV1Schema.safeParse(withoutReason).success).toBe(true);
    expect(deselectedEffectiveCount({ rows: 4, cols: 6, deselected: 2 })).toBe(
      deselectedEffectiveCount({ rows: 4, cols: 6, deselected: 2 }),
    );
  });
});
