import { describe, expect, it } from "vitest";

import {
  EDITOR_OVERLAY_CANVAS,
  EDITOR_OVERLAY_MAX_ELEMENTS,
  EDITOR_OVERLAY_VERSION,
  OverlayValidationError,
} from "@/lib/integrations/schematic/editor-overlay-v1";

// F6-02a/CONTRACT: Versions- und Grenz-Pins des Editor-Overlays.
// Gruen ab Contract-Skelett (kein Verhalten, nur Konstantenvertrag).

describe("F6-02a Vertrag: Overlay-Pins", () => {
  it("pinnt Version, Elementobergrenze und Raster", () => {
    expect(EDITOR_OVERLAY_VERSION).toBe("editor-overlay.v1");
    expect(EDITOR_OVERLAY_MAX_ELEMENTS).toBe(32);
    expect(EDITOR_OVERLAY_CANVAS).toEqual({ width: 640, height: 300 });
  });

  it("exportiert den Validierungsfehler stabil", () => {
    expect(new OverlayValidationError(["/elements/0"]).name).toBe(
      "OverlayValidationError",
    );
    expect(new OverlayValidationError(["/elements/0"]).paths).toEqual([
      "/elements/0",
    ]);
  });
});
