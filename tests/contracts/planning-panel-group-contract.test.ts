import { describe, expect, it } from "vitest";

import {
  PLANNING_PANEL_GROUP_VERSION,
  groupRect,
  planningPanelGroupCreateV1Schema,
} from "@/lib/integrations/planning/contracts/panel-group";

/**
 * F3-04a Panel-Gruppen — Contract-RED.
 * Vertrag: docs/spec/F3-04a-panelgruppen.md
 * Modul fehlt → Import-RED.
 */

const RECTANGLE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 6 },
  { x: 0, y: 6 },
];

function goodCreate(): Record<string, unknown> {
  return {
    schemaVersion: PLANNING_PANEL_GROUP_VERSION,
    kind: "h",
    label: "Süd A",
    origin: { x: 1, y: 1 },
    rows: 4,
    cols: 6,
    moduleWM: 1.1,
    moduleHM: 1.75,
    gapM: 0.02,
    tiltDeg: 30,
  };
}

describe("F3-04a Panelgruppen-Contract", () => {
  it("F304a-CON-01: Version pinnt, gültige Anlage parst", () => {
    expect(PLANNING_PANEL_GROUP_VERSION).toBe("planning-panel-group.v1");
    const parsed = planningPanelGroupCreateV1Schema.safeParse(goodCreate());
    expect(parsed.success).toBe(true);
  });

  it("F304a-CON-02: Range-Rejects (fail-closed)", () => {
    const base = goodCreate();
    const bad = [
      { ...base, kind: "diagonal" },
      { ...base, rows: 0 },
      { ...base, cols: 201 },
      { ...base, rows: 2.5 },
      { ...base, moduleWM: 0.05 },
      { ...base, moduleHM: 6 },
      { ...base, moduleWM: Number.NaN },
      { ...base, gapM: -0.1 },
      { ...base, gapM: 3 },
      { ...base, tiltDeg: -1 },
      { ...base, tiltDeg: 91 },
      { ...base, tiltDeg: Number.POSITIVE_INFINITY },
      { ...base, label: "" },
      { ...base, origin: { x: 1, y: 1, extra: 1 } },
      { ...base, extra: 1 },
    ];
    for (const candidate of bad) {
      expect(
        planningPanelGroupCreateV1Schema.safeParse(candidate).success,
        JSON.stringify(candidate),
      ).toBe(false);
    }
    // tiltDeg weglassbar (NULL = Dachneigung spaeter): parst ohne Feld.
    const { tiltDeg: _dropped, ...withoutTilt } = base;
    void _dropped;
    expect(planningPanelGroupCreateV1Schema.safeParse(withoutTilt).success).toBe(true);
  });

  it("F304a-CON-03: Gruppen-Rechteck ableiten (innen/draussen)", () => {
    const rect = groupRect({
      origin: { x: 1, y: 1 },
      rows: 2,
      cols: 3,
      moduleWM: 1,
      moduleHM: 2,
      gapM: 0.5,
    });
    // Breite: 3*1 + 2*0.5 = 4; Höhe: 2*2 + 1*0.5 = 4.5.
    expect(rect).toEqual({ x: 1, y: 1, width: 4, height: 4.5 });
    expect(rect.x).toBeGreaterThanOrEqual(0);
    void RECTANGLE;
  });
});
