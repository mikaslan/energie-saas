"use client";

import { useActionState, useRef, useState } from "react";
import { useModalDialog } from "../dialog-focus";
import { createDocumentAction, type InvoicingUiActionState } from "../actions";
import { DOCUMENT_TYPE_SINGULAR_LABELS } from "../labels";
import type {
  CommercialDocumentGroupV1,
  CommercialDocumentType,
} from "@/lib/integrations/invoicing/contract";

const initialState: InvoicingUiActionState = { status: "idle" };

function errorText(state: InvoicingUiActionState): string | null {
  switch (state.status) {
    case "invalid": return "Bitte alle Pflichtfelder korrekt ausfüllen.";
    case "not_found": return "Die gewählte Gruppe wurde nicht gefunden.";
    case "conflict": return "Die Aktion steht im Konflikt mit dem aktuellen Stand.";
    case "precondition": return "Ausstellungsdetails fehlen: Bitte zuerst die Rechnungsstellung einrichten.";
    case "denied": return "Dir fehlt die Berechtigung für diese Aktion.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen.";
    default: return null;
  }
}

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30";

function CreateDocumentForm({
  workspaceId,
  type,
  groups,
  onClose,
  triggerRef,
}: {
  workspaceId: string;
  type: CommercialDocumentType;
  groups: CommercialDocumentGroupV1[];
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [state, dispatch] = useActionState(createDocumentAction, initialState);
  const dialogRef = useModalDialog(onClose, triggerRef);
  // Schließen über Server-Wahrheit: bei Erfolg rendert die Form nichts mehr.
  if (state.status === "success") return null;
  const error = errorText(state);
  // Kimi-P3-6: Zahlungsachse existiert für alle Typen außer letter.
  const hasPaymentAxis = type !== "letter";
  const label = DOCUMENT_TYPE_SINGULAR_LABELS[type];

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-document-title"
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4"
    >
      <form action={dispatch} className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
        <h2 id="create-document-title" className="text-lg font-semibold text-slate-950">
          {label} anlegen
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Als Entwurf angelegt — ausstellen, sobald die Inhalte vollständig sind.
        </p>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="type" value={type} />

        <label className="mt-4 block">
          <span className="block text-sm font-semibold text-slate-800">Name</span>
          <input type="text" name="name" required maxLength={160} autoFocus className={inputClass} />
        </label>

        <label className="mt-4 block">
          <span className="block text-sm font-semibold text-slate-800">Gruppe</span>
          <select name="groupId" defaultValue="" className={inputClass}>
            <option value="">Keine Gruppe</option>
            {groups
              .filter((group) => group.archivedAt === null)
              .map((group) => (
                <option key={group.id} value={group.id}>{group.name}</option>
              ))}
          </select>
        </label>

        {type === "invoice" ? (
          <label className="mt-4 block">
            <span className="block text-sm font-semibold text-slate-800">Fällig am</span>
            <input type="date" name="dueDate" required className={inputClass} />
          </label>
        ) : null}

        {type === "credit_note" ? (
          <>
            <label className="mt-4 block">
              <span className="block text-sm font-semibold text-slate-800">Lieferdatum</span>
              <input type="date" name="deliveryDate" required className={inputClass} />
            </label>
            <label className="mt-4 block">
              <span className="block text-sm font-semibold text-slate-800">Grund</span>
              <select name="creditNoteType" required defaultValue="" className={inputClass}>
                <option value="" disabled>Bitte wählen</option>
                <option value="minderleistung">Minderleistung</option>
                <option value="empfehlungspraemie">Empfehlungsprämie</option>
              </select>
            </label>
          </>
        ) : null}

        {type === "order_confirmation" ? (
          <>
            <label className="mt-4 block">
              <span className="block text-sm font-semibold text-slate-800">Geplantes Lieferdatum</span>
              <input type="date" name="plannedDeliveryDate" required className={inputClass} />
            </label>
            <label className="mt-4 block">
              <span className="block text-sm font-semibold text-slate-800">Geplantes Leistungsdatum</span>
              <input type="date" name="plannedServiceDate" required className={inputClass} />
            </label>
          </>
        ) : null}

        {type === "purchase_order" || type === "letter" ? (
          <label className="mt-4 block">
            <span className="block text-sm font-semibold text-slate-800">Gültig bis</span>
            <input type="date" name="validityDate" required className={inputClass} />
          </label>
        ) : null}

        {type === "delivery_note" ? (
          <label className="mt-4 block">
            <span className="block text-sm font-semibold text-slate-800">Lieferdatum</span>
            <input type="date" name="deliveryDate" required className={inputClass} />
          </label>
        ) : null}

        {hasPaymentAxis ? (
          <p className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
            Positionen werden in einem späteren Schritt ergänzt — der
            Entwurf startet mit 0,00 €.
          </p>
        ) : null}

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
            Als Entwurf anlegen
          </button>
        </div>
      </form>
    </div>
  );
}

export function CreateDocumentDialog({
  workspaceId,
  type,
  groups,
}: {
  workspaceId: string;
  type: CommercialDocumentType;
  groups: CommercialDocumentGroupV1[];
}) {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const label = DOCUMENT_TYPE_SINGULAR_LABELS[type];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setOpen(true);
          setFormKey((key) => key + 1);
        }}
        className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
      >
        {label} anlegen
      </button>

      {open ? (
        <CreateDocumentForm
          key={formKey}
          workspaceId={workspaceId}
          type={type}
          groups={groups}
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
        />
      ) : null}
    </>
  );
}
