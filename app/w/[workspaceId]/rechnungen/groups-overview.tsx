"use client";

import { useActionState, useRef, useState } from "react";
import { useModalDialog } from "./dialog-focus";
import {
  createInvoicingGroupAction,
  setDocumentGroupArchivedAction,
  type InvoicingUiActionState,
} from "./actions";
import type { CommercialDocumentGroupV1 } from "@/lib/integrations/invoicing/contract";

const initialState: InvoicingUiActionState = { status: "idle" };

function GroupCreateDialog({
  workspaceId,
  onClose,
  triggerRef,
}: {
  workspaceId: string;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [state, dispatch] = useActionState(createInvoicingGroupAction, initialState);
  const dialogRef = useModalDialog(onClose, triggerRef);
  // Schließen über Server-Wahrheit: bei Erfolg rendert die Dialog-Komponente
  // nichts mehr (kein setState im Effect).
  if (state.status === "success") return null;
  const error = errorText(state);
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-dialog-title"
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4"
    >
      <form
        action={dispatch}
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-lg"
      >
        <h2 id="group-dialog-title" className="text-lg font-semibold text-slate-950">
          Neue Gruppe
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Name der Gruppe für die Dokumentübersicht.
        </p>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <label className="mt-4 block">
          <span className="block text-sm font-semibold text-slate-800">Name</span>
          <input
            type="text"
            name="name"
            required
            maxLength={120}
            autoFocus
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
          />
        </label>
        {error ? (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Abbrechen
          </button>
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Anlegen
          </button>
        </div>
      </form>
    </div>
  );
}

function errorText(state: InvoicingUiActionState): string | null {
  switch (state.status) {
    case "invalid": return "Die Eingabe ist ungültig.";
    case "not_found": return "Die Gruppe wurde nicht gefunden.";
    case "conflict": return "Der Name ist in diesem Workspace bereits vergeben.";
    case "precondition": return "Vorbedingungen sind nicht erfüllt.";
    case "denied": return "Dir fehlt die Berechtigung für diese Aktion.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen.";
    default: return null;
  }
}

export function GroupsOverview({
  groups,
  workspaceId,
  canWrite,
}: {
  groups: CommercialDocumentGroupV1[];
  workspaceId: string;
  canWrite: boolean;
}) {
  const [archiveState, archiveDispatch] = useActionState(
    setDocumentGroupArchivedAction,
    initialState,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const newGroupTriggerRef = useRef<HTMLButtonElement | null>(null);
  const archiveError = errorText(archiveState);

  return (
    <section aria-label="Dokumentgruppen" className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-950">Gruppen</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Dokumente in Gruppen ordnen. Neue Dokumente entstehen je Typ im
            jeweiligen Tab.
          </p>
        </div>
        {canWrite ? (
          <button
            ref={newGroupTriggerRef}
            type="button"
            onClick={() => {
              setDialogOpen(true);
              setDialogKey((key) => key + 1);
            }}
            className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Neue Gruppe
          </button>
        ) : (
          <span className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">
            Nur Lesezugriff
          </span>
        )}
      </div>

      {archiveError ? (
        <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {archiveError}
        </p>
      ) : null}

      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-600">
          Keine Einträge
        </p>
      ) : (
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            {groups.length} {groups.length === 1 ? "Gruppe" : "Gruppen"} mit
            Dokumentanzahl und Archivstatus
          </caption>
          <thead>
            <tr className="border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th scope="col" className="px-3 py-3">Name</th>
              <th scope="col" className="px-3 py-3 text-right">Dokumente</th>
              <th scope="col" className="px-3 py-3 text-right">Aktionen</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group.id} className="border-b border-slate-100 last:border-b-0">
                <td className="px-3 py-3 text-sm font-medium text-slate-900">
                  {group.name}
                  {group.archivedAt !== null ? (
                    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                      Archiviert
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-3 text-right text-sm tabular-nums text-slate-700">
                  {group.documentCount}
                </td>
                <td className="px-3 py-3 text-right">
                  {canWrite ? (
                  <form action={archiveDispatch} className="inline">
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="groupId" value={group.id} />
                    <input
                      type="hidden"
                      name="archived"
                      value={group.archivedAt === null ? "true" : "false"}
                    />
                    <button
                      type="submit"
                      className="inline-flex min-h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                    >
                      {group.archivedAt === null ? "Archivieren" : "Archivierung aufheben"}
                    </button>
                  </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {dialogOpen ? (
        <GroupCreateDialog
          key={dialogKey}
          workspaceId={workspaceId}
          onClose={() => setDialogOpen(false)}
          triggerRef={newGroupTriggerRef}
        />
      ) : null}
    </section>
  );
}
