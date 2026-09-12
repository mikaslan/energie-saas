import { describe, expect, it } from "vitest";

import {
  editableChecklistBlocksSchema,
  isItemEffectivelyVisible,
  segmentItemProgress,
  segmentRequiredRemaining,
  type ChecklistItemV1,
} from "@/lib/integrations/checklists/contract";

const BLOCK_ID = "11111111-1111-1111-8111-111111111111";
const SEGMENT_ID = "22222222-2222-2222-8222-222222222222";
const ITEM_A = "33333333-3333-3333-8333-333333333333";
const ITEM_B = "44444444-4444-4444-8444-444444444444";
const OTHER_SEGMENT = "55555555-5555-5555-8555-555555555555";
const OTHER_ITEM = "66666666-6666-6666-8666-666666666666";

function item(overrides: Partial<ChecklistItemV1> = {}): ChecklistItemV1 {
  return {
    id: ITEM_A,
    title: "Punkt A",
    done: false,
    required: false,
    visible: true,
    irrelevant: null,
    visibleIf: null,
    ...overrides,
  };
}

function doneBy(ids: Array<{ id: string; done: boolean }>): Map<string, { done: boolean }> {
  return new Map(ids.map(({ id, done }) => [id, { done }]));
}

function blocksWith(items: ChecklistItemV1[], extraSegments: unknown[] = []) {
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
        ...extraSegments,
      ],
    },
  ];
}

describe("F7-02B Bedingte Sichtbarkeit", () => {
  it("F702B-U-01: equals true folgt dem done-Flag der Referenz", () => {
    const ruled = item({ visibleIf: { itemId: ITEM_B, equals: true } });
    expect(isItemEffectivelyVisible(ruled, doneBy([{ id: ITEM_B, done: true }]))).toBe(true);
    expect(isItemEffectivelyVisible(ruled, doneBy([{ id: ITEM_B, done: false }]))).toBe(false);
  });

  it("F702B-U-02: equals false kehrt das done-Flag der Referenz um", () => {
    const ruled = item({ visibleIf: { itemId: ITEM_B, equals: false } });
    expect(isItemEffectivelyVisible(ruled, doneBy([{ id: ITEM_B, done: false }]))).toBe(true);
    expect(isItemEffectivelyVisible(ruled, doneBy([{ id: ITEM_B, done: true }]))).toBe(false);
  });

  it("F702B-U-03: ohne Regel gilt das visible-Flag allein", () => {
    expect(isItemEffectivelyVisible(item({ visible: true }), doneBy([]))).toBe(true);
    expect(isItemEffectivelyVisible(item({ visible: false }), doneBy([]))).toBe(false);
    const hidden = item({
      visible: false,
      visibleIf: { itemId: ITEM_B, equals: true },
    });
    expect(isItemEffectivelyVisible(hidden, doneBy([{ id: ITEM_B, done: true }]))).toBe(false);
  });

  it("F702B-U-04: fehlende Referenz bleibt sichtbar (Display fail-open)", () => {
    const ruled = item({ visibleIf: { itemId: ITEM_B, equals: true } });
    expect(isItemEffectivelyVisible(ruled, doneBy([]))).toBe(true);
  });

  it("F702B-U-05: Zyklus bleibt deterministisch (Single-Hop, kein Hang)", () => {
    const a = item({
      id: ITEM_A,
      visibleIf: { itemId: ITEM_B, equals: true },
    });
    const b = item({
      id: ITEM_B,
      title: "Punkt B",
      visibleIf: { itemId: ITEM_A, equals: false },
    });
    const byId = doneBy([
      { id: ITEM_A, done: false },
      { id: ITEM_B, done: false },
    ]);
    expect(isItemEffectivelyVisible(a, byId)).toBe(false);
    expect(isItemEffectivelyVisible(b, byId)).toBe(true);
  });

  it("F702B-U-06: versteckter Pflichtpunkt blockiert Gate und Zähler nicht", () => {
    const segment = {
      items: [
        item({ required: true, done: false }),
        item({
          id: ITEM_B,
          title: "Bedingter Pflichtpunkt",
          required: true,
          done: false,
          visibleIf: { itemId: ITEM_A, equals: true },
        }),
      ],
    };
    expect(segmentRequiredRemaining(segment)).toBe(1);
    expect(segmentItemProgress(segment)).toEqual({ done: 0, total: 1 });
  });

  it("F702B-U-07: gültige Regel passiert die Baumvalidierung", () => {
    const parsed = editableChecklistBlocksSchema.safeParse(blocksWith([
      item(),
      item({
        id: ITEM_B,
        title: "Punkt B",
        visibleIf: { itemId: ITEM_A, equals: true },
      }),
    ]));
    expect(parsed.success).toBe(true);
  });

  it("F702B-U-08: Selbstreferenz wird abgewiesen", () => {
    const parsed = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ visibleIf: { itemId: ITEM_A, equals: true } }),
    ]));
    expect(parsed.success).toBe(false);
  });

  it("F702B-U-09: baumelnde und segmentfremde Referenzen werden abgewiesen", () => {
    const dangling = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ visibleIf: { itemId: OTHER_ITEM, equals: false } }),
    ]));
    expect(dangling.success).toBe(false);
    const foreign = editableChecklistBlocksSchema.safeParse(blocksWith(
      [item()],
      [{
        id: OTHER_SEGMENT,
        name: "Fremd",
        position: 1,
        visible: true,
        items: [{
          id: OTHER_ITEM,
          title: "Fremd",
          done: false,
          required: false,
          visible: true,
          irrelevant: null,
          visibleIf: { itemId: ITEM_A, equals: false },
        }],
      }],
    ));
    expect(foreign.success).toBe(false);
  });

  it("F702B-U-10: halbe Regel wird abgewiesen", () => {
    const parsed = editableChecklistBlocksSchema.safeParse(blocksWith([
      item({ visibleIf: { itemId: ITEM_B } as unknown as { itemId: string; equals: boolean } }),
    ]));
    expect(parsed.success).toBe(false);
  });
});
