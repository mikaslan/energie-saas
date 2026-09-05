"use client";

import { useActionState } from "react";
import type { InstallationDto } from "@/modules/installations";
import {
  completeInstallationAction,
  createInstallationAction,
  type InstallationActionState,
} from "./installation-actions";

const initialState: InstallationActionState = { status: "idle" };

const dateTimeFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function formatDateTime(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

const STATUS_LABELS: Record<InstallationDto["status"], string> = {
  active: "Aktiv",
  completed: "Abgeschlossen",
};

function Feedback({ state }: { state: InstallationActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" className="mt-3 text-sm text-slate-700">
        {state.message}
      </p>
    );
  }
  const text =
    state.status === "invalid"
      ? "Die Anforderung war ungültig. Lade die Seite neu und versuche es erneut."
      : state.status === "conflict"
        ? "Für dieses Projekt existiert bereits eine Installation."
        : state.status === "not_found"
          ? "Die Installation ist nicht mehr verfügbar."
          : state.status === "denied"
            ? "Du darfst die Installation nicht ändern."
            : "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  return (
    <p role="alert" className="mt-3 text-sm font-semibold text-rose-800">
      {text}
    </p>
  );
}

export function InstallationSection({
  workspaceId,
  projectId,
  installation,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  installation: InstallationDto | null;
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createInstallationAction, initialState);
  const [completeState, completeDispatch] = useActionState(completeInstallationAction, initialState);

  return (
    <section aria-labelledby="project-installation-title" className="min-w-0">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Akte</p>
      <h2 id="project-installation-title" className="mt-1 text-xl font-semibold text-slate-950">
        Installation
      </h2>

      {installation === null ? (
        <div className="mt-2">
          <p className="text-sm leading-6 text-slate-600">
            Noch keine Installation. Die Direktanlage stellt das Projekt
            auf die Phase Installation — ohne Signatur-Umweg.
          </p>
          {canWrite ? (
            <form action={createDispatch} className="mt-3">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Installation direkt anlegen
              </button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-slate-600">Nur Lesezugriff: Keine Anlage möglich.</p>
          )}
          <Feedback state={createState} />
        </div>
      ) : (
        <dl className="mt-2 grid gap-2 text-sm leading-6 text-slate-700">
          <div className="flex gap-2">
            <dt className="font-semibold text-slate-800">Status:</dt>
            <dd>{STATUS_LABELS[installation.status]}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold text-slate-800">Quelle:</dt>
            <dd>{installation.source === "direct" ? "Direktanlage" : "Signatur"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold text-slate-800">Angelegt:</dt>
            <dd>{formatDateTime(installation.createdAt)}</dd>
          </div>
          {installation.status === "completed" ? (
            <div className="flex gap-2">
              <dt className="font-semibold text-slate-800">Abgeschlossen:</dt>
              <dd>{formatDateTime(installation.completedAt)}</dd>
            </div>
          ) : null}
        </dl>
      )}

      {installation !== null && installation.status === "active" ? (
        <div className="mt-3">
          {canWrite ? (
            <form action={completeDispatch}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Installation abschließen
              </button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-slate-600">Nur Lesezugriff: Kein Abschluss möglich.</p>
          )}
          <Feedback state={completeState} />
        </div>
      ) : null}
    </section>
  );
}
