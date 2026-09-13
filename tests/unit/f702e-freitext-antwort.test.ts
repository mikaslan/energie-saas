import { describe, expect, it } from "vitest";

import {
  editableChecklistBlocksSchema,
  isChecklistWorkItem,
  segmentItemProgress,
  segmentRequiredRemaining,
  type ChecklistItemV1,
} from "@/lib/integrations/checklists/contract";

/**
 * F7-02E Freitext-Antwort (Katalog F7.2, Slice B ohne Diktat) — Contract-Unit.
 * kind=text ist Arbeitsgegenstand wie Aufgabe; Antworttext nur dort,
 * Längenkappe 2000, Pflicht-Gate-Neutralität.
 */

const BLOCK_ID = "11111111-1111-1111-8111-111111111111";
const SEGMENT_ID = "22222222-2222-2222-8222-222222222222";
const ITEM_A = "33333333-3333-3333-8333-333333333333";

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

describe("F7-02E Freitext-Antwort", () => {
  it("F702E-U-01: Text ist Arbeitsgegenstand wie Aufgabe", () => {
    expect(isChecklistWorkItem(item({ kind: "text" }))).toBe(true);
    expect(isChecklistWorkItem(item({ kind: "task" }))).toBe(true);
    expect(isChecklistWorkItem(item({ kind: "title" }))).toBe(false);
  });

  it("F702E-U-02: Antworttext passiert am Textpunkt, sonst fail-closed", () => {
    const valid = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ kind: "text", value: "42.195 kWh" }),
    ]));
    expect(valid.success).toBe(true);
    const smuggled = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ kind: "task", value: "Fremdtext" }),
    ]));
    expect(smuggled.success).toBe(false);
    const tooLong = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ kind: "text", value: `x${"y".repeat(2000)}` }),
    ]));
    expect(tooLong.success).toBe(false);
    const empty = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ kind: "text", value: "" }),
    ]));
    expect(empty.success).toBe(false);
  });

  it("F702E-U-03: Pflicht-Text zählt im Gate, erledigt löst es", () => {
    const open = {
      items: [item({ kind: "text", required: true, done: false, value: "Notiz" })],
    };
    expect(segmentRequiredRemaining(open)).toBe(1);
    expect(segmentItemProgress(open)).toEqual({ done: 0, total: 1 });
    const chosen = {
      items: [item({ kind: "text", required: true, done: true, value: "Notiz" })],
    };
    expect(segmentRequiredRemaining(chosen)).toBe(0);
    expect(segmentItemProgress(chosen)).toEqual({ done: 1, total: 1 });
  });
});
