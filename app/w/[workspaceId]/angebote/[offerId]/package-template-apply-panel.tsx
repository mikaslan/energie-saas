"use client";

import { useActionState } from "react";
import { applyPackageTemplateEditorAction } from "../variant-actions";
import {
  APPLY_PACKAGE_TEMPLATE_INITIAL_STATE,
  type ApplyPackageTemplateEditorState,
} from "../variant-action-state";

export interface PackageTemplateEntry {
  id: string;
  name: string;
  lineCount: number;
}

function feedback(state: ApplyPackageTemplateEditorState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "success":
      return `Paket eingesetzt (${state.addedLines} ${state.addedLines === 1 ? "Position" : "Positionen"} übernommen`
        + `${state.removedLines > 0 ? `, ${state.removedLines} freie ${state.removedLines === 1 ? "Position" : "Positionen"} ersetzt` : ""}).`;
    case "not_found":
      return "Paket wurde nicht gefunden oder ist archiviert.";
    case "conflict":
      return "Variante wurde zwischenzeitlich geändert; Seite neu laden.";
    case "denied":
      return "Dafür fehlt dir die Angebots- oder Preis-Freigabe.";
    case "unauthenticated":
      return "Bitte erneut anmelden.";
    case "unavailable":
      return "Pakete sind aktuell nicht verfügbar.";
    default:
      return "Eingaben prüfen (Paket wählen).";
  }
}

// F16-11: Paket-Vorlage an einer Variante einsetzen (Custom-Ebene
// ersetzen, Katalog bleibt). Reine Client-Komponente: Server-Truth
// kommt aus dem Angebots-Detail. Eigene Strings (kein
// „Vorlage anwenden"-Selektor-Kollisionsraum mit F16-06).
export function PackageTemplateApplyPanel({
  workspaceId,
  offerId,
  variantId,
  expectedRevision,
  templates,
}: {
  workspaceId: string;
  offerId: string;
  variantId: string;
  expectedRevision: number;
  templates: readonly PackageTemplateEntry[];
}) {
  const [state, dispatch] = useActionState(
    applyPackageTemplateEditorAction,
    APPLY_PACKAGE_TEMPLATE_INITIAL_STATE,
  );
  const message = feedback(state);
  return (
    <section aria-labelledby="package-template-apply-title" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <h2 id="package-template-apply-title" className="text-base font-semibold text-slate-950">
        Paket einsetzen
      </h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        Ersetzt die freien Positionen der Variante durch das Paket;
        Katalog-Seed-Zeilen bleiben bestehen.
      </p>
      <form action={dispatch} className="mt-3 flex flex-wrap items-end gap-2">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="offerId" value={offerId} />
        <input type="hidden" name="variantId" value={variantId} />
        <input type="hidden" name="expectedRevision" value={String(expectedRevision)} />
        <label className="grid gap-1 text-sm font-medium text-slate-800">
          Paket wählen
          <select
            name="templateId"
            required
            defaultValue=""
            className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600"
          >
            <option value="" disabled>
              Paket wählen …
            </option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} ({template.lineCount} {template.lineCount === 1 ? "Position" : "Positionen"})
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          Paket einsetzen
        </button>
        {message ? (
          <p role={state.status === "success" ? "status" : "alert"} className="w-full text-sm text-slate-700">
            {message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
