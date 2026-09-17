import { describe, expect, it } from "vitest";

import {
  checklistItemKindSchema,
  editableChecklistBlocksSchema,
  isChecklistWorkItem,
  type ChecklistItemV1,
} from "@/lib/integrations/checklists/contract";
import { checklistTemplateItemSchema } from "@/lib/integrations/checklists/template-contract";
import {
  projectWorkbookComponentSections,
  type WorkbookSection,
} from "@/modules/installations";

const BLOCK_ID = "11111111-1111-1111-8111-111111111111";
const SEGMENT_ID = "22222222-2222-2222-8222-222222222222";
const ITEM_A = "33333333-3333-3333-8333-333333333333";
const COMPONENT_ID = "55555555-5555-5555-8555-555555555555";

function item(overrides: Partial<ChecklistItemV1> = {}): ChecklistItemV1 {
  return {
    id: ITEM_A,
    title: "Stückliste",
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

function line(
  position: number,
  name: string,
  quantity: string,
): WorkbookSection["lines"][number] {
  return {
    position,
    lineDomainId: `00000000-0000-0000-0000-00000000000${position}`,
    name,
    quantity,
    unit: "piece",
    grossCents: 100 * position,
  };
}

function section(
  position: number,
  title: string,
  lines: WorkbookSection["lines"],
): WorkbookSection {
  return { position, category: "pv", title, lines };
}

describe("F7-02J Komponentenlisten-Punkt", () => {
  it("F702J-U-01: component-list ist eine bekannte Art (Projekt + Vorlage)", () => {
    expect(checklistItemKindSchema.safeParse("component-list").success).toBe(true);
    const project = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ kind: "component-list" }),
    ]));
    expect(project.success).toBe(true);
    const template = checklistTemplateItemSchema.safeParse({
      componentId: COMPONENT_ID,
      quantity: 1,
      position: 0,
      visibleToCustomer: false,
      priceOverridesComponent: false,
      kind: "component-list",
    });
    expect(template.success).toBe(true);
  });

  it("F702J-U-02: required/done sind je einzeln ungueltig (Anzeige-Art)", () => {
    for (const patch of [{ required: true }, { done: true }]) {
      const parsed = editableChecklistBlocksSchema.safeParse(blocksWith([
        item({ kind: "component-list", ...patch }),
      ]));
      expect(parsed.success).toBe(false);
    }
  });

  it("F702J-U-03: Fremd-Nutzlast ist am component-list-Punkt invalid", () => {
    const cases: Array<Partial<ChecklistItemV1>> = [
      { value: "Antwort" },
      { photo: `immutable/${COMPONENT_ID}/checklist-photos/${ITEM_A}_b2c3d4e5.png` },
      { signerRole: "kunde" },
      { description: "Fliesstext" },
    ];
    for (const patch of cases) {
      const parsed = editableChecklistBlocksSchema.safeParse(blocksWith([
        item({ kind: "component-list", ...patch }),
      ]));
      expect(parsed.success).toBe(false);
    }
  });

  it("F702J-U-04: Projektion in Reihenfolge, leere Sektionen raus, keine Preise/IDs", () => {
    const sections = [
      section(0, "Module", [line(0, "PV-Modul X", "8 Stück")]),
      section(1, "Leer", []),
      section(2, "Wechselrichter", [
        line(0, "Wechselrichter Y", "1 Stück"),
        line(1, "Solarkabel", "12,5 m"),
      ]),
    ];
    expect(projectWorkbookComponentSections(sections)).toEqual([
      { section: "Module", lines: [{ quantity: "8 Stück", name: "PV-Modul X" }] },
      {
        section: "Wechselrichter",
        lines: [
          { quantity: "1 Stück", name: "Wechselrichter Y" },
          { quantity: "12,5 m", name: "Solarkabel" },
        ],
      },
    ]);
    expect(projectWorkbookComponentSections([])).toEqual([]);
    expect(JSON.stringify(projectWorkbookComponentSections(sections)))
      .not.toContain("grossCents");
    expect(JSON.stringify(projectWorkbookComponentSections(sections)))
      .not.toContain("lineDomainId");
  });

  it("F702J-U-05: component-list ist kein Arbeitsgegenstand", () => {
    expect(isChecklistWorkItem(item({ kind: "component-list" }))).toBe(false);
  });
});
