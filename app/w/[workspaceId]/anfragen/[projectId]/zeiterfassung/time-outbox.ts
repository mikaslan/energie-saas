// F11-03b Zeit-Outbox (Client, IndexedDB): Offline erstellte manuelle
// Zeiteinträge werden je Entwurf (clientKey) genau einmal
// zwischengespeichert und beim nächsten Online-Kontakt über dieselbe
// Server-Action replayt. Der serverseitige Replay-Guard
// (client_key-Unique) macht Doppel-Syncs sicher. Eigene Datenbank
// (wmee-time-outbox), damit die Notiz-Outbox unangetastet bleibt.
export type QueuedTimeCreate = {
  clientKey: string;
  workspaceId: string;
  projectId: string;
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

const DB_NAME = "wmee-time-outbox";
const STORE_NAME = "time-creates";
// F11-03c: wartende Offline-Starts der Stoppuhr (ein Start je Projekt).
const TIMER_STORE_NAME = "timer-starts";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "clientKey" });
      }
      if (!request.result.objectStoreNames.contains(TIMER_STORE_NAME)) {
        request.result.createObjectStore(TIMER_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb open failed"));
  });
}

function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
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

export async function enqueueTimeCreate(entry: QueuedTimeCreate): Promise<void> {
  await withStore(STORE_NAME, "readwrite", (store) => store.put(entry));
}

export async function listQueuedTimeCreates(): Promise<QueuedTimeCreate[]> {
  return withStore(STORE_NAME, "readonly", (store) => store.getAll());
}

export async function removeQueuedTimeCreate(clientKey: string): Promise<void> {
  await withStore(STORE_NAME, "readwrite", (store) => store.delete(clientKey));
}

export type QueuedTimerStartRecord = {
  key: string;
  workspaceId: string;
  projectId: string;
  typeId: string | null;
  comment: string | null;
  startAt: string;
  queuedAt: string;
};

// F11-03c: genau ein wartender Offline-Start je Projekt (erneutes
// Starten überschreibt — kein Stapel wartender Starts).
export async function putTimerStart(entry: QueuedTimerStartRecord): Promise<void> {
  await withStore(TIMER_STORE_NAME, "readwrite", (store) => store.put(entry));
}

export async function readTimerStart(workspaceId: string, projectId: string): Promise<QueuedTimerStartRecord | null> {
  const found = await withStore<QueuedTimerStartRecord | undefined>(
    TIMER_STORE_NAME,
    "readonly",
    (store) => store.get(`${workspaceId}:${projectId}`),
  );
  return found ?? null;
}

export async function removeTimerStart(workspaceId: string, projectId: string): Promise<void> {
  await withStore(TIMER_STORE_NAME, "readwrite", (store) => store.delete(`${workspaceId}:${projectId}`));
}
