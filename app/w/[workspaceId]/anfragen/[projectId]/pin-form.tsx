"use client";

import { useActionState } from "react";
import {
  confirmProjectSitePinAction,
  type ConfirmProjectPinState,
} from "../project-actions";

const initialState: ConfirmProjectPinState = { status: "idle" };

function messageFor(state: ConfirmProjectPinState): string {
  switch (state.status) {
    case "success":
      return "Der Planungs-Pin wurde bestätigt.";
    case "invalid":
      return "Die Pin-Bestätigung ist ungültig. Bitte lade die Seite neu.";
    case "unauthenticated":
      return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu und melde dich erneut an.";
    case "denied":
      return "Für die Pin-Bestätigung fehlt dir die Berechtigung.";
    case "not_confirmable":
      return "Diese Adresse ist nicht hausgenau genug, um den Planungs-Pin zu bestätigen.";
    default:
      return "";
  }
}

export function PinForm({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const [state, formAction, pending] = useActionState(
    confirmProjectSitePinAction,
    initialState,
  );
  const message = messageFor(state);
  const succeeded = state.status === "success";

  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="projectId" value={projectId} />
      <p className="text-sm leading-6 text-slate-600">
        Bestätige den hausgenauen Standort erst nach einer bewussten
        Prüfung der ausgewählten Adresse.
      </p>
      <button
        type="submit"
        disabled={pending || succeeded}
        className="min-h-11 w-full rounded-md bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {pending
          ? "Pin wird bestätigt …"
          : succeeded
            ? "Pin bestätigt"
            : "Planungs-Pin bestätigen"}
      </button>
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={
          message
            ? succeeded
              ? "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
              : "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950"
            : "sr-only"
        }
      >
        {message}
      </p>
    </form>
  );
}
