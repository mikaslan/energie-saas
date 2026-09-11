"use client";

import { useActionState } from "react";
import type { InstallationDto, InstallationMemberOption } from "@/modules/installations";
import {
  completeInstallationAction,
  createInstallationAction,
  recordHandoverAction,
  setLeadInstallerAction,
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
  installerOptions,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  installation: InstallationDto | null;
  installerOptions: InstallationMemberOption[];
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createInstallationAction, initialState);
  const [completeState, completeDispatch] = useActionState(completeInstallationAction, initialState);
  const [handoverState, handoverDispatch] = useActionState(recordHandoverAction, initialState);
  const [leadState, leadDispatch] = useActionState(setLeadInstallerAction, initialState);
  const feedbackState = leadState.status === "idle"
    ? (handoverState.status === "idle"
      ? (completeState.status === "idle" ? createState : completeState)
      : handoverState)
    : leadState;

  return (
    <section aria-labelledby="project-installation-title" className="min-w-0">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-800">Akte</p>
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
                className="inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
              >
                Installation direkt anlegen
              </button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-slate-600">Nur Lesezugriff: Keine Anlage möglich.</p>
          )}
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
          <div className="flex gap-2">
            <dt className="font-semibold text-slate-800">Lead Installer:</dt>
            <dd>{installation.leadInstallerLabel ?? "nicht zugewiesen"}</dd>
          </div>
          {installation.handoverAt !== null ? (
            <>
              <div className="flex gap-2">
                <dt className="font-semibold text-slate-800">Abgenommen:</dt>
                <dd>{formatDateTime(installation.handoverAt)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-semibold text-slate-800">Abgenommen durch:</dt>
                <dd>{installation.handoverByName}</dd>
              </div>
              {installation.handoverNote ? (
                <div className="flex gap-2">
                  <dt className="font-semibold text-slate-800">Notiz:</dt>
                  <dd>{installation.handoverNote}</dd>
                </div>
              ) : null}
            </>
          ) : null}
        </dl>
      )}

      {installation !== null && canWrite ? (
        <form action={leadDispatch} className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-950">Lead Installer zuweisen</h3>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Mitglied</span>
            <select
              name="membershipId"
              defaultValue={installation.leadInstallerMembershipId ?? ""}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            >
              <option value="">— nicht zugewiesen —</option>
              {installerOptions.map((option) => (
                <option key={option.membershipId} value={option.membershipId}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Zuweisung speichern
          </button>
        </form>
      ) : null}

      {installation !== null && installation.status === "active" ? (
        <div className="mt-3">
          {canWrite ? (
            <form action={completeDispatch}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
              >
                Installation abschließen
              </button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-slate-600">Nur Lesezugriff: Kein Abschluss möglich.</p>
          )}
        </div>
      ) : null}

      {installation !== null && installation.status === "completed" && canWrite ? (
        <form action={handoverDispatch} className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-950">
            {installation.handoverAt !== null ? "Abnahme korrigieren" : "Abnahme festhalten"}
          </h3>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Abgenommen durch</span>
            <input
              type="text"
              name="byName"
              required
              maxLength={160}
              defaultValue={installation.handoverByName ?? ""}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            />
          </label>
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Notiz (optional)</span>
            <input
              type="text"
              name="note"
              maxLength={500}
              defaultValue={installation.handoverNote ?? ""}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            />
          </label>
          <button
            type="submit"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Abnahme speichern
          </button>
        </form>
      ) : null}

      <Feedback state={feedbackState} />
    </section>
  );
}
