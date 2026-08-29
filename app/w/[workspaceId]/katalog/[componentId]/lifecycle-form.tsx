"use client";

import { useActionState } from "react";
import type { CatalogComponentStatus } from "@/lib/integrations/catalog/contract";
import {
  changeCatalogLifecycleAction,
  type CatalogActionState,
} from "../actions";

function textFor(state: CatalogActionState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "success") return `Status wurde auf ${state.componentStatus} gesetzt.`;
  if (state.status === "conflict") return "Der Status hat sich geändert. Lade die Seite neu.";
  if (state.status === "state_error" && state.code === "active_requires_pricing") {
    return "Aktivieren ist erst mit vollständigem EK, VK und Quellen möglich.";
  }
  if (state.status === "denied") return "Dir fehlt die Berechtigung für den Lifecycle.";
  return "Der Status konnte nicht sicher geändert werden.";
}

export function LifecycleForm({
  workspaceId,
  componentId,
  revision,
  status,
  hasPricing,
}: {
  workspaceId: string;
  componentId: string;
  revision: number;
  status: CatalogComponentStatus;
  hasPricing: boolean;
}) {
  const [state, action, pending] = useActionState(
    changeCatalogLifecycleAction,
    { status: "idle" } satisfies CatalogActionState,
  );
  const message = textFor(state);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="componentId" value={componentId} />
      <input type="hidden" name="expectedRevision" value={revision} />
      <input type="hidden" name="expectedStatus" value={status} />
      {message ? (
        <p role={state.status === "success" ? "status" : "alert"} aria-live="polite" className={state.status === "success" ? "rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-950" : "rounded-md bg-red-50 px-3 py-2 text-sm text-red-900"}>
          {message}
        </p>
      ) : null}
      {status === "draft" ? (
        <>
          <button name="operation" value="activate" type="submit" disabled={pending || !hasPricing} className="min-h-11 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
            Aktivieren
          </button>
          {!hasPricing ? <p className="text-xs leading-5 text-amber-800">Erfasse zuerst einen vollständigen Preisstand.</p> : null}
          <button name="operation" value="archive" type="submit" disabled={pending} className="min-h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:opacity-50">
            Entwurf archivieren
          </button>
        </>
      ) : status === "active" ? (
        <button name="operation" value="archive" type="submit" disabled={pending} className="min-h-11 rounded-md border border-red-300 bg-white px-4 text-sm font-semibold text-red-800 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:opacity-50">
          Produkt archivieren
        </button>
      ) : (
        <button name="operation" value="return_to_draft" type="submit" disabled={pending} className="min-h-11 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:opacity-50">
          Zurück in Entwurf
        </button>
      )}
    </form>
  );
}
