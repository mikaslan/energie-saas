"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  createManualLeadAction,
  type ManualLeadActionState,
} from "./manual-lead-actions";

const initialState: ManualLeadActionState = { status: "idle" };

const inputClass =
  "min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600";
const labelClass = "grid gap-1 text-sm font-medium text-slate-700";

function Feedback({ state }: { state: ManualLeadActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") return null;
  const tone = "border-amber-300 bg-amber-50 text-amber-900";
  const message =
    state.status === "invalid"
      ? "Bitte prüfen: Name sowie E-Mail oder Telefon sind Pflicht (PLZ fünfstellig)."
      : state.status === "lane-missing"
        ? "Für diesen Bereich ist keine Eingangs-Spalte verfügbar."
        : state.status === "denied"
          ? "Keine Berechtigung zum Anlegen."
          : "Bitte erneut anmelden.";
  return (
    <p role="alert" className={`rounded-md border px-3 py-2 text-sm ${tone}`}>
      {message}
    </p>
  );
}

/**
 * F1-11 · Manuelle Anfrage-Erfassung (Editoren). Legt Kontakt + Standort +
 * Projekt auf der Intake-Spalte des aktuellen Bereichs an.
 */
export function ManualLeadForm({
  workspaceId,
  scope,
  scopeLabel,
  sources,
}: {
  workspaceId: string;
  scope: "residential" | "commercial";
  scopeLabel: string;
  sources: Array<{ id: string; name: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useActionState(
    createManualLeadAction.bind(null, workspaceId),
    initialState,
  );

  if (state.status === "success") {
    return (
      <p role="status" data-testid="manual-lead-success" className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        Anfrage angelegt
        {state.contactReused ? " (bestehender Kontakt, Prüfung ausstehend)" : ""}
        {" — "}
        <Link
          href={`/w/${workspaceId}/anfragen/${state.projectId}`}
          className="font-semibold underline underline-offset-2"
        >
          Projektakte öffnen
        </Link>
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="manual-lead-open"
        className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
      >
        Anfrage manuell erfassen
      </button>
    );
  }

  return (
    <form
      action={dispatch}
      data-testid="manual-lead-form"
      className="grid max-w-2xl gap-3 rounded-lg border border-slate-200 bg-white p-4"
    >
      <input type="hidden" name="scope" value={scope} />
      <p className="text-sm text-slate-600">
        {`Neue Anfrage im Bereich ${scopeLabel} — Name sowie E-Mail oder Telefon sind Pflicht.`}
      </p>
      <label className={labelClass}>
        Name *
        <input name="displayName" required maxLength={200} autoComplete="off" className={inputClass} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          E-Mail
          <input name="email" type="email" maxLength={200} autoComplete="off" className={inputClass} />
        </label>
        <label className={labelClass}>
          Telefon
          <input name="phone" type="tel" maxLength={40} autoComplete="off" className={inputClass} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Straße
          <input name="street" maxLength={200} autoComplete="off" className={inputClass} />
        </label>
        <label className={labelClass}>
          Hausnummer
          <input name="houseNumber" maxLength={30} autoComplete="off" className={inputClass} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          PLZ
          <input name="postalCode" inputMode="numeric" maxLength={10} autoComplete="off" className={inputClass} />
        </label>
        <label className={labelClass}>
          Ort
          <input name="city" maxLength={200} autoComplete="off" className={inputClass} />
        </label>
      </div>
      <label className={labelClass}>
        Lead-Quelle (optional)
        <select name="leadSourceId" defaultValue="" className={inputClass}>
          <option value="">Keine Quelle</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Notiz (optional)
        <textarea name="note" rows={2} maxLength={2000} className={inputClass} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Anfrage anlegen
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50"
        >
          Abbrechen
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
