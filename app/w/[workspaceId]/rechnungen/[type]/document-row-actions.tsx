"use client";

import { useActionState, useRef, useState } from "react";
import { useModalDialog } from "../dialog-focus";
import {
  issueDocumentAction,
  sendDocumentAction,
  setDocumentArchivedAction,
  voidDocumentAction,
  type InvoicingUiActionState,
} from "../actions";
import { VOID_REASON_LABELS } from "../labels";
import type { CommercialDocumentV1 } from "@/lib/integrations/invoicing/contract";
import { commercialVoidReasons } from "@/lib/integrations/invoicing/contract";

const initialState: InvoicingUiActionState = { status: "idle" };

function errorText(state: InvoicingUiActionState): string | null {
  switch (state.status) {
    case "invalid": return "Die Eingabe ist ungültig.";
    case "not_found": return "Das Dokument wurde nicht gefunden.";
    case "conflict": return "Die Aktion ist im aktuellen Status nicht möglich.";
    case "precondition": return "Vorbedingungen sind nicht erfüllt.";
    case "denied": return "Dir fehlt die Berechtigung für diese Aktion.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen.";
    default: return null;
  }
}

const buttonClass =
  "inline-flex min-h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2";

function VoidDocumentDialog({
  workspaceId,
  documentId,
  onClose,
  triggerRef,
}: {
  workspaceId: string;
  documentId: string;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [state, dispatch] = useActionState(voidDocumentAction, initialState);
  const dialogRef = useModalDialog(onClose, triggerRef);
  // Schließen über Server-Wahrheit: bei Erfolg rendert der Dialog nichts mehr.
  if (state.status === "success") return null;
  const error = errorText(state);
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="void-dialog-title"
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4"
    >
      <form action={dispatch} className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
        <h2 id="void-dialog-title" className="text-lg font-semibold text-slate-950">
          Dokument stornieren
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Die Nummer bleibt verbrannt, der Inhalt wird eingefroren.
        </p>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="documentId" value={documentId} />
        <label className="mt-4 block">
          <span className="block text-sm font-semibold text-slate-800">Grund</span>
          <select
            name="reason"
            required
            defaultValue=""
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
          >
            <option value="" disabled>Bitte wählen</option>
            {commercialVoidReasons.map((reason) => (
              <option key={reason} value={reason}>{VOID_REASON_LABELS[reason]}</option>
            ))}
          </select>
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
            className={buttonClass}
          >
            Abbrechen
          </button>
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Endgültig stornieren
          </button>
        </div>
      </form>
    </div>
  );
}

export function DocumentRowActions({
  workspaceId,
  document,
  canWrite,
}: {
  workspaceId: string;
  document: CommercialDocumentV1;
  canWrite: boolean;
}) {
  const [issueState, issueDispatch] = useActionState(issueDocumentAction, initialState);
  const [sendState, sendDispatch] = useActionState(sendDocumentAction, initialState);
  const [archiveState, archiveDispatch] = useActionState(setDocumentArchivedAction, initialState);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidKey, setVoidKey] = useState(0);
  const voidTriggerRef = useRef<HTMLButtonElement | null>(null);

  const anyError = errorText(issueState) ?? errorText(sendState)
    ?? errorText(archiveState);

  // Viewer ohne Schreibrecht: keine Aktionsfläche (die Server-Action bleibt
  // die eigentliche Sicherheitsgrenze).
  if (!canWrite) return null;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {anyError ? (
        <span role="alert" className="text-xs font-semibold text-red-700">
          {anyError}
        </span>
      ) : null}

      {document.status === "draft" ? (
        <form action={issueDispatch} className="inline">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="documentId" value={document.id} />
          <button type="submit" className={buttonClass}>Ausstellen</button>
        </form>
      ) : null}

      {document.status === "issued" && document.sentAt === null ? (
        <form action={sendDispatch} className="inline">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="documentId" value={document.id} />
          <button type="submit" className={buttonClass}>Als versendet markieren</button>
        </form>
      ) : null}

      {/* Kimi-P2-5: Storno nur für ausgestellte Dokumente — Drafts lehnt der
          Service ab, der Button wäre eine garantierte Fehlerschleife. */}
      {document.status === "issued" ? (
        <button
          ref={voidTriggerRef}
          type="button"
          onClick={() => {
            setVoidOpen(true);
            setVoidKey((key) => key + 1);
          }}
          className={buttonClass}
        >
          Stornieren
        </button>
      ) : null}

      <form action={archiveDispatch} className="inline">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="documentId" value={document.id} />
        <input type="hidden" name="archived" value={document.archivedAt === null ? "true" : "false"} />
        <button type="submit" className={buttonClass}>
          {document.archivedAt === null ? "Archivieren" : "Archivierung aufheben"}
        </button>
      </form>

      {voidOpen ? (
        <VoidDocumentDialog
          key={voidKey}
          workspaceId={workspaceId}
          documentId={document.id}
          onClose={() => setVoidOpen(false)}
          triggerRef={voidTriggerRef}
        />
      ) : null}
    </div>
  );
}
