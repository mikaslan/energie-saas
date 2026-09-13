import { describe, expect, it } from "vitest";

import {
  editableChecklistBlocksSchema,
  isChecklistWorkItem,
  segmentItemProgress,
  segmentRequiredRemaining,
  type ChecklistItemV1,
} from "@/lib/integrations/checklists/contract";

/**
 * F7-02D Radio-Einfachauswahl (Katalog F7.2, Slice B) — Contract-Unit.
 * kind=radio ist Arbeitsgegenstand wie Aufgabe; hoechstens ein erledigter
 * Radio-Punkt je Segment passiert die Baumvalidierung.
 */

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

describe("F7-02D Radio-Einfachauswahl", () => {
  it("F702D-U-01: Radio ist Arbeitsgegenstand wie Aufgabe", () => {
    expect(isChecklistWorkItem(item({ kind: "radio" }))).toBe(true);
    expect(isChecklistWorkItem(item({ kind: "task" }))).toBe(true);
    expect(isChecklistWorkItem(item({ kind: "title" }))).toBe(false);
  });

  it("F702D-U-02: ein erledigter Radio-Punkt passiert, zwei werden abgewiesen", () => {
    const single = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ kind: "radio", done: true }),
      item({ id: ITEM_B, title: "Punkt B", kind: "radio", done: false }),
    ]));
    expect(single.success).toBe(true);
    const double = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ kind: "radio", done: true }),
      item({ id: ITEM_B, title: "Punkt B", kind: "radio", done: true }),
    ]));
    expect(double.success).toBe(false);
  });

  it("F702D-U-03: Pflicht-Radio zählt im Gate, erledigt löst es", () => {
    const open = {
      items: [item({ kind: "radio", required: true, done: false })],
    };
    expect(segmentRequiredRemaining(open)).toBe(1);
    expect(segmentItemProgress(open)).toEqual({ done: 0, total: 1 });
    const chosen = {
      items: [item({ kind: "radio", required: true, done: true })],
    };
    expect(segmentRequiredRemaining(chosen)).toBe(0);
    expect(segmentItemProgress(chosen)).toEqual({ done: 1, total: 1 });
  });
});
