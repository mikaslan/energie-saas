"use client";

import { useActionState } from "react";
import { FOLLOW_UP_BAND_LABEL, followUpBandForDate, parseFollowUpAt } from "@/lib/follow-up";
import {
  clearFollowUpAction,
  setFollowUpAction,
  type FollowUpActionState,
} from "./follow-up-actions";

const initialState: FollowUpActionState = { status: "idle" };

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Berlin",
});

const berlinDateParts = new Intl.DateTimeFormat("de-DE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Europe/Berlin",
});

// YYYY-MM-DD in Berlin-Zeit (nicht Browser-Zeitzone — sonst rutscht das
// Datum je nach Client-Zone einen Tag).
function berlinDateValue(at: Date): string {
  const parts = berlinDateParts.formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function Feedback({ state, testId }: { state: FollowUpActionState; testId: string }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" data-testid={testId} className="mt-3 text-sm font-semibold text-emerald-700">
        {state.message}
      </p>
    );
  }
  const message =
    state.status === "invalid"
      ? "Das Datum ist ungültig."
      : state.status === "not_found"
        ? "Das Projekt ist nicht mehr verfügbar."
        : state.status === "denied"
          ? "Dir fehlt die Berechtigung für diese Aktion."
          : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" data-testid={testId} className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

// F1-06 Lead-Wiedervorlage: aktueller Termin + Band, Setzen per
// Kalenderdatum, Löschen. Reine Darstellung gespeicherter Werte.
export function FollowUpSection({
  workspaceId,
  projectId,
  followUpAt,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  followUpAt: string | null;
  canWrite: boolean;
}) {
  const [setState, setDispatch] = useActionState(setFollowUpAction, initialState);
  const [clearState, clearDispatch] = useActionState(clearFollowUpAction, initialState);
  const at = followUpAt === null ? null : parseFollowUpAt(followUpAt);
  const band = at === null ? null : followUpBandForDate(at, new Date());
  const dateValue = at === null ? "" : berlinDateValue(at);

  return (
    <section aria-label="Wiedervorlage" className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Wiedervorlage</h2>
      {at === null || band === null ? (
        <p className="mt-2 text-sm text-slate-600" data-testid="follow-up-current">
          Keine Wiedervorlage hinterlegt.
        </p>
      ) : (
        <p className="mt-2 text-sm text-slate-700" data-testid="follow-up-current">
          Fällig am {dateFormatter.format(at)}{" "}
          <span className="font-semibold">({FOLLOW_UP_BAND_LABEL[band]})</span>
        </p>
      )}
      {canWrite ? (
        <div className="mt-3 grid gap-3">
          <form action={setDispatch} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="projectId" value={projectId} />
            <label className="grid gap-1 text-sm font-medium text-slate-700">
              Datum
              <input
                type="date"
                name="followUpDate"
                required
                defaultValue={dateValue}
                data-testid="follow-up-date"
                className="min-h-11 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
              />
            </label>
            <button
              type="submit"
              data-testid="follow-up-save"
              className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
            >
              Speichern
            </button>
          </form>
          <Feedback state={setState} testId="follow-up-set-feedback" />
          {at !== null ? (
            <form action={clearDispatch}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <button
                type="submit"
                data-testid="follow-up-clear"
                className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
              >
                Wiedervorlage löschen
              </button>
            </form>
          ) : null}
          <Feedback state={clearState} testId="follow-up-clear-feedback" />
        </div>
      ) : null}
    </section>
  );
}
