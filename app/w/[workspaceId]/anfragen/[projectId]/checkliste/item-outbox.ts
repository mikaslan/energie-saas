// F11-04 Checklisten-Punkt-Outbox (Client, IndexedDB): offline
// gespeicherte Haken und Antworttexte warten je Punkt genau einmal und
// werden beim nächsten Online-Kontakt über dieselbe Save-Action replayt.
// Die Replay-Entscheidung (LWW je Punkt, abgeschlossene Segmente nie
// überschreiben) trifft planItemSync gegen den aktuellen Server-Stand.
import {
  itemOutboxEntrySchema,
  itemOutboxKey,
  type ItemOutboxEntry,
  type ItemPatch,
} from "@/lib/integrations/checklists/item-outbox";
import { withOutboxStore } from "./segment-outbox";

// Eigene Datenbank statt Versionssprung der Segment-DB: ein Upgrade auf
// v2 ließe noch offene Alt-Tabs (öffnen v1) mit VersionError scheitern.
const DB_NAME = "wmee-item-outbox";
const STORE_NAME = "item-patches";

export const ITEM_OUTBOX_CHANGED_EVENT = "wmee:item-outbox-changed";

// Setzt die Warteschlange dieser Checkliste auf den sichtbaren Stand:
// alte Einträge der Checkliste raus, aktuelle Patches rein (eine
// Transaktion). Ein offline wieder entfernter Haken hinterlässt so
// keinen veralteten Patch.
// ponytail: maßgeblich ist der sichtbare Stand — ein nach Reload noch
// wartender (nicht mehr angezeigter) Patch derselben Checkliste wird beim
// nächsten Offline-Speichern ersetzt. Bei Bedarf: wartende Patches beim
// Laden in den lokalen Stand einspielen.
export async function replaceQueuedItemPatches(
  scope: { workspaceId: string; projectId: string; checklistId: string },
  patches: readonly ItemPatch[],
): Promise<void> {
  const queuedAt = new Date().toISOString();
  const rows = patches.map((patch) => {
    const entry = itemOutboxEntrySchema.parse({ ...scope, ...patch, queuedAt });
    return { ...entry, key: itemOutboxKey(entry.checklistId, entry.itemId) };
  });
  await withOutboxStore(DB_NAME, STORE_NAME, "readwrite", (store) => {
    store.delete(IDBKeyRange.bound(
      `${scope.checklistId}:`,
      `${scope.checklistId}:￿`,
    ));
    for (const row of rows) store.put(row);
    // Aufgelöst wird erst mit dem Abschluss der Transaktion.
    return store.count();
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(ITEM_OUTBOX_CHANGED_EVENT));
  }
}

export async function listQueuedItemPatches(): Promise<ItemOutboxEntry[]> {
  const rows = await withOutboxStore<unknown[]>(
    DB_NAME, STORE_NAME, "readonly", (store) => store.getAll(),
  );
  const entries: ItemOutboxEntry[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { key, ...candidate } = row as Record<string, unknown>;
    if (typeof key !== "string") continue;
    const parsed = itemOutboxEntrySchema.safeParse(candidate);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

export async function removeQueuedItemPatch(
  checklistId: string,
  itemId: string,
): Promise<void> {
  await withOutboxStore(
    DB_NAME, STORE_NAME, "readwrite",
    (store) => store.delete(itemOutboxKey(checklistId, itemId)),
  );
}
