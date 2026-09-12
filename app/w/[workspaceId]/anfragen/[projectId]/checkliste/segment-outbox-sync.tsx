"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  planSegmentSync,
  type SegmentOutboxEntry,
  type SegmentSyncState,
} from "@/lib/integrations/checklists/segment-outbox";
import { mutateChecklistSegmentAction } from "./actions";
import {
  listQueuedSegmentCompletes,
  removeQueuedSegmentComplete,
  SEGMENT_OUTBOX_CHANGED_EVENT,
} from "./segment-outbox";

const MAX_SYNC_ROUNDS = 2;

// F7-04c: Replay wartender Offline-Abschlüsse (derselben Checkliste) über
// dieselbe Server-Action. Bereits abgeschlossene Segmente werden nie
// angefasst; Konflikte führen zu genau einer Revalidierung plus maximal
// einer zweiten Runde (Konvergenzschutz); Netzfehler behalten den Eintrag.
export function SegmentOutboxSync({
  workspaceId,
  projectId,
  checklistId,
  version,
  segments,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  checklistId: string;
  version: number;
  segments: readonly SegmentSyncState[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<SegmentOutboxEntry[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const syncingRef = useRef(false);
  const roundsRef = useRef(0);
  const inputRef = useRef({ version, segments });
  useEffect(() => {
    inputRef.current = { version, segments };
  });
  const fingerprint = JSON.stringify({
    version,
    states: segments.map((segment) => [segment.segmentId, segment.completedAt]),
  });

  const refreshPending = useCallback(async () => {
    try {
      const all = await listQueuedSegmentCompletes();
      setPending(all.filter(
        (entry) =>
          entry.workspaceId === workspaceId
          && entry.projectId === projectId
          && entry.checklistId === checklistId,
      ));
    } catch {
      // Ohne IndexedDB keine Outbox-Anzeige (App bleibt nutzbar).
    }
  }, [checklistId, projectId, workspaceId]);

  const syncNow = useCallback(async () => {
    if (syncingRef.current || !canWrite) return;
    if (roundsRef.current >= MAX_SYNC_ROUNDS) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const all = await listQueuedSegmentCompletes();
      const mine = all.filter(
        (entry) =>
          entry.workspaceId === workspaceId
          && entry.projectId === projectId
          && entry.checklistId === checklistId,
      );
      setPending(mine);
      if (mine.length === 0) return;
      roundsRef.current += 1;
      const { version: currentVersion, segments: currentSegments } = inputRef.current;
      const plan = planSegmentSync(mine, currentSegments, currentVersion);
      const notes: string[] = [];
      for (const entry of [...plan.missing, ...plan.alreadyDone]) {
        await removeQueuedSegmentComplete(entry.checklistId, entry.segmentId);
      }
      if (plan.missing.length > 0) notes.push("Nicht mehr vorhandene Abschlüsse wurden verworfen.");
      if (plan.alreadyDone.length > 0) {
        notes.push(
          plan.alreadyDone.length === 1
            ? "Ein Segment war bereits abgeschlossen und blieb unangetastet."
            : `${plan.alreadyDone.length} Segmente waren bereits abgeschlossen und blieben unangetastet.`,
        );
      }
      let synced = 0;
      let stalled = false;
      let needsRefresh = notes.length > 0;
      for (const { entry } of plan.replay) {
        const formData = new FormData();
        formData.set("workspaceId", entry.workspaceId);
        formData.set("projectId", entry.projectId);
        formData.set("checklistId", entry.checklistId);
        formData.set("segmentId", entry.segmentId);
        formData.set("baseVersion", String(currentVersion));
        formData.set("operation", "complete");
        let result;
        try {
          result = await mutateChecklistSegmentAction({ status: "idle" }, formData);
        } catch {
          break;
        }
        if (result.status === "success") {
          await removeQueuedSegmentComplete(entry.checklistId, entry.segmentId);
          synced += 1;
          needsRefresh = true;
        } else if (
          result.status === "incomplete"
          || result.status === "invalid"
          || result.status === "not_found"
          || result.status === "denied"
        ) {
          await removeQueuedSegmentComplete(entry.checklistId, entry.segmentId);
          needsRefresh = true;
          notes.push("Ein Abschluss war online nicht mehr möglich und wurde verworfen.");
        } else if (result.status === "state") {
          // Defensiv: Segmentzustand meldet completed/hidden → Evidenz
          // behalten, Eintrag räumen (kein Overwrite).
          await removeQueuedSegmentComplete(entry.checklistId, entry.segmentId);
          needsRefresh = true;
          notes.push("Ein Segment war bereits abgeschlossen und blieb unangetastet.");
        } else if (result.status === "conflict") {
          needsRefresh = true;
          stalled = true;
          break;
        } else {
          stalled = true;
          break;
        }
      }
      if (stalled && synced === 0 && notes.length === 0) {
        notes.push("Ein Offline-Abschluss konnte nicht synchronisiert werden (erneut versuchen).");
      }
      await refreshPending();
      if (synced > 0) {
        notes.unshift(
          synced === 1
            ? "Ein Offline-Abschluss wurde synchronisiert."
            : `${synced} Offline-Abschlüsse wurden synchronisiert.`,
        );
      }
      if (notes.length > 0) setMessage(notes.join(" "));
      if (needsRefresh) router.refresh();
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [canWrite, checklistId, projectId, refreshPending, router, workspaceId]);

  useEffect(() => {
    roundsRef.current = 0;
    // Nach dem Laden einmal versuchen (z. B. Reload nach Offline-Phase);
    // offline listet der Sync nur (Badge), online replayt er. Bei
    // Stand-Wechsel (Fingerprint) höchstens die zweite Konvergenzrunde.
    void syncNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  useEffect(() => {
    const onOnline = () => {
      roundsRef.current = 0;
      void syncNow();
    };
    // Badge sofort nach Enqueue aktualisieren (Sync läuft nur online).
    const onChanged = () => {
      void refreshPending();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener(SEGMENT_OUTBOX_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener(SEGMENT_OUTBOX_CHANGED_EVENT, onChanged);
    };
  }, [refreshPending, syncNow]);

  if (!canWrite || (pending.length === 0 && message === "")) return null;
  return (
    <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2" data-testid="segment-outbox-sync">
      {pending.length > 0 ? (
        <p className="text-sm text-slate-700" data-testid="segment-outbox-pending">
          {pending.length === 1
            ? "Ein Offline-Abschluss wartet auf Synchronisierung."
            : `${pending.length} Offline-Abschlüsse warten auf Synchronisierung.`}
        </p>
      ) : null}
      {message !== "" ? (
        <p role="status" className="text-sm font-medium text-green-700">{message}</p>
      ) : null}
      {pending.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            roundsRef.current = 0;
            void syncNow();
          }}
          disabled={syncing}
          className="mt-2 inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-slate-400"
        >
          {syncing ? "Wird synchronisiert …" : "Jetzt synchronisieren"}
        </button>
      ) : null}
    </div>
  );
}
