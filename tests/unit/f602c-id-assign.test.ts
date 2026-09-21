import { describe, expect, it } from "vitest";

import {
  assignOverlayIds,
  OverlayValidationError,
  type OverlayElementInput,
} from "@/lib/integrations/schematic/editor-overlay-v1";

// F6-02c-A/SPEC-RED: deterministische Overlay-ID-Vergabe
// (docs/spec/F6-02c-freier-editor.md). Alle Verhaltens-Tests sind RED,
// bis assignOverlayIds implementiert ist (GREEN).

describe("F6-02c-A ID-Vergabe: Sortierung (Rang/NFC/x/y)", () => {
  it("vergibt ovl-IDs in Merge-Sortierung, nicht in Eingabereihenfolge", () => {
    const elements: OverlayElementInput[] = [
      { kind: "textbox", x: 90, y: 250, text: "Zählerplatz RG" },
      { kind: "earthing_point", x: 410, y: 200 },
      { kind: "junction_box", x: 250, y: 200 },
    ];
    // Rang: Erdung (0) < Dose (1) < Textbox (3).
    expect(assignOverlayIds(new Set(["meter"]), elements)).toEqual([
      { index: 0, id: "ovl-3" },
      { index: 1, id: "ovl-1" },
      { index: 2, id: "ovl-2" },
    ]);
  });

  it("sortiert gleiche Raenge per NFC-Label, dann x, dann y", () => {
    const elements: OverlayElementInput[] = [
      { kind: "generic", x: 300, y: 100, label: "Beta" },
      { kind: "generic", x: 100, y: 100, label: "Alpha" },
      { kind: "generic", x: 100, y: 50, label: "Alpha" },
    ];
    expect(assignOverlayIds(new Set(), elements)).toEqual([
      { index: 0, id: "ovl-3" },
      { index: 1, id: "ovl-2" },
      { index: 2, id: "ovl-1" },
    ]);
  });

  it("bricht NFC-Gleichheit per Raw-Tiebreak deterministisch", () => {
    const composed = "Ångström";
    const decomposed = "Ångström";
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize("NFC")).toBe(decomposed.normalize("NFC"));
    const elements: OverlayElementInput[] = [
      { kind: "generic", x: 100, y: 100, label: composed },
      { kind: "generic", x: 100, y: 100, label: decomposed },
    ];
    const first = assignOverlayIds(new Set(), elements);
    const second = assignOverlayIds(new Set(), elements);
    expect(first).toEqual(second);
    // Raw: "A…" (0x41) < "Å" (0xC5) → zerlegte Form zuerst.
    expect(first).toEqual([
      { index: 0, id: "ovl-2" },
      { index: 1, id: "ovl-1" },
    ]);
  });
});

describe("F6-02c-A ID-Vergabe: Tiebreak, Disjunktheit, Form", () => {
  it("bricht Duplikate per stabilem Index-Tiebreak", () => {
    const elements: OverlayElementInput[] = [
      { kind: "earthing_point", x: 410, y: 200 },
      { kind: "earthing_point", x: 410, y: 200 },
      { kind: "earthing_point", x: 410, y: 200 },
    ];
    expect(assignOverlayIds(new Set(), elements)).toEqual([
      { index: 0, id: "ovl-1" },
      { index: 1, id: "ovl-2" },
      { index: 2, id: "ovl-3" },
    ]);
  });

  it("bleibt disjunkt zu Backbone-IDs (ovl-Kollisionen ueberspringen)", () => {
    const elements: OverlayElementInput[] = [
      { kind: "junction_box", x: 250, y: 200 },
      { kind: "textbox", x: 90, y: 250, text: "Zählerplatz RG" },
    ];
    expect(assignOverlayIds(new Set(["meter", "ovl-1", "ovl-2"]), elements)).toEqual([
      { index: 0, id: "ovl-3" },
      { index: 1, id: "ovl-4" },
    ]);
  });

  it("akzeptiert Backbone-IDs auch als Array", () => {
    const elements: OverlayElementInput[] = [
      { kind: "earthing_point", x: 410, y: 200 },
    ];
    expect(assignOverlayIds(["ovl-1"], elements)).toEqual([{ index: 0, id: "ovl-2" }]);
  });

  it("liefert bei Leereingabe ein leeres Array", () => {
    expect(assignOverlayIds(new Set(["meter"]), [])).toEqual([]);
  });

  it("gibt nur ID-tragende Elemente in Eingabereihenfolge zurueck", () => {
    const elements: OverlayElementInput[] = [
      { kind: "connector", from: "meter", to: "ovl-1", label: "PE" },
      { kind: "textbox", x: 90, y: 250, text: "Zählerplatz RG" },
      { kind: "connector", from: "ovl-1", to: "meter", label: "N" },
      { kind: "earthing_point", x: 410, y: 200 },
    ];
    const assigned = assignOverlayIds(new Set(["meter"]), elements);
    expect(assigned.map((entry) => entry.index)).toEqual([1, 3]);
    expect(assigned).toEqual([
      { index: 1, id: "ovl-2" },
      { index: 3, id: "ovl-1" },
    ]);
  });

  it("verwirft ungueltige Elemente fail-closed", () => {
    expect(() =>
      assignOverlayIds(new Set(), [
        { kind: "generic", x: 641, y: 100, label: "a" },
      ]),
    ).toThrowError(OverlayValidationError);
    expect(() =>
      assignOverlayIds(new Set(), [null as unknown as OverlayElementInput]),
    ).toThrowError(OverlayValidationError);
  });
});
