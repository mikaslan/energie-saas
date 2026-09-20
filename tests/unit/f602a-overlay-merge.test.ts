import { describe, expect, it } from "vitest";

import {
  buildSingleLineSchematic,
  hashSchematicNetlist,
} from "@/lib/integrations/schematic/single-line-v1";
import {
  mergeEditorOverlay,
  OverlayValidationError,
  type OverlayElementInput,
} from "@/lib/integrations/schematic/editor-overlay-v1";

// F6-02a/SPEC-RED: Editor-Overlay merged deterministisch auf den
// F6-01-Backbone (Bibliothek: Erdungspunkt, Abzweigdose, Generik,
// Textbox, Konnektor). Alle Tests muessen RED sein, bis der Merge
// implementiert ist (GREEN erst nach F6-01-CI-gruen).

const BACKBONE = buildSingleLineSchematic([
  { category: "module", title: "PV-Module", quantityLabel: "12 Stück" },
  { category: "inverter", title: "Wechselrichter", quantityLabel: "1 Stück" },
]);

const BACKBONE_IDS = new Set(BACKBONE.nodes.map((node) => node.id));

describe("F6-02a Editor-Overlay: Merge", () => {
  it("merged ein leeres Overlay identisch (Hash = Backbone-Hash)", () => {
    const merged = mergeEditorOverlay(BACKBONE, []);
    expect(merged.nodes).toEqual(BACKBONE.nodes);
    expect(merged.edges).toEqual(BACKBONE.edges);
    expect(merged.unwired).toEqual(BACKBONE.unwired);
    expect(hashSchematicNetlist(merged)).toBe(hashSchematicNetlist(BACKBONE));
  });

  it("ist unabhaengig von der Elementreihenfolge", () => {
    const elements: OverlayElementInput[] = [
      { kind: "generic", x: 90, y: 200, label: "Unterverteilung" },
      { kind: "earthing_point", x: 410, y: 200 },
      { kind: "connector", from: "meter", to: "ovl-1", label: "PE" },
    ];
    const forward = mergeEditorOverlay(BACKBONE, elements);
    const reversed = mergeEditorOverlay(BACKBONE, [...elements].reverse());
    expect(reversed).toEqual(forward);
  });

  it("vergibt stabile ovl-IDs, disjunkt zu Backbone-IDs", () => {
    const merged = mergeEditorOverlay(BACKBONE, [
      { kind: "junction_box", x: 250, y: 200 },
      { kind: "textbox", x: 90, y: 250, text: "Zählerplatz RG" },
    ]);
    const overlayIds = merged.nodes
      .map((node) => node.id)
      .filter((id) => !BACKBONE_IDS.has(id));
    expect(overlayIds).toEqual(["ovl-1", "ovl-2"]);
    for (const id of overlayIds) {
      expect(BACKBONE_IDS.has(id)).toBe(false);
    }
  });

  it("haengt Konnektoren an Backbone- und Overlay-Knoten", () => {
    const merged = mergeEditorOverlay(BACKBONE, [
      { kind: "earthing_point", x: 410, y: 200 },
      { kind: "connector", from: "meter", to: "ovl-1", label: "PE" },
    ]);
    expect(merged.edges).toContainEqual({ from: "meter", to: "ovl-1", label: "PE" });
  });

  it("traegt Generik-Label und Textbox-Text ins Netz", () => {
    const merged = mergeEditorOverlay(BACKBONE, [
      { kind: "generic", x: 90, y: 200, label: "Unterverteilung" },
      { kind: "textbox", x: 90, y: 250, text: "Zählerplatz RG" },
    ]);
    const labels = merged.nodes.map((node) => node.label);
    expect(labels).toContain("Unterverteilung");
    expect(labels).toContain("Zählerplatz RG");
  });

  it("aendert den Hash bei Overlay-Inhalt (Drift erkennbar)", () => {
    const merged = mergeEditorOverlay(BACKBONE, [
      { kind: "earthing_point", x: 410, y: 200 },
    ]);
    expect(hashSchematicNetlist(merged)).not.toBe(hashSchematicNetlist(BACKBONE));
  });
});

describe("F6-02a Editor-Overlay: Validierung", () => {
  it("verwirft baumelnde Konnektoren fail-closed", () => {
    expect(() =>
      mergeEditorOverlay(BACKBONE, [
        { kind: "connector", from: "meter", to: "ovl-9", label: "PE" },
      ]),
    ).toThrowError(OverlayValidationError);
    expect(() =>
      mergeEditorOverlay(BACKBONE, [
        { kind: "connector", from: "erfunden", to: "meter", label: "PE" },
      ]),
    ).toThrowError(OverlayValidationError);
  });

  it("verwirft Out-of-bounds, Brueche und Ueberzahl", () => {
    const bad: OverlayElementInput[][] = [
      [{ kind: "generic", x: 641, y: 100, label: "a" }],
      [{ kind: "generic", x: 100, y: 301, label: "a" }],
      [{ kind: "generic", x: -1, y: 100, label: "a" }],
      [{ kind: "generic", x: 10.5, y: 100, label: "a" }],
      [null as unknown as OverlayElementInput],
      Array.from({ length: 33 }, (_, index) => ({
        kind: "earthing_point",
        x: index,
        y: 100,
      }) as OverlayElementInput),
    ];
    for (const elements of bad) {
      expect(() => mergeEditorOverlay(BACKBONE, elements)).toThrowError(
        OverlayValidationError,
      );
    }
  });
});
