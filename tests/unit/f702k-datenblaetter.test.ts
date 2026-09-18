import { describe, expect, it } from "vitest";

import {
  checklistItemKindSchema,
  editableChecklistBlocksSchema,
  isChecklistWorkItem,
  type ChecklistItemV1,
} from "@/lib/integrations/checklists/contract";
import { checklistTemplateItemSchema } from "@/lib/integrations/checklists/template-contract";
import {
  projectWorkbookDatasheets,
  type WorkbookDatasheetRef,
  type WorkbookSection,
} from "@/modules/installations";

const BLOCK_ID = "11111111-1111-1111-8111-111111111111";
const SEGMENT_ID = "22222222-2222-2222-8222-222222222222";
const ITEM_A = "33333333-3333-3333-8333-333333333333";
const COMPONENT_ID = "55555555-5555-5555-8555-555555555555";

function item(overrides: Partial<ChecklistItemV1> = {}): ChecklistItemV1 {
  return {
    id: ITEM_A,
    title: "Datenblätter",
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

function ref(
  productName: string,
  filename: string,
  componentId = COMPONENT_ID,
): WorkbookDatasheetRef {
  return { productName, filename, componentId };
}

function line(
  position: number,
  name: string,
  quantity: string,
  datasheet: WorkbookDatasheetRef | null,
): WorkbookSection["lines"][number] {
  return {
    position,
    lineDomainId: `00000000-0000-0000-0000-00000000000${position}`,
    name,
    quantity,
    unit: "piece",
    grossCents: 100 * position,
    datasheet,
  };
}

function section(
  position: number,
  title: string,
  lines: WorkbookSection["lines"],
): WorkbookSection {
  return { position, category: "pv", title, quantityLabel: null, lines };
}

describe("F7-02K Datenblatt-Punkt", () => {
  it("F702K-U-01: datasheets ist eine bekannte Art (Projekt + Vorlage)", () => {
    expect(checklistItemKindSchema.safeParse("datasheets").success).toBe(true);
    const project = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ kind: "datasheets" }),
    ]));
    expect(project.success).toBe(true);
    const template = checklistTemplateItemSchema.safeParse({
      componentId: COMPONENT_ID,
      quantity: 1,
      position: 0,
      visibleToCustomer: false,
      priceOverridesComponent: false,
      kind: "datasheets",
    });
    expect(template.success).toBe(true);
  });

  it("F702K-U-02: required/done sind je einzeln ungueltig (Anzeige-Art)", () => {
    for (const patch of [{ required: true }, { done: true }]) {
      const parsed = editableChecklistBlocksSchema.safeParse(blocksWith([
        item({ kind: "datasheets", ...patch }),
      ]));
      expect(parsed.success).toBe(false);
    }
  });

  it("F702K-U-03: Fremd-Nutzlast ist am datasheets-Punkt invalid", () => {
    const cases: Array<Partial<ChecklistItemV1>> = [
      { value: "Antwort" },
      { photo: `immutable/${COMPONENT_ID}/checklist-photos/${ITEM_A}_b2c3d4e5.png` },
      { signerRole: "kunde" },
      { description: "Fliesstext" },
    ];
    for (const patch of cases) {
      const parsed = editableChecklistBlocksSchema.safeParse(blocksWith([
        item({ kind: "datasheets", ...patch }),
      ]));
      expect(parsed.success).toBe(false);
    }
  });

  it("F702K-U-04: Projektion in Reihenfolge, nur Zeilen mit Referenz, keine Keys/sha/Preise", () => {
    const sections = [
      section(0, "Module", [
        line(0, "PV-Modul X", "8 Stück", ref("PV-Modul X", "modul-datenblatt.pdf")),
        line(1, "Montageschiene", "4 Stück", null),
      ]),
      section(1, "Wechselrichter", [
        line(0, "Wechselrichter Y", "1 Stück", ref("Wechselrichter Y", "wr-datenblatt.pdf", "66666666-6666-6666-8666-666666666666")),
      ]),
    ];
    expect(projectWorkbookDatasheets(sections)).toEqual([
      { productName: "PV-Modul X", filename: "modul-datenblatt.pdf", componentId: COMPONENT_ID },
      {
        productName: "Wechselrichter Y",
        filename: "wr-datenblatt.pdf",
        componentId: "66666666-6666-6666-8666-666666666666",
      },
    ]);
    expect(projectWorkbookDatasheets([])).toEqual([]);
    expect(projectWorkbookDatasheets([
      section(0, "Leer", [line(0, "Ohne Asset", "1 Stück", null)]),
    ])).toEqual([]);
    const serialized = JSON.stringify(projectWorkbookDatasheets(sections));
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain("sha");
    expect(serialized).not.toContain("grossCents");
    expect(serialized).not.toContain("lineDomainId");
  });

  it("F702K-U-05: datasheets ist kein Arbeitsgegenstand", () => {
    expect(isChecklistWorkItem(item({ kind: "datasheets" }))).toBe(false);
  });

  it("F702K-U-06: alle elf Arten bleiben bekannt (Projekt + Vorlage)", () => {
    const kinds = [
      "task",
      "title",
      "description",
      "radio",
      "text",
      "multi",
      "image",
      "signature",
      "component-list",
      "datasheets",
      "circuit-plan",
    ] as const;
    expect(checklistItemKindSchema.options).toHaveLength(11);
    for (const kind of kinds) {
      expect(checklistItemKindSchema.safeParse(kind).success).toBe(true);
      const template = checklistTemplateItemSchema.safeParse({
        componentId: COMPONENT_ID,
        quantity: 1,
        position: 0,
        visibleToCustomer: false,
        priceOverridesComponent: false,
        kind,
      });
      expect(template.success).toBe(true);
    }
  });
});
