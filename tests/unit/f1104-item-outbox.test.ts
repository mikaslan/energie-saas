import { describe, expect, it } from "vitest";

import {
  editableChecklistBlocksSchema,
  type ChecklistBlocksV1,
  type ChecklistItemV1,
} from "@/lib/integrations/checklists/contract";
import {
  diffItemPatches,
  itemOutboxEntrySchema,
  itemOutboxKey,
  planItemSync,
  type ItemOutboxEntry,
} from "@/lib/integrations/checklists/item-outbox";

const BLOCK = "10000000-0000-4000-8000-000000000001";
const SEGMENT = "20000000-0000-4000-8000-000000000001";
const A = "30000000-0000-4000-8000-00000000000a";
const B = "30000000-0000-4000-8000-00000000000b";
const C = "30000000-0000-4000-8000-00000000000c";

function item(id: string, patch: Partial<ChecklistItemV1> = {}): ChecklistItemV1 {
  return { id, title: `Punkt ${id.slice(-1)}`, done: false, required: false, visible: true, ...patch };
}

function tree(
  items: ChecklistItemV1[],
  segment: { completedAt?: string | null; visible?: boolean } = {},
): ChecklistBlocksV1 {
  const completedAt = segment.completedAt ?? null;
  return [{
    id: BLOCK,
    name: "Montage",
    position: 0,
    visible: true,
    assignedTeams: [],
    segments: [{
      id: SEGMENT,
      name: "Dach",
      position: 0,
      visible: segment.visible ?? true,
      completedAt,
      completedById: completedAt === null ? null : "40000000-0000-4000-8000-000000000001",
      items,
    }],
  }];
}

function entry(itemId: string, patch: { done?: boolean; value?: string | null }): ItemOutboxEntry {
  return {
    workspaceId: "ws",
    projectId: "project",
    checklistId: "checklist",
    itemId,
    queuedAt: "2026-09-20T10:00:00.000Z",
    ...patch,
  };
}

function itemsOf(blocks: { segments: { items: ChecklistItemV1[] }[] }[] | null): ChecklistItemV1[] {
  return (blocks ?? []).flatMap((block) => block.segments.flatMap((segment) => segment.items));
}

describe("F11-04 Checklisten-Punkt-Outbox-Planer", () => {
  it("F1104-U-01: Diff enthält nur done/value und meldet Strukturänderungen", () => {
    const server = tree([item(A), item(B, { kind: "text" }), item(C)]);
    const local = tree([
      item(A, { done: true }),
      item(B, { kind: "text", done: true, value: "Zählerstand 4711" }),
      item(C, { title: "Umbenannt" }),
    ]);
    expect(diffItemPatches(server, local)).toEqual({
      patches: [
        { itemId: A, done: true },
        { itemId: B, done: true, value: "Zählerstand 4711" },
      ],
      structureChanged: true,
    });
    expect(diffItemPatches(server, server)).toEqual({ patches: [], structureChanged: false });
  });

  it("F1104-U-02: Schlüssel je Checkliste+Punkt, Eintrag strict und nie leer", () => {
    expect(itemOutboxKey("c", "i")).toBe("c:i");
    expect(itemOutboxEntrySchema.safeParse(entry(A, { done: true })).success).toBe(true);
    expect(itemOutboxEntrySchema.safeParse(entry(A, { value: null })).success).toBe(true);
    expect(itemOutboxEntrySchema.safeParse(entry(A, {})).success).toBe(false);
    expect(itemOutboxEntrySchema.safeParse({ ...entry(A, { done: true }), title: "x" }).success).toBe(false);
  });

  it("F1104-U-03: Patch landet auf dem frischen Baum, Fremdhaken bleibt (LWW je Punkt)", () => {
    // Server hat inzwischen B (fremd) erledigt; die Queue kennt nur A.
    const fresh = tree([item(A), item(B, { done: true })]);
    const plan = planItemSync([entry(A, { done: true })], fresh);
    expect(plan.applied).toEqual([entry(A, { done: true })]);
    expect(plan.dropped).toEqual([]);
    expect(itemsOf(plan.blocks).map((value) => [value.id, value.done])).toEqual([[A, true], [B, true]]);
    expect(editableChecklistBlocksSchema.safeParse(plan.blocks).success).toBe(true);
  });

  it("F1104-U-04: letzter Eintrag je Punkt gewinnt, auch gegen einen Fremdstand", () => {
    const fresh = tree([item(A, { done: true })]);
    const plan = planItemSync([entry(A, { done: true }), entry(A, { done: false })], fresh);
    expect(plan.applied).toEqual([entry(A, { done: false })]);
    expect(itemsOf(plan.blocks)[0]?.done).toBe(false);
  });

  it("F1104-U-05: abgeschlossenes Segment wird nie überschrieben", () => {
    const fresh = tree([item(A)], { completedAt: "2026-09-20T09:00:00.000Z" });
    const plan = planItemSync([entry(A, { done: true })], fresh);
    expect(plan.blocks).toBeNull();
    expect(plan.dropped).toEqual([{ entry: entry(A, { done: true }), reason: "sealed" }]);
  });

  it("F1104-U-06: fehlende, unsichtbare und Anzeige-Punkte werden verworfen", () => {
    const fresh = tree([item(A, { visible: false }), item(B, { kind: "title" })]);
    const plan = planItemSync(
      [entry(A, { done: true }), entry(B, { done: true }), entry(C, { done: true })],
      fresh,
    );
    expect(plan.blocks).toBeNull();
    expect(plan.dropped.map((drop) => [drop.entry.itemId, drop.reason])).toEqual([
      [A, "hidden"], [B, "hidden"], [C, "missing"],
    ]);
    const hiddenSegment = planItemSync([entry(A, { done: true })], tree([item(A)], { visible: false }));
    expect(hiddenSegment.dropped.map((drop) => drop.reason)).toEqual(["hidden"]);
  });

  it("F1104-U-07: Radio bleibt exklusiv, Antworttext nur am Textpunkt", () => {
    // Fremd wurde Radio C gewählt; der Offline-Patch wählt Radio A.
    const fresh = tree([item(A, { kind: "radio" }), item(C, { kind: "radio", done: true }), item(B)]);
    const plan = planItemSync(
      [entry(A, { done: true }), entry(B, { done: true, value: "gehört nicht hierher" })],
      fresh,
    );
    const result = itemsOf(plan.blocks);
    expect(result.map((value) => [value.id, value.done])).toEqual([[A, true], [C, false], [B, true]]);
    expect(result[2]?.value ?? null).toBeNull();
    expect(editableChecklistBlocksSchema.safeParse(plan.blocks).success).toBe(true);
  });

  it("F1104-U-08: deckungsgleicher Stand wird ohne Save geräumt", () => {
    const fresh = tree([item(A, { done: true })]);
    const plan = planItemSync([entry(A, { done: true })], fresh);
    expect(plan.blocks).toBeNull();
    expect(plan.applied).toEqual([]);
    expect(plan.unchanged).toEqual([entry(A, { done: true })]);
  });
});
