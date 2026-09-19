// F9-15 R1c Projektlose Zeit-Outbox (Client, IndexedDB): Offline erstellte
// projektlose Zeiteinträge werden je Entwurf (clientKey) genau einmal
// zwischengespeichert und beim nächsten Online-Kontakt über dieselbe
// Server-Action replayt (OHNE projectId-Feld → F9-14-parater projektloser
// Pfad). Der serverseitige Replay-Guard (client_key-Unique, IS-NULL-Zweig)
// macht Doppel-Syncs sicher. Eigene Datenbank
// (wmee-projectless-time-outbox), damit die Projekt-Outbox unangetastet
// bleibt — KEINE Schema-Änderung am Projekt-Pfad. Kein Timer-offline.
export type QueuedProjectlessTimeCreate = {
  clientKey: string;
  workspaceId: string;
  // Immer null: diese Queue kennt nur projektlose Creates.
  projectId: null;
  typeId: string | null;
  // Rohe datetime-local-Wandzeiten (wie im Formular) — das Replay baut
  // daraus identische FormData, der Server parst wie online.
  startAt: string;
  endAt: string;
  workingTimeMinutes: number;
  breakDurationMinutes: number;
  comment: string | null;
  queuedAt: string;
};

const DB_NAME = "wmee-projectless-time-outbox";
const STORE_NAME = "projectless-time-creates";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "clientKey" });
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

export async function enqueueProjectlessTimeCreate(
  entry: QueuedProjectlessTimeCreate,
): Promise<void> {
  await withStore("readwrite", (store) => store.put(entry));
}

export async function listQueuedProjectlessTimeCreates(): Promise<QueuedProjectlessTimeCreate[]> {
  return withStore("readonly", (store) => store.getAll());
}

export async function removeQueuedProjectlessTimeCreate(clientKey: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(clientKey));
}
