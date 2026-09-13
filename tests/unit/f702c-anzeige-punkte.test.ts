import { describe, expect, it } from "vitest";

import {
  editableChecklistBlocksSchema,
  isChecklistWorkItem,
  segmentItemProgress,
  segmentRequiredRemaining,
  type ChecklistItemV1,
} from "@/lib/integrations/checklists/contract";

const BLOCK_ID = "11111111-1111-1111-8111-111111111111";
const SEGMENT_ID = "22222222-2222-2222-8222-222222222222";
const ITEM_A = "33333333-3333-3333-8333-333333333333";
const ITEM_B = "44444444-4444-4444-8444-444444444444";

function item(overrides: Partial<ChecklistItemV1> = {}): ChecklistItemV1 {
  return {
    id: ITEM_A,
    title: "Punkt A",
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

describe("F7-02C Anzeige-Punkte", () => {
  it("F702C-U-01: fehlende Art gilt als Aufgabe", () => {
    expect(isChecklistWorkItem(item())).toBe(true);
    expect(isChecklistWorkItem(item({ kind: "task" }))).toBe(true);
    expect(isChecklistWorkItem(item({ kind: "title" }))).toBe(false);
    expect(isChecklistWorkItem(item({ kind: "description" }))).toBe(false);
  });

  it("F702C-U-02: Anzeige-Punkte zählen in Gates nicht", () => {
    const segment = {
      items: [
        item({ required: true, done: false }),
        item({ id: ITEM_B, title: "Hinweis", kind: "description", description: "Bitte Dach prüfen" }),
      ],
    };
    expect(segmentRequiredRemaining(segment)).toBe(1);
    expect(segmentItemProgress(segment)).toEqual({ done: 0, total: 1 });
  });

  it("F702C-U-03: gültige Anzeige-Punkte passieren die Baumvalidierung", () => {
    const parsed = editableChecklistBlocksSchema.safeParse(blocksWith([
      item(),
      item({
        id: ITEM_B,
        title: "Abschnitt",
        kind: "title",
      }),
    ]));
    expect(parsed.success).toBe(true);
    const withText = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({
        kind: "description",
        description: "Vor Arbeitsbeginn freischalten.",
      }),
    ]));
    expect(withText.success).toBe(true);
  });

  it("F702C-U-04: Mischbestände werden abgewiesen", () => {
    const cases: ChecklistItemV1[] = [
      item({ kind: "description", required: true, description: "Text" }),
      item({ kind: "title", done: true }),
      item({ kind: "title", description: "Text ohne Typ" }),
      item({ description: "Text ohne Typ" }),
    ];
    for (const candidate of cases) {
      expect(editableChecklistBlocksSchema.safeParse(blocksWith([candidate])).success).toBe(false);
    }
  });

  it("F702C-U-05: Art-Enum und Textgrenzen sind strikt", () => {
    // F7-02D: `radio` ist seit 0141 eine bekannte Art (Einfachauswahl);
    // die Sonde nutzt den weiterhin unbekannten Typ `video`.
    const badKind = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ kind: "video" as unknown as "task" }),
    ]));
    expect(badKind.success).toBe(false);
    const tooLong = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ kind: "description", description: `x${"y".repeat(2000)}` }),
    ]));
    expect(tooLong.success).toBe(false);
    const empty = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ kind: "description", description: "" }),
    ]));
    expect(empty.success).toBe(false);
  });
});
