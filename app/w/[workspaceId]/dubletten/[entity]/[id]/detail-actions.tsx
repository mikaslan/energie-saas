"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  linkDedupeProjectAction,
  markDedupeReviewedAction,
  type LinkDedupeActionState,
  type MarkDedupeActionState,
} from "../../actions";

const idleMark: MarkDedupeActionState = { status: "idle" };
const idleLink: LinkDedupeActionState = { status: "idle" };

const buttonClass =
  "inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:opacity-60";

function MarkFeedback({ state }: { state: MarkDedupeActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" data-testid="dedupe-mark-success" className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        {state.changed
          ? "Als geprüft markiert — der Prüfhinweis ist aufgelöst."
          : "Bereits geprüft — keine Änderung."}
      </p>
    );
  }
  const message = state.status === "invalid"
    ? "Ungültige Eingabe."
    : state.status === "not-found"
      ? "Der Eintrag liegt nicht mehr zur Prüfung vor."
      : state.status === "conflict"
        ? "Zwischenzeitlich geändert — bitte Seite neu laden und erneut prüfen."
        : state.status === "denied"
          ? "Keine Berechtigung zum Markieren."
          : "Bitte erneut anmelden.";
  return (
    <p role="alert" data-testid="dedupe-mark-error" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {message}
    </p>
  );
}

function LinkFeedback({ state }: { state: LinkDedupeActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" data-testid="dedupe-link-success" className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        Anfrage verknüpft — der Prüfhinweis ist aufgelöst.
      </p>
    );
  }
  const message = state.status === "invalid"
    ? "Ungültige Eingabe."
    : state.status === "not-found"
      ? "Anfrage oder Kontakt liegt nicht mehr vor."
      : state.status === "conflict"
        ? "Verknüpfen nicht möglich (Angebote, Adresse oder Zwischenänderung) — bitte Detail neu laden."
        : state.status === "denied"
          ? "Keine Berechtigung zum Verknüpfen."
          : "Bitte erneut anmelden.";
  return (
    <p role="alert" data-testid="dedupe-link-error" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {message}
    </p>
  );
}

export function MarkReviewedForm({
  workspaceId,
  entity,
  id,
  expectedRevision,
}: {
  workspaceId: string;
  entity: "contact" | "project";
  id: string;
  expectedRevision?: number;
}) {
  const [state, formAction, pending] = useActionState(
    markDedupeReviewedAction.bind(null, workspaceId, entity, id),
    idleMark,
  );
  return (
    <div className="grid gap-2">
      <MarkFeedback state={state} />
      {state.status !== "success" ? (
        <form action={formAction} data-testid="dedupe-mark-form">
          {expectedRevision !== undefined ? (
            <input type="hidden" name="expectedRevision" value={expectedRevision} />
          ) : null}
          <button type="submit" disabled={pending} className={buttonClass}>
            Als geprüft markieren
          </button>
        </form>
      ) : (
        <Link
          href={`/w/${workspaceId}/dubletten`}
          className="inline-flex min-h-11 w-fit items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
        >
          Zurück zur Queue
        </Link>
      )}
    </div>
  );
}

export function LinkCandidateForm({
  workspaceId,
  projectId,
  candidateId,
  candidateName,
}: {
  workspaceId: string;
  projectId: string;
  candidateId: string;
  candidateName: string;
}) {
  const [state, formAction, pending] = useActionState(
    linkDedupeProjectAction.bind(null, workspaceId, projectId),
    idleLink,
  );
  return (
    <div className="grid gap-2">
      <LinkFeedback state={state} />
      {state.status !== "success" ? (
        <form action={formAction} data-testid={`dedupe-link-form-${candidateId}`}>
          <input type="hidden" name="canonicalContactId" value={candidateId} />
          <button
            type="submit"
            disabled={pending}
            className={buttonClass}
            aria-label={`Anfrage mit ${candidateName} verknüpfen`}
          >
            Verknüpfen
          </button>
        </form>
      ) : (
        <Link
          href={`/w/${workspaceId}/dubletten`}
          className="inline-flex min-h-11 w-fit items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
        >
          Zurück zur Queue
        </Link>
      )}
    </div>
  );
}
