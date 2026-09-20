import { z } from "zod";
import {
  CHECKLIST_ITEM_VALUE_MAX,
  isChecklistWorkItem,
  toEditableChecklistBlocks,
  type ChecklistBlocksV1,
  type EditableChecklistBlocksV2,
} from "./contract";

// F11-04 Checklisten-Punkt-Outbox: reine Diff- und Replay-Planung (kein
// DB-Zugriff, kein I/O). Patches tragen nur `done`/`value`; der Replay
// wendet sie auf den jeweils aktuellen Serverbaum an (last-write-wins je
// Punkt, nie je Baum) und fasst abgeschlossene Segmente nie an.

export const itemOutboxEntrySchema = z.strictObject({
  workspaceId: z.string().min(1).max(120),
  projectId: z.string().min(1).max(120),
  checklistId: z.string().min(1).max(120),
  itemId: z.string().min(1).max(120),
  queuedAt: z.string().min(1).max(120),
  done: z.boolean().optional(),
  value: z.string().max(CHECKLIST_ITEM_VALUE_MAX).nullable().optional(),
}).refine((entry) => entry.done !== undefined || entry.value !== undefined, {
  message: "Patch ohne done und value",
});
export type ItemOutboxEntry = z.infer<typeof itemOutboxEntrySchema>;

export type ItemPatch = { itemId: string; done?: boolean; value?: string | null };

export function itemOutboxKey(checklistId: string, itemId: string): string {
  return `${checklistId}:${itemId}`;
}

function structureOf(blocks: ChecklistBlocksV1): string {
  return JSON.stringify(toEditableChecklistBlocks(blocks).map((block) => ({
    ...block,
    segments: block.segments.map((segment) => ({
      ...segment,
      items: segment.items.map((item) => ({ ...item, done: false, value: null })),
    })),
  })));
}

// Offline-Speichern: nur `done`/`value` sind replaybar. Alles andere
// (Namen, neue/entfernte Knoten, Pflicht, Art, Sichtbarkeit) meldet
// `structureChanged` und bleibt online-pflichtig.
export function diffItemPatches(
  server: ChecklistBlocksV1,
  local: ChecklistBlocksV1,
): { patches: ItemPatch[]; structureChanged: boolean } {
  const serverItems = new Map(server.flatMap((block) =>
    block.segments.flatMap((segment) => segment.items.map((item) => [item.id, item] as const))));
  const patches: ItemPatch[] = [];
  for (const block of local) {
    for (const segment of block.segments) {
      for (const item of segment.items) {
        const base = serverItems.get(item.id);
        if (!base) continue;
        const patch: ItemPatch = { itemId: item.id };
        if (item.done !== base.done) patch.done = item.done;
        if ((item.value ?? null) !== (base.value ?? null)) patch.value = item.value ?? null;
        if (patch.done !== undefined || patch.value !== undefined) patches.push(patch);
      }
    }
  }
  return { patches, structureChanged: structureOf(server) !== structureOf(local) };
}

export interface ItemSyncPlan {
  // Frischer Baum mit angewandten Patches; null = nichts zu speichern.
  blocks: EditableChecklistBlocksV2 | null;
  applied: ItemOutboxEntry[];
  unchanged: ItemOutboxEntry[];
  dropped: Array<{ entry: ItemOutboxEntry; reason: "missing" | "hidden" | "sealed" }>;
}

// Entscheidungsregel gegen den aktuellen Serverbaum: fehlend → verwerfen,
// abgeschlossenes Segment → nie überschreiben, verborgen/Anzeige-Punkt →
// verwerfen (der Server wiese den ganzen Save sonst mit 42501 ab), sonst
// Patch anwenden. Der letzte Eintrag je Punkt gewinnt.
export function planItemSync(
  entries: readonly ItemOutboxEntry[],
  blocks: ChecklistBlocksV1,
): ItemSyncPlan {
  const latest = new Map<string, ItemOutboxEntry>();
  for (const entry of entries) latest.set(entry.itemId, entry);

  const sealedSegments = new Set(blocks.flatMap((block) =>
    block.segments.filter((segment) => segment.completedAt !== null).map((segment) => segment.id)));
  const next = toEditableChecklistBlocks(blocks);
  const located = new Map(next.flatMap((block) =>
    block.segments.flatMap((segment) =>
      segment.items.map((item) => [item.id, { block, segment, item }] as const))));

  const plan: ItemSyncPlan = { blocks: null, applied: [], unchanged: [], dropped: [] };
  for (const entry of latest.values()) {
    const target = located.get(entry.itemId);
    if (!target) {
      plan.dropped.push({ entry, reason: "missing" });
      continue;
    }
    const { block, segment, item } = target;
    if (sealedSegments.has(segment.id)) {
      plan.dropped.push({ entry, reason: "sealed" });
      continue;
    }
    if (!block.visible || !segment.visible || !item.visible || !isChecklistWorkItem(item)) {
      plan.dropped.push({ entry, reason: "hidden" });
      continue;
    }
    const done = entry.done ?? item.done;
    // Antworttext nur am Textpunkt; Leertext wäre serverseitig ungültig
    // und würde den ganzen Replay vergiften → als „kein Wert" behandeln.
    const value = item.kind !== "text" || entry.value === undefined
      ? item.value ?? null
      : entry.value === null || entry.value.trim() === "" ? null : entry.value;
    if (done === item.done && value === (item.value ?? null)) {
      plan.unchanged.push(entry);
      continue;
    }
    if (done && item.kind === "radio") {
      for (const sibling of segment.items) {
        if (sibling.kind === "radio") sibling.done = false;
      }
    }
    item.done = done;
    if (item.kind === "text") item.value = value;
    plan.applied.push(entry);
  }
  if (plan.applied.length > 0) plan.blocks = next;
  return plan;
}
