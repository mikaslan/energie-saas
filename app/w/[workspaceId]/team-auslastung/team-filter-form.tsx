"use client";

import { useState } from "react";
import type { TimeMemberOption } from "@/lib/integrations/time-tracking/contract";

export const TEAM_FILTER_MAX = 50;

export function TeamFilterForm({
  members,
  selectedUserIds,
  startDate,
  endDate,
  resetHref,
}: {
  members: TimeMemberOption[];
  selectedUserIds: string[];
  startDate: string;
  endDate: string;
  resetHref: string;
}) {
  const [selected, setSelected] = useState<string[]>(selectedUserIds);
  const capped = selected.length >= TEAM_FILTER_MAX;

  function toggle(userId: string, checked: boolean): void {
    setSelected((current) => {
      if (checked) {
        if (current.includes(userId) || current.length >= TEAM_FILTER_MAX) return current;
        return [...current, userId];
      }
      return current.filter((id) => id !== userId);
    });
  }

  return (
    <form method="get" className="mb-6 rounded-md border border-slate-200 bg-white px-4 py-3">
      <fieldset>
        <legend className="text-sm font-semibold text-slate-900">Nach Mitgliedern filtern</legend>
        {members.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">Keine Mitglieder gefunden.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {members.map((member) => {
              const checked = selected.includes(member.userId);
              return (
                <label key={member.userId} className="flex min-w-0 items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    name="userId"
                    value={member.userId}
                    checked={checked}
                    disabled={!checked && capped}
                    onChange={(event) => toggle(member.userId, event.target.checked)}
                    className="h-4 w-4 shrink-0 rounded border-slate-300"
                  />
                  <span className="min-w-0 break-all">{member.label}</span>
                </label>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500" aria-live="polite">
          {capped
            ? `Maximal ${TEAM_FILTER_MAX} Mitglieder gleichzeitig auswählbar.`
            : `${selected.length} von maximal ${TEAM_FILTER_MAX} Mitgliedern ausgewählt.`}
        </p>
      </fieldset>
      <fieldset className="mt-4 border-t border-slate-200 pt-3">
        <legend className="text-sm font-semibold text-slate-900">Nach Zeitraum filtern</legend>
        <div className="mt-2 flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-sm text-slate-800">
            Von
            <input
              type="date"
              name="startDate"
              defaultValue={startDate}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-800">
            Bis
            <input
              type="date"
              name="endDate"
              defaultValue={endDate}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Kalendertage (Europe/Berlin), auf den Beginn der Einträge bezogen.
        </p>
      </fieldset>
      <div className="mt-3 flex gap-3">
        <button
          type="submit"
          className="rounded-md bg-brand-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-800"
        >
          Filtern
        </button>
        <a
          href={resetHref}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Zurücksetzen
        </a>
      </div>
    </form>
  );
}
