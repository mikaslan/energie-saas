"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ChecklistBlocksV1 } from "@/lib/integrations/checklists/contract";
import {
  planItemSync,
  type ItemOutboxEntry,
} from "@/lib/integrations/checklists/item-outbox";
import { saveProjectChecklistAction } from "./actions";
import {
  ITEM_OUTBOX_CHANGED_EVENT,
  listQueuedItemPatches,
  removeQueuedItemPatch,
} from "./item-outbox";

const MAX_SYNC_ROUNDS = 2;

async function listMine(
  workspaceId: string,
  projectId: string,
  checklistId: string,
): Promise<ItemOutboxEntry[]> {
  const all = await listQueuedItemPatches();
  return all.filter(
    (entry) =>
      entry.workspaceId === workspaceId
      && entry.projectId === projectId
      && entry.checklistId === checklistId,
  );
}

// F11-04: Replay wartender Offline-Haken/-Antworten (derselben Checkliste)
// als genau ein Whole-Tree-Save über dieselbe Server-Action. Basis ist
// immer das konsistente Paar Serverbaum + Serverversion aus den Props, nie
// ein Queue-alter Stand. Konflikte führen zu genau einer Revalidierung plus
// maximal einer zweiten Runde (Konvergenzschutz); Netzfehler behalten die
// Einträge, Ablehnungen räumen sie mit sichtbarer Meldung.
export function ItemOutboxSync({
  workspaceId,
  projectId,
  checklistId,
  phase,
  title,
  version,
  blocks,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  checklistId: string;
  phase: string;
  title: string;
  version: number;
  blocks: ChecklistBlocksV1;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<ItemOutboxEntry[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const syncingRef = useRef(false);
  const roundsRef = useRef(0);
  const inputRef = useRef({ version, blocks, phase, title });
  useEffect(() => {
    inputRef.current = { version, blocks, phase, title };
  });

  const refreshPending = useCallback(async () => {
    try {
      setPending(await listMine(workspaceId, projectId, checklistId));
    } catch {
      // Ohne IndexedDB keine Outbox-Anzeige (App bleibt nutzbar).
    }
  }, [checklistId, projectId, workspaceId]);

  const syncNow = useCallback(async () => {
    if (syncingRef.current || !canWrite) return;
    if (roundsRef.current >= MAX_SYNC_ROUNDS) return;
    syncingRef.current = true;
    try {
      const mine = await listMine(workspaceId, projectId, checklistId);
      setPending(mine);
      // Offline nur listen (Wartestand); der Replay läuft erst online.
      if (mine.length === 0 || navigator.onLine === false) return;
      setSyncing(true);
      roundsRef.current += 1;
      const current = inputRef.current;
      const plan = planItemSync(mine, current.blocks);
      const notes: string[] = [];
      for (const entry of [...plan.unchanged, ...plan.dropped.map((drop) => drop.entry)]) {
        await removeQueuedItemPatch(entry.checklistId, entry.itemId);
      }
      if (plan.dropped.some((drop) => drop.reason === "sealed")) {
        notes.push("Offline-Änderungen in einem abgeschlossenen Segment wurden verworfen (nichts überschrieben).");
      }
      if (plan.dropped.some((drop) => drop.reason !== "sealed")) {
        notes.push("Offline-Änderungen an nicht mehr vorhandenen oder verborgenen Punkten wurden verworfen.");
      }
      let synced = 0;
      let stalled = false;
      let needsRefresh = notes.length > 0;
      if (plan.blocks !== null) {
        const formData = new FormData();
        formData.set("workspaceId", workspaceId);
        formData.set("projectId", projectId);
        formData.set("checklistId", checklistId);
        formData.set("phase", current.phase);
        formData.set("title", current.title);
        formData.set("baseVersion", String(current.version));
        formData.set("blocks", JSON.stringify(plan.blocks));
        let result;
        try {
          result = await saveProjectChecklistAction({ status: "idle" }, formData);
        } catch {
          result = null;
        }
        if (result === null) {
          stalled = true;
        } else if (result.status === "success") {
          for (const entry of plan.applied) await removeQueuedItemPatch(entry.checklistId, entry.itemId);
          synced = plan.applied.length;
          needsRefresh = true;
        } else if (
          result.status === "invalid"
          || result.status === "not_found"
          || result.status === "denied"
        ) {
          for (const entry of plan.applied) await removeQueuedItemPatch(entry.checklistId, entry.itemId);
          needsRefresh = true;
          notes.push("Offline-Änderungen waren online nicht mehr zulässig und wurden verworfen.");
        } else {
          // conflict → Revalidierung + zweite Runde; alles andere (error,
          // unauthenticated) behält die Einträge für einen späteren Versuch.
          needsRefresh = result.status === "conflict";
          stalled = true;
        }
      }
      if (stalled && notes.length === 0) {
        notes.push("Offline-Änderungen konnten nicht synchronisiert werden (erneut versuchen).");
      }
      await refreshPending();
      if (synced > 0) {
        notes.unshift(
          synced === 1
            ? "Eine Offline-Änderung wurde synchronisiert."
            : `${synced} Offline-Änderungen wurden synchronisiert.`,
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
    // bei Versionswechsel höchstens die zweite Konvergenzrunde. Ohne
    // IndexedDB scheitert der Sync still (App bleibt nutzbar).
    void syncNow().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(() => {
    const onOnline = () => {
      roundsRef.current = 0;
      void syncNow().catch(() => undefined);
    };
    // Wartestand sofort nach dem Offline-Speichern aktualisieren.
    const onChanged = () => {
      void refreshPending();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener(ITEM_OUTBOX_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener(ITEM_OUTBOX_CHANGED_EVENT, onChanged);
    };
  }, [refreshPending, syncNow]);

  if (!canWrite || (pending.length === 0 && message === "")) return null;
  return (
    <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2" data-testid="item-outbox-sync">
      {pending.length > 0 ? (
        <p className="text-sm text-slate-700" data-testid="item-outbox-pending">
          {pending.length === 1
            ? "Eine Offline-Änderung wartet auf Synchronisierung."
            : `${pending.length} Offline-Änderungen warten auf Synchronisierung.`}
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
            void syncNow().catch(() => undefined);
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
