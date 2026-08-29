"use client";

import { useActionState, useEffect, useRef } from "react";
import {
  confirmProjectEnergyProfileAction,
  type ConfirmProjectEnergyProfileState,
} from "../energy-actions";

const initialState: ConfirmProjectEnergyProfileState = { status: "idle" };

function messageFor(state: ConfirmProjectEnergyProfileState): string {
  switch (state.status) {
    case "success":
      return state.replayed
        ? "Diese Profilrevision war bereits bestätigt. Der vorhandene Rechenauftrag bleibt bestehen."
        : "Die sichtbaren Eingaben wurden bestätigt. Die Planungsrechnung wurde eingereiht.";
    case "invalid":
      return "Die Bestätigung ist ungültig. Bitte lade die Seite neu.";
    case "unauthenticated":
      return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu und melde dich erneut an.";
    case "denied":
      return "Für die Bestätigung fehlt dir die Berechtigung.";
    case "stale":
      return "Adresse oder Profil wurden inzwischen geändert. Deine Ansicht ist veraltet; bitte aktualisiere sie.";
    case "address_not_ready":
      return "Die aktuelle Hausadresse und der Planungs-Pin müssen zuerst bestätigt sein.";
    case "profile_missing":
      return "Speichere zuerst eine aktuelle Profilrevision.";
    case "roof_review_required":
      return "Jedes Dach muss für den aktuellen Standort geprüft sein. Ein Default-Dach braucht eine neue Ersatzgeometrie.";
    case "prerequisites_missing":
      return "Die aktuellen Projektanforderungen passen noch nicht vollständig zum Profil.";
    case "unsupported_source":
      return "Die Rechnerquelle kann für dieses Energieprofil nicht verlässlich verarbeitet werden.";
    case "retry_conflict":
      return "Für dieses Projekt läuft bereits eine andere Planungsrechnung. Aktualisiere den Status.";
    case "rate_limited":
      return `Zu viele neue Berechnungen. Bitte in ${state.retryAfterSeconds} Sekunden erneut versuchen.`;
    default:
      return "";
  }
}

export function EnergyConfirmForm({
  workspaceId,
  projectId,
  addressRevision,
  profileRevision,
}: {
  workspaceId: string;
  projectId: string;
  addressRevision: number;
  profileRevision: number;
}) {
  const [state, formAction, pending] = useActionState(
    confirmProjectEnergyProfileAction,
    initialState,
  );
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const message = messageFor(state);
  const succeeded = state.status === "success";

  useEffect(() => {
    if (state.status === "idle") return;
    statusRef.current?.focus();
  }, [state]);

  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input
        type="hidden"
        name="expectedAddressRevision"
        value={addressRevision}
      />
      <input
        type="hidden"
        name="expectedProfileRevision"
        value={profileRevision}
      />
      <p className="text-sm leading-6 text-slate-600">
        Bestätige nur, dass du die sichtbaren Eingaben geprüft hast. Dies ist
        keine Mess-, Dach- oder Physikzertifizierung. Die Bestätigung startet
        automatisch die serverseitige Planungsschätzung.
      </p>
      <button
        type="submit"
        disabled={pending || succeeded}
        className="min-h-11 w-full rounded-md bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {pending
          ? "Eingaben werden bestätigt …"
          : succeeded
            ? "Eingaben bestätigt"
            : "Eingaben bestätigen"}
      </button>
      <p
        ref={statusRef}
        tabIndex={-1}
        role={state.status !== "idle" && !succeeded ? "alert" : "status"}
        aria-live={state.status !== "idle" && !succeeded ? "assertive" : "polite"}
        aria-atomic="true"
        className={
          message
            ? succeeded
              ? "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm leading-6 text-emerald-950 outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
              : "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-950 outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
            : "sr-only"
        }
      >
        {message}
      </p>
    </form>
  );
}
