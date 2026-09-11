"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createTimeEntryAction } from "./actions";
import {
  listQueuedTimeCreates,
  removeQueuedTimeCreate,
  type QueuedTimeCreate,
} from "./time-outbox";

// F11-03b: Replay wartender Offline-Zeiteinträge (desselben Projekts) über
// die normale Server-Action. Der clientKey macht Doppel-Syncs sicher
// (Replay-Guard); endgültige Antworten räumen die Outbox, Netzfehler
// behalten den Eintrag für den nächsten Versuch.
export function TimeOutboxSync({
  workspaceId,
  projectId,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<QueuedTimeCreate[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const syncingRef = useRef(false);

  const refreshPending = useCallback(async () => {
    try {
      const all = await listQueuedTimeCreates();
      setPending(all.filter(
        (entry) => entry.workspaceId === workspaceId && entry.projectId === projectId,
      ));
    } catch {
      // Ohne IndexedDB keine Outbox-Anzeige (App bleibt nutzbar).
    }
  }, [projectId, workspaceId]);

  const syncNow = useCallback(async () => {
    if (syncingRef.current || !canWrite) return;
    syncingRef.current = true;
    setSyncing(true);
    setMessage("");
    try {
      const all = await listQueuedTimeCreates();
      const mine = all.filter(
        (entry) => entry.workspaceId === workspaceId && entry.projectId === projectId,
      );
      setPending(mine);
      let synced = 0;
      for (const entry of mine) {
        const formData = new FormData();
        formData.set("workspaceId", workspaceId);
        formData.set("projectId", entry.projectId);
        formData.set("typeId", entry.typeId ?? "");
        formData.set("startAt", entry.startAt);
        formData.set("endAt", entry.endAt);
        formData.set("workingTimeMinutes", String(entry.workingTimeMinutes));
        formData.set("breakDurationMinutes", String(entry.breakDurationMinutes));
        formData.set("comment", entry.comment ?? "");
        formData.set("clientKey", entry.clientKey);
        let result;
        try {
          result = await createTimeEntryAction({ status: "idle" }, formData);
        } catch {
          break;
        }
        if (result.status === "success" || result.status === "invalid" || result.status === "not_found" || result.status === "denied") {
          await removeQueuedTimeCreate(entry.clientKey);
          if (result.status === "success") synced += 1;
        } else {
          break;
        }
      }
      await refreshPending();
      if (synced > 0) {
        setMessage(
          synced === 1
            ? "Ein Offline-Zeiteintrag wurde synchronisiert."
            : `${synced} Offline-Zeiteinträge wurden synchronisiert.`,
        );
        router.refresh();
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [canWrite, projectId, refreshPending, router, workspaceId]);

  useEffect(() => {
    const onOnline = () => {
      void syncNow();
    };
    window.addEventListener("online", onOnline);
    // Nach dem Laden einmal versuchen (z. B. Reload nach Offline-Phase);
    // offline listet der Sync nur (Badge), online replayt er.
    void syncNow();
    return () => window.removeEventListener("online", onOnline);
  }, [syncNow]);

  if (!canWrite || (pending.length === 0 && message === "")) return null;
  return (
    <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2" data-testid="time-outbox-sync">
      {pending.length > 0 ? (
        <p className="text-sm text-slate-700" data-testid="time-outbox-pending">
          {pending.length === 1
            ? "Ein Offline-Zeiteintrag wartet auf Synchronisierung."
            : `${pending.length} Offline-Zeiteinträge warten auf Synchronisierung.`}
        </p>
      ) : null}
      {message !== "" ? (
        <p role="status" className="text-sm font-medium text-green-700">{message}</p>
      ) : null}
      {pending.length > 0 ? (
        <button
          type="button"
          onClick={() => void syncNow()}
          disabled={syncing}
          className="mt-2 inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-slate-400"
        >
          {syncing ? "Wird synchronisiert …" : "Jetzt synchronisieren"}
        </button>
      ) : null}
    </div>
  );
}
