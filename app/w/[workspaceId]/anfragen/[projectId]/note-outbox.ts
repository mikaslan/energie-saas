// F11-03a Notiz-Outbox (Client, IndexedDB): Offline erstellte Notizen
// werden je Entwurf (clientKey) genau einmal zwischengespeichert und beim
// nächsten Online-Kontakt über dieselbe Server-Action replayt. Der
// serverseitige Replay-Guard (client_key-Unique) macht Doppel-Syncs sicher.
export type QueuedNoteCreate = {
  clientKey: string;
  workspaceId: string;
  projectId: string;
  textMarkdown: string;
  pinned: boolean;
  queuedAt: string;
};

const DB_NAME = "wmee-outbox";
const STORE_NAME = "note-creates";

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

export async function enqueueNoteCreate(entry: QueuedNoteCreate): Promise<void> {
  await withStore("readwrite", (store) => store.put(entry));
}

export async function listQueuedNoteCreates(): Promise<QueuedNoteCreate[]> {
  return withStore("readonly", (store) => store.getAll());
}

export async function removeQueuedNoteCreate(clientKey: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(clientKey));
}
