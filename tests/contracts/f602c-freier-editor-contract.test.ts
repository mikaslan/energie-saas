import { describe, expect, it } from "vitest";

import type { LoadSchematicOverlayResult } from "@/app/w/[workspaceId]/angebote/[offerId]/schematic-overlay-actions";
import {
  assignOverlayIds,
  EDITOR_OVERLAY_CANVAS,
  EDITOR_OVERLAY_MAX_ELEMENTS,
  EDITOR_OVERLAY_VERSION,
} from "@/lib/integrations/schematic/editor-overlay-v1";

// F6-02c-A/CONTRACT: Pins des freien Editors (SPEC
// docs/spec/F6-02c-freier-editor.md). Gruen ab Contract-Skelett —
// Laufzeit-Pins hier, Verhaltens-RED in tests/unit/f602c-id-assign.test.ts
// und tests/e2e/f602a-overlay.spec.ts (F602C-Block).

// Compilezeit-Pin: Der Loader liefert das parallele ID-Array (bricht tsc,
// wenn elementIds aus dem Ergebnis-Typ entfernt wird).
type ElementIdsPin = LoadSchematicOverlayResult["elementIds"] extends (string | null)[]
  ? true
  : never;
const ELEMENT_IDS_PIN: ElementIdsPin = true;

describe("F6-02c-A Vertrag: Editor-Pins", () => {
  it("exportiert assignOverlayIds als Funktion", () => {
    expect(typeof assignOverlayIds).toBe("function");
    expect(assignOverlayIds.length).toBe(2);
  });

  it("haelt Version, Elementobergrenze und Raster stabil", () => {
    expect(EDITOR_OVERLAY_VERSION).toBe("editor-overlay.v1");
    expect(EDITOR_OVERLAY_MAX_ELEMENTS).toBe(32);
    expect(EDITOR_OVERLAY_CANVAS).toEqual({ width: 640, height: 300 });
  });

  it("pinnt das parallele elementIds-Array im Loader-Ergebnis", () => {
    expect(ELEMENT_IDS_PIN).toBe(true);
  });
});
