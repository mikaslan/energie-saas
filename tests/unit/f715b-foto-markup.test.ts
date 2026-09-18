import { describe, expect, it } from "vitest";

import {
  PHOTO_MARKUP_ARROW_HEAD_ANGLE,
  PHOTO_MARKUP_ARROW_HEAD_LENGTH,
  PHOTO_MARKUP_EXPORT_MAX_EDGE,
  PHOTO_MARKUP_MAX_BYTES,
  PHOTO_MARKUP_TEXT_MAX,
  arrowHeadPoints,
  capMarkupText,
  clampPoint,
  fitSize,
  scaleLength,
  scalePoint,
} from "@/app/w/[workspaceId]/anfragen/[projectId]/checkliste/photo-markup";

/**
 * F7-15b Fotodoku-Markup — pure Math (DOM-frei, Sibling photo-markup.ts).
 * U-01 Display→Export-Skalierung, U-02 Pfeilspitzen-Geometrie,
 * U-03 Anker-Clamping, U-04 Text-Laengen-Cap.
 */

describe("F7-15b U-01: Display→Export-Skalierung", () => {
  it("skaliert Display-Punkte mit dem Export-Faktor (ganzzahlig gerundet)", () => {
    expect(scalePoint({ x: 10, y: 20 }, 2)).toEqual({ x: 20, y: 40 });
    expect(scalePoint({ x: 7, y: 9 }, 0.5)).toEqual({ x: 4, y: 5 });
    expect(scalePoint({ x: 0, y: 0 }, 3.2)).toEqual({ x: 0, y: 0 });
  });

  it("pinnt die Export-Kante 2048 (lange Kante gecappt, Aspekt erhalten)", () => {
    expect(PHOTO_MARKUP_EXPORT_MAX_EDGE).toBe(2048);
    expect(fitSize(4000, 3000, PHOTO_MARKUP_EXPORT_MAX_EDGE)).toEqual({ width: 2048, height: 1536 });
    expect(fitSize(1000, 3000, PHOTO_MARKUP_EXPORT_MAX_EDGE)).toEqual({ width: 683, height: 2048 });
    expect(fitSize(64, 64, PHOTO_MARKUP_EXPORT_MAX_EDGE)).toEqual({ width: 64, height: 64 });
  });

  it("skaliert Linien-/Schriftgroessen mit, mindestens 1px", () => {
    expect(scaleLength(3, 2)).toBe(6);
    expect(scaleLength(16, 0.25)).toBe(4);
    expect(scaleLength(1, 0.1)).toBe(1);
  });
});

describe("F7-15b U-02: Pfeilspitzen-Geometrie", () => {
  it("liefert genau 2 Fluegel deterministisch (Laenge + Winkel gepinnt)", () => {
    expect(PHOTO_MARKUP_ARROW_HEAD_LENGTH).toBe(12);
    expect(PHOTO_MARKUP_ARROW_HEAD_ANGLE).toBeCloseTo(Math.PI / 6, 12);
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 };
    const [first, second] = arrowHeadPoints(from, to);
    for (const wing of [first, second]) {
      expect(Math.hypot(wing.x - to.x, wing.y - to.y)).toBeCloseTo(12, 9);
    }
    // Symmetrie um die Pfeilachse, Fluegel hinter der Spitze.
    expect(first!.x).toBeCloseTo(second!.x, 9);
    expect(first!.y).toBeCloseTo(-second!.y, 9);
    expect(first!.x).toBeLessThan(to.x);
    expect(arrowHeadPoints(from, to)).toEqual([first, second]);
  });

  it("folgt der Pfeilrichtung (vertikaler Pfeil: Fluegel oberhalb der Spitze)", () => {
    const to = { x: 50, y: 80 };
    const [first, second] = arrowHeadPoints({ x: 50, y: 10 }, to);
    expect(first!.y).toBeCloseTo(second!.y, 9);
    expect(first!.y).toBeLessThan(to.y);
    expect(first!.x).toBeLessThan(to.x);
    expect(second!.x).toBeGreaterThan(to.x);
  });
});

describe("F7-15b U-03: Anker-Clamping", () => {
  it("laesst innere Anker unveraendert", () => {
    expect(clampPoint({ x: 10, y: 20 }, 64, 64)).toEqual({ x: 10, y: 20 });
    expect(clampPoint({ x: 0, y: 0 }, 64, 64)).toEqual({ x: 0, y: 0 });
  });

  it("cappt ausserhalb liegende Anker (nie negativ, nie Overflow)", () => {
    expect(clampPoint({ x: -5, y: 10 }, 64, 64)).toEqual({ x: 0, y: 10 });
    expect(clampPoint({ x: 10, y: -1 }, 64, 64)).toEqual({ x: 10, y: 0 });
    expect(clampPoint({ x: 200, y: 300 }, 64, 64)).toEqual({ x: 63, y: 63 });
    expect(clampPoint({ x: 64, y: 64 }, 64, 64)).toEqual({ x: 63, y: 63 });
  });

  it("bleibt bei entarteter Flaeche definiert", () => {
    expect(clampPoint({ x: 5, y: 5 }, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe("F7-15b U-04: Text-Laengen-Cap", () => {
  it("pinnt das Cap 140 (laengerer Text gekuerzt, Rest unveraendert)", () => {
    expect(PHOTO_MARKUP_TEXT_MAX).toBe(140);
    expect(capMarkupText("Riss hier")).toBe("Riss hier");
    expect(capMarkupText("a".repeat(140))).toBe("a".repeat(140));
    const capped = capMarkupText(`Text ${"b".repeat(200)}`);
    expect(capped).toHaveLength(140);
    expect(capped.startsWith("Text ")).toBe(true);
  });
});

describe("F7-15b: Client-Byte-Cap (Spiegel des Server-Caps)", () => {
  it("pinnt 10 MiB wie CHECKLIST_PHOTO_MAX_BYTES (Server prueft massgeblich)", () => {
    expect(PHOTO_MARKUP_MAX_BYTES).toBe(10_485_760);
  });
});
