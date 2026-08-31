"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import {
  CATALOG_IMPORT_RIGHTS_ATTESTATION_TEXT,
  type CatalogImportJobState,
} from "@/lib/integrations/catalog/import-wire";
import {
  cancelCatalogImportAction,
  startCatalogImportAction,
  type CatalogImportActionState,
} from "./actions";
import {
  INITIAL_CATALOG_IMPORT_ACTION_STATE,
  selectCatalogImportActionState,
  type CatalogImportControlOperation,
} from "./import-control-state";

function feedback(state: CatalogImportActionState): string {
  switch (state.status) {
    case "idle": return "";
    case "success": return state.state === "cancelled_before_start"
      ? "Die Vorschau wurde abgebrochen."
      : state.replayed ? "Der bestehende Importstatus wurde erneut bestätigt." : "Der Import wurde in die Verarbeitung gegeben.";
    case "invalid": return "Bestätige die Datenberechtigung, bevor du den Import startest.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen. Melde dich erneut an.";
    case "denied": return "Dir fehlen Rechte für Produkt-, EK- oder VK-Daten.";
    case "not_found": return "Der Import wurde nicht gefunden.";
    case "conflict": return "Der Importstatus hat sich geändert. Lade die Seite neu.";
    case "expired": return "Die Vorschau ist abgelaufen und wurde sicher abgebrochen.";
    case "unavailable": return "Der Importdienst ist vorübergehend nicht verfügbar.";
  }
}

function isErrorState(state: CatalogImportActionState): boolean {
  return !["idle", "success"].includes(state.status);
}

export function ImportControls({
  workspaceId,
  importId,
  importState,
  validCount,
}: {
  workspaceId: string;
  importId: string;
  importState: CatalogImportJobState;
  validCount: number;
}) {
  const [startState, startAction, startPending] = useActionState(
    startCatalogImportAction,
    INITIAL_CATALOG_IMPORT_ACTION_STATE,
  );
  const [cancelState, cancelAction, cancelPending] = useActionState(
    cancelCatalogImportAction,
    INITIAL_CATALOG_IMPORT_ACTION_STATE,
  );
  const [lastOperation, setLastOperation] = useState<CatalogImportControlOperation | null>(null);
  const activeState = selectCatalogImportActionState({
    lastOperation,
    startState,
    cancelState,
    startPending,
    cancelPending,
  });
  const message = activeState.status === "success" && activeState.state !== importState
    ? ""
    : feedback(activeState);
  const isError = isErrorState(activeState);
  const feedbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (message) feedbackRef.current?.focus();
  }, [activeState, message]);

  if (importState !== "ready_for_review") {
    return message ? (
      <div ref={feedbackRef} tabIndex={-1} role={isError ? "alert" : "status"} aria-live={isError ? "assertive" : "polite"} className={isError ? "rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-950" : "rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950"}>{message}</div>
    ) : null;
  }

  return (
    <section aria-labelledby="catalog-import-control-title" className="rounded-lg border border-blue-200 bg-blue-50 p-5 sm:p-6">
      <h2 id="catalog-import-control-title" className="text-lg font-semibold text-blue-950">Importentscheidung</h2>
      <p className="mt-2 text-sm leading-6 text-blue-950">
        Der Start erzeugt oder revidiert ausschließlich Entwürfe. Importierte
        Produkte werden nicht automatisch aktiviert. {validCount === 0
          ? "Diese Vorschau enthält keine startfähige Zeile."
          : `${validCount.toLocaleString("de-DE")} valide Zeilen sind startfähig.`}
      </p>

      {validCount > 0 ? (
        <form action={startAction} onSubmit={() => setLastOperation("start")} className="mt-5 grid gap-4">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="importId" value={importId} />
          <label className="flex items-start gap-3 rounded-md border border-blue-300 bg-white p-4 text-sm leading-6 text-slate-800">
            <input type="checkbox" name="rightsAttested" value="yes" required disabled={startPending || cancelPending} className="mt-1 size-4 shrink-0 accent-blue-700" />
            <span>{CATALOG_IMPORT_RIGHTS_ATTESTATION_TEXT}</span>
          </label>
          <button type="submit" aria-disabled={startPending || cancelPending || undefined} disabled={startPending || cancelPending} className="min-h-11 w-full rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-500 sm:w-fit">
            {startPending ? "Import wird gestartet …" : "Import starten"}
          </button>
        </form>
      ) : null}

      <form action={cancelAction} onSubmit={() => setLastOperation("cancel")} className="mt-4">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="importId" value={importId} />
        <button type="submit" aria-disabled={startPending || cancelPending || undefined} disabled={startPending || cancelPending} className="min-h-11 rounded-md border border-slate-400 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-slate-500">
          {cancelPending ? "Import wird abgebrochen …" : "Import abbrechen"}
        </button>
      </form>

      {message ? (
        <div ref={feedbackRef} tabIndex={-1} role={isError ? "alert" : "status"} aria-live={isError ? "assertive" : "polite"} className={isError ? "mt-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-950 outline-none" : "mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-950 outline-none"}>
          {message}
        </div>
      ) : null}
    </section>
  );
}
