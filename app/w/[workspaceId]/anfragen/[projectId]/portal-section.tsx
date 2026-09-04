"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  createPortalInviteAction,
  withdrawPortalInviteAction,
  type PortalActionState,
} from "./portal-actions";
import type { PortalStatusResult } from "@/modules/portal";

const IDLE_STATE: PortalActionState = { status: "idle" };

const dateTimeFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

function actionMessage(state: PortalActionState): string {
  switch (state.status) {
    case "idle": return "";
    case "success":
      return state.operation === "create_invite"
        ? "Der Portal-Link wurde erstellt. Kopiere ihn jetzt — er wird nicht erneut angezeigt."
        : "Der Portal-Link wurde zurückgezogen.";
    case "invalid": return "Die Eingabe ist unvollständig oder ungültig.";
    case "conflict": return "Der Stand hat sich zwischenzeitlich geändert. Die Ansicht wurde aktualisiert.";
    case "not_found": return "Der Link oder das Projekt ist nicht mehr verfügbar.";
    case "denied": return "Für diese Aktion fehlt dir die Berechtigung.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu.";
  }
}

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:opacity-50"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

export function PortalSection({
  workspaceId,
  projectId,
  initialStatus,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  initialStatus: PortalStatusResult;
  canWrite: boolean;
}) {
  const [createState, createAction] = useActionState(
    createPortalInviteAction.bind(null, workspaceId, projectId),
    IDLE_STATE,
  );
  const [withdrawState, withdrawAction] = useActionState(
    withdrawPortalInviteAction.bind(null, workspaceId, projectId),
    IDLE_STATE,
  );
  const [copied, setCopied] = useState(false);
  const active = initialStatus.active;
  const createdToken = createState.status === "success" && createState.operation === "create_invite"
    ? createState.token
    : null;
  const message = actionMessage(createState.status !== "idle" ? createState : withdrawState);

  async function copyToken(token: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/p/${token}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-labelledby="portal-heading" className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <h2 id="portal-heading" className="text-lg font-semibold text-slate-950">Kundenportal</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        {active
          ? `Aktiver Link — gültig bis ${formatDateTime(active.expiresAt)}, ${active.viewCount} Aufrufe.`
          : "Kein aktiver Link. Genau ein Link je Projekt; ein neuer Link zieht den alten zurück."}
      </p>
      {message !== "" ? (
        <p className="mt-3 text-sm font-medium text-slate-800" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
      {createdToken !== null ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">Einmaliger Link (jetzt kopieren):</p>
          <p className="mt-1 break-all font-mono text-sm text-amber-900">/p/{createdToken}</p>
          <button
            type="button"
            onClick={() => void copyToken(createdToken)}
            className="mt-2 inline-flex min-h-11 items-center rounded-md border border-amber-400 bg-white px-4 text-sm font-semibold text-amber-900 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            {copied ? "Kopiert" : "Link kopieren"}
          </button>
        </div>
      ) : null}
      {canWrite ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <form action={createAction} className="flex items-end gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Gültigkeit
              <select
                name="ttlDays"
                defaultValue="14"
                className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                <option value="7">7 Tage</option>
                <option value="14">14 Tage</option>
                <option value="30">30 Tage</option>
                <option value="60">60 Tage</option>
              </select>
            </label>
            <SubmitButton label="Link erstellen" pendingLabel="Wird erstellt …" />
          </form>
          {active !== null ? (
            <form action={withdrawAction} className="flex items-end gap-3">
              <input type="hidden" name="inviteId" value={active.inviteId} />
              <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
                Grund
                <select
                  name="reason"
                  defaultValue="user_request"
                  className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                >
                  <option value="user_request">Kundenwunsch</option>
                  <option value="project_closed">Projekt geschlossen</option>
                  <option value="other">Sonstiges</option>
                </select>
              </label>
              <SubmitButton label="Link zurückziehen" pendingLabel="Wird zurückgezogen …" />
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
