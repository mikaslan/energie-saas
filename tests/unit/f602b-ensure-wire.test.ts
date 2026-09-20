import { describe, expect, it } from "vitest";

import { buildSingleLineSchematic } from "@/lib/integrations/schematic/single-line-v1";
import {
  ENSURE_WIRE_VERSION,
  firstOpenPayload,
  formatQuantity,
  projectSchematicSections,
  resolvePageEnsureMode,
} from "@/lib/integrations/schematic/ensure-wire-v1";

// F6-02b/SPEC-RED: Ensure-Verdrahtung (Page-Loader-Trigger + Backbone-
// Persistenz). Alle Verhaltens-Tests muessen RED sein, bis die
// Verdrahtung implementiert ist (GREEN erst nach F6-02a-CI-gruen).

const BACKBONE = buildSingleLineSchematic([
  { category: "module", title: "PV-Module", quantityLabel: "12 Stück" },
  { category: "inverter", title: "Wechselrichter", quantityLabel: "1 Stück" },
]);

describe("F6-02b Vertrag: Ensure-Wire-Pins", () => {
  it("pinnt die Wire-Version", () => {
    expect(ENSURE_WIRE_VERSION).toBe("ensure-wire.v1");
  });
});

describe("F6-02b First-Open-Nutzlast: Backbone-only", () => {
  it("verpackt den Backbone (nie das gemergte Netz)", () => {
    const payload = firstOpenPayload({
      workspaceId: "ws",
      offerId: "offer",
      variantId: "variant",
      revision: 1,
      backbone: BACKBONE,
    });
    expect(payload.schematic).toEqual(BACKBONE);
    expect(payload.schematic.nodes.map((node) => node.id)).not.toContain("ovl-1");
  });

  it("reicht Schlüssel 1:1 durch (kein default, kein rewrite)", () => {
    const payload = firstOpenPayload({
      workspaceId: "ws-1",
      offerId: "offer-2",
      variantId: "variant-3",
      revision: 7,
      backbone: BACKBONE,
    });
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.offerId).toBe("offer-2");
    expect(payload.variantId).toBe("variant-3");
    expect(payload.revision).toBe(7);
    expect(Object.keys(payload).sort()).toEqual(
      ["offerId", "revision", "schematic", "variantId", "workspaceId"],
    );
  });
});

describe("F6-02b Sections-Projektion (Ansicht == Loader)", () => {
  it("summiert sichtbare Milli-Mengen und formatiert das Label", () => {
    expect(
      projectSchematicSections([
        {
          category: "module",
          title: "PV-Module",
          lines: [
            { isHidden: false, quantityMilli: 12000, product: { unit: "piece" } },
            { isHidden: false, quantityMilli: 8000, product: { unit: "piece" } },
            { isHidden: true, quantityMilli: 5000, product: { unit: "piece" } },
          ],
        },
      ]),
    ).toEqual([{ category: "module", title: "PV-Module", quantityLabel: "20 Stk." }]);
  });

  it("gibt null-Label bei gemischten Einheiten, droppt leere Sections", () => {
    expect(
      projectSchematicSections([
        {
          category: "inverter",
          title: "Wechselrichter",
          lines: [
            { isHidden: false, quantityMilli: 1000, product: { unit: "piece" } },
            { isHidden: false, quantityMilli: 2000, product: { unit: "set" } },
          ],
        },
        {
          category: "battery",
          title: "Speicher",
          lines: [{ isHidden: true, quantityMilli: 1000, product: { unit: "piece" } }],
        },
      ]),
    ).toEqual([{ category: "inverter", title: "Wechselrichter", quantityLabel: null }]);
  });
});

describe("F6-02b formatQuantity (Move-Pin, Verhalten identisch)", () => {
  it("formatiert Stueck/Set/Meter deutsch mit max 2 Nachstellen", () => {
    expect(formatQuantity(1000, "piece")).toBe("1 Stk.");
    expect(formatQuantity(1500, "set")).toBe("1,5 Set");
    expect(formatQuantity(2500, "meter")).toBe("2,5 m");
  });

  it("faellt unbekannte Einheiten auf Meter zurueck", () => {
    expect(formatQuantity(1000, "palette")).toBe("1 m");
  });
});

describe("F6-02b Page-Ensure-Entscheid", () => {
  it("ensured bei residential + Editor + Inhalt", () => {
    expect(
      resolvePageEnsureMode({ scope: "residential", canWrite: true, nodeCount: 4, unwiredCount: 0 }),
    ).toBe("ensure");
    expect(
      resolvePageEnsureMode({ scope: "residential", canWrite: true, nodeCount: 0, unwiredCount: 2 }),
    ).toBe("ensure");
  });

  it("skipped bei Gate, fehlendem Recht und leerem Build", () => {
    expect(
      resolvePageEnsureMode({ scope: "commercial", canWrite: true, nodeCount: 4, unwiredCount: 0 }),
    ).toBe("skip:gate");
    expect(
      resolvePageEnsureMode({ scope: "residential", canWrite: false, nodeCount: 4, unwiredCount: 0 }),
    ).toBe("skip:rights");
    expect(
      resolvePageEnsureMode({ scope: "residential", canWrite: true, nodeCount: 0, unwiredCount: 0 }),
    ).toBe("skip:empty");
  });
});
