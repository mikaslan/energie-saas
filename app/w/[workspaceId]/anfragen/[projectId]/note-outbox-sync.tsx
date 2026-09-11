"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PROJECT_NOTE_COMMAND_VERSION } from "@/lib/integrations/notes/note-contract";
import { changeProjectNote } from "./note-actions";
import {
  listQueuedNoteCreates,
  removeQueuedNoteCreate,
  type QueuedNoteCreate,
} from "./note-outbox";

// F11-03a: Replay wartender Offline-Notizen (desselben Projekts) über die
// normale Server-Action. Der clientKey macht Doppel-Syncs sicher
// (Replay-Guard); endgültige Antworten räumen die Outbox, Netzfehler
// behalten den Eintrag für den nächsten Versuch.
export function NoteOutboxSync({
  workspaceId,
  projectId,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<QueuedNoteCreate[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const syncingRef = useRef(false);

  const refreshPending = useCallback(async () => {
    try {
      const all = await listQueuedNoteCreates();
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
      const all = await listQueuedNoteCreates();
      const mine = all.filter(
        (entry) => entry.workspaceId === workspaceId && entry.projectId === projectId,
      );
      setPending(mine);
      let synced = 0;
      for (const entry of mine) {
        const formData = new FormData();
        formData.set("schemaVersion", PROJECT_NOTE_COMMAND_VERSION);
        formData.set("kind", "create_note");
        formData.set("projectId", entry.projectId);
        formData.set("textMarkdown", entry.textMarkdown);
        formData.set("pinned", entry.pinned ? "true" : "false");
        formData.set("clientKey", entry.clientKey);
        let result;
        try {
          result = await changeProjectNote(workspaceId, projectId, { status: "idle" }, formData);
        } catch {
          break;
        }
        if (result.status === "success" || result.status === "invalid" || result.status === "not_found" || result.status === "denied") {
          await removeQueuedNoteCreate(entry.clientKey);
          if (result.status === "success") synced += 1;
        } else {
          break;
        }
      }
      await refreshPending();
      if (synced > 0) {
        setMessage(
          synced === 1
            ? "Eine Offline-Notiz wurde synchronisiert."
            : `${synced} Offline-Notizen wurden synchronisiert.`,
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
    <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2" data-testid="note-outbox-sync">
      {pending.length > 0 ? (
        <p className="text-sm text-slate-700" data-testid="note-outbox-pending">
          {pending.length === 1
            ? "Eine Offline-Notiz wartet auf Synchronisierung."
            : `${pending.length} Offline-Notizen warten auf Synchronisierung.`}
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
