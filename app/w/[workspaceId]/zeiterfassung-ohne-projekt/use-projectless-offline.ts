"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createTimeEntryAction } from "../anfragen/[projectId]/zeiterfassung/actions";
import {
  enqueueProjectlessTimeCreate,
  listQueuedProjectlessTimeCreates,
  removeQueuedProjectlessTimeCreate,
  type QueuedProjectlessTimeCreate,
} from "./projectless-outbox";

// F9-15 R1c: Offline-Anlage projektlos (Muster time-outbox-sync.tsx +
// submitCreate). Der Lead verdrahtet den Hook im Manager (createDispatch =
// useActionState-Dispatch, Formular onSubmit). Replay postet an
// createTimeEntryAction OHNE projectId-Feld → F9-14-parater projektloser
// Pfad; der clientKey macht Doppel-Syncs sicher (Replay-Guard).
// Endgültige Antworten räumen die Outbox, Netzfehler behalten den Eintrag
// für den nächsten Versuch. Kein Timer-offline.
export type ProjectlessSyncState = {
  syncing: boolean;
  queueing: boolean;
  // Erfolgsmeldung nach Replay (Projektseiten-Wortlaut).
  message: string;
  // Hinweis nach Offline-Speichern (Projektseiten-Wortlaut).
  notice: string;
  queueError: boolean;
  syncNow: () => Promise<void>;
};

export function useProjectlessOffline({
  workspaceId,
  canWrite,
  createDispatch,
}: {
  workspaceId: string;
  canWrite: boolean;
  createDispatch: (formData: FormData) => void;
}): {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pendingCount: number;
  syncState: ProjectlessSyncState;
} {
  const router = useRouter();
  const [pending, setPending] = useState<QueuedProjectlessTimeCreate[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [queueError, setQueueError] = useState(false);
  const syncingRef = useRef(false);
  const [, startCreateTransition] = useTransition();

  const refreshPending = useCallback(async () => {
    try {
      const all = await listQueuedProjectlessTimeCreates();
      setPending(all.filter((entry) => entry.workspaceId === workspaceId));
    } catch {
      // Ohne IndexedDB keine Outbox-Anzeige (App bleibt nutzbar).
    }
  }, [workspaceId]);

  const syncNow = useCallback(async () => {
    if (syncingRef.current || !canWrite) return;
    syncingRef.current = true;
    setSyncing(true);
    setMessage("");
    try {
      const all = await listQueuedProjectlessTimeCreates();
      const mine = all.filter((entry) => entry.workspaceId === workspaceId);
      setPending(mine);
      let synced = 0;
      for (const entry of mine) {
        // KEIN projectId-Feld: fehlend = projektlos (F9-14
        // parseOptionalProjectId), nie raten.
        const formData = new FormData();
        formData.set("workspaceId", workspaceId);
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
          await removeQueuedProjectlessTimeCreate(entry.clientKey);
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
  }, [canWrite, refreshPending, router, workspaceId]);

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

  const onSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    // Online: Idempotenz-Schlüssel je Absendung mitgeben (Replay-Guard).
    if (typeof navigator === "undefined" || navigator.onLine) {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      formData.set("clientKey", crypto.randomUUID());
      startCreateTransition(() => {
        createDispatch(formData);
      });
      return;
    }
    // Offline: Entwurf in die Outbox statt Fehlschlag. Nur Anlage
    // (Stoppuhr braucht den Server-Stand).
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string): string => {
      const value = data.get(name);
      return typeof value === "string" ? value : "";
    };
    const startAt = text("startAt");
    const endAt = text("endAt");
    const workingTimeMinutes = Number(text("workingTimeMinutes"));
    const breakDurationMinutes = Number(text("breakDurationMinutes"));
    const rawComment = text("comment").trim();
    const form = event.currentTarget;
    setQueueing(true);
    setQueueError(false);
    setNotice("");
    void enqueueProjectlessTimeCreate({
      clientKey: crypto.randomUUID(),
      workspaceId,
      projectId: null,
      typeId: text("typeId") === "" ? null : text("typeId"),
      startAt,
      endAt,
      workingTimeMinutes,
      breakDurationMinutes,
      comment: rawComment === "" ? null : text("comment"),
      queuedAt: new Date().toISOString(),
    }).then(
      () => {
        setNotice("Offline gespeichert. Der Zeiteintrag wird synchronisiert, sobald du wieder online bist.");
        form.reset();
        void refreshPending();
        setQueueing(false);
      },
      () => {
        setQueueError(true);
        setQueueing(false);
      },
    );
  }, [createDispatch, refreshPending, workspaceId]);

  return {
    onSubmit,
    pendingCount: pending.length,
    syncState: { syncing, queueing, message, notice, queueError, syncNow },
  };
}
