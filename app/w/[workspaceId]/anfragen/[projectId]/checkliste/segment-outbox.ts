// F7-04c Segment-Outbox (Client, IndexedDB): Offline getippte
// Segmentabschlüsse werden je Segment genau einmal zwischengespeichert
// und beim nächsten Online-Kontakt über dieselbe Server-Action replayt.
// Die Replay-Entscheidung (nie überschreiben) trifft planSegmentSync
// gegen den aktuellen Server-Stand.
import {
  segmentOutboxEntrySchema,
  segmentOutboxKey,
  type SegmentOutboxEntry,
} from "@/lib/integrations/checklists/segment-outbox";

export type QueuedSegmentComplete = SegmentOutboxEntry;

// Eigene Datenbank (nicht "wmee-outbox" der Notizen): jeder Outbox-
// Opener erstellt sonst nur seinen Store in v1 und der Zweit-Opener auf
// derselben Seite scheitert mit "object store was not found"
// (Vorbild: eigene DB der Zeiterfassung).
const DB_NAME = "wmee-segment-outbox";
const STORE_NAME = "segment-completes";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb open failed"));
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        let value: T | undefined;
        let failed: unknown = null;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          db.close();
          if (failed !== null) reject(failed);
          else resolve(value as T);
        };
        tx.oncomplete = done;
        tx.onerror = () => {
          failed = tx.error ?? new Error("indexeddb transaction failed");
          done();
        };
        tx.onabort = () => {
          failed = tx.error ?? new Error("indexeddb transaction aborted");
          done();
        };
        try {
          const request = run(store);
          request.onsuccess = () => {
            value = request.result;
          };
          request.onerror = () => {
            failed = request.error ?? new Error("indexeddb request failed");
          };
        } catch (error) {
          failed = error;
          try {
            tx.abort();
          } catch {
            done();
          }
        }
      }),
  );
}

export const SEGMENT_OUTBOX_CHANGED_EVENT = "wmee:segment-outbox-changed";

export async function enqueueSegmentComplete(
  entry: QueuedSegmentComplete,
): Promise<void> {
  const parsed = segmentOutboxEntrySchema.parse(entry);
  await withStore("readwrite", (store) => store.put({
    ...parsed,
    key: segmentOutboxKey(parsed.checklistId, parsed.segmentId),
  }));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SEGMENT_OUTBOX_CHANGED_EVENT));
  }
}

export async function listQueuedSegmentCompletes(): Promise<QueuedSegmentComplete[]> {
  const rows = await withStore<unknown[]>("readonly", (store) => store.getAll());
  const entries: QueuedSegmentComplete[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { key, ...candidate } = row as Record<string, unknown>;
    if (typeof key !== "string") continue;
    const parsed = segmentOutboxEntrySchema.safeParse(candidate);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

export async function removeQueuedSegmentComplete(
  checklistId: string,
  segmentId: string,
): Promise<void> {
  await withStore(
    "readwrite",
    (store) => store.delete(segmentOutboxKey(checklistId, segmentId)),
  );
}
