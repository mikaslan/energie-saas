import { describe, expect, it } from "vitest";

import {
  checklistItemKindSchema,
  editableChecklistBlocksSchema,
  isChecklistWorkItem,
  type ChecklistItemV1,
} from "@/lib/integrations/checklists/contract";
import { checklistTemplateItemSchema } from "@/lib/integrations/checklists/template-contract";
import { buildSingleLineSchematic } from "@/lib/integrations/schematic/single-line-v1";

const BLOCK_ID = "11111111-1111-1111-8111-111111111111";
const SEGMENT_ID = "22222222-2222-2222-8222-222222222222";
const ITEM_A = "33333333-3333-3333-8333-333333333333";
const COMPONENT_ID = "55555555-5555-5555-8555-555555555555";

function item(overrides: Partial<ChecklistItemV1> = {}): ChecklistItemV1 {
  return {
    id: ITEM_A,
    title: "Schaltplan",
    done: false,
    required: false,
    visible: true,
    irrelevant: null,
    visibleIf: null,
    kind: null,
    description: null,
    ...overrides,
  };
}

function blocksWith(items: ChecklistItemV1[]) {
  return [
    {
      id: BLOCK_ID,
      name: "Block",
      position: 0,
      visible: true,
      segments: [
        {
          id: SEGMENT_ID,
          name: "Segment",
          position: 0,
          visible: true,
          items,
        },
      ],
    },
  ];
}

describe("F7-02L Schaltplan-Punkt", () => {
  it("F702L-U-01: circuit-plan ist eine bekannte Art (Projekt + Vorlage)", () => {
    expect(checklistItemKindSchema.safeParse("circuit-plan").success).toBe(true);
    const project = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ kind: "circuit-plan" }),
    ]));
    expect(project.success).toBe(true);
    const template = checklistTemplateItemSchema.safeParse({
      componentId: COMPONENT_ID,
      quantity: 1,
      position: 0,
      visibleToCustomer: false,
      priceOverridesComponent: false,
      kind: "circuit-plan",
    });
    expect(template.success).toBe(true);
  });

  it("F702L-U-02: required/done sind je einzeln ungueltig (Anzeige-Art)", () => {
    for (const patch of [{ required: true }, { done: true }]) {
      const parsed = editableChecklistBlocksSchema.safeParse(blocksWith([
        item({ kind: "circuit-plan", ...patch }),
      ]));
      expect(parsed.success).toBe(false);
    }
  });

  it("F702L-U-03: Fremd-Nutzlast ist am circuit-plan-Punkt invalid", () => {
    const photoKey = `immutable/${COMPONENT_ID}/checklist-photos/${ITEM_A}_b2c3d4e5.png`;
    const cases: Array<Partial<ChecklistItemV1>> = [
      { value: "Antwort" },
      { photo: photoKey },
      { photos: [photoKey], photo: photoKey },
      { signerRole: "kunde" },
      { description: "Fliesstext" },
    ];
    for (const patch of cases) {
      const parsed = editableChecklistBlocksSchema.safeParse(blocksWith([
        item({ kind: "circuit-plan", ...patch }),
      ]));
      expect(parsed.success).toBe(false);
    }
  });

  it("F702L-U-04: circuit-plan ist kein Arbeitsgegenstand", () => {
    expect(isChecklistWorkItem(item({ kind: "circuit-plan" }))).toBe(false);
  });

  it("F702L-U-05: Render-Vertrag (Fallback bei null/leer, SVG nur bei verdrahteten Knoten)", () => {
    // null → Fallback per `schematicInputs !== null`-Guard (kein
    // buildSingleLineSchematic-Aufruf, kein Crash — E2E E-02 pinnt das);
    // leere Inputs → empty → Fallback (Panel-Praezedenz
    // installation-workbook-panel.tsx:239-240). Kein neuer Mapper —
    // toSchematicInputs ist F7-11-getestet.
    expect(buildSingleLineSchematic([]).empty).toBe(true);
    expect(buildSingleLineSchematic([
      { category: "battery", title: "Speicher", quantityLabel: "1 Stück" },
    ]).empty).toBe(true);
    const wired = buildSingleLineSchematic([
      { category: "module", title: "Module", quantityLabel: "8 Stück" },
      { category: "inverter", title: "Wechselrichter", quantityLabel: "1 Stück" },
    ]);
    expect(wired.empty).toBe(false);
    expect(wired.nodes.length).toBeGreaterThan(0);
  });
});
