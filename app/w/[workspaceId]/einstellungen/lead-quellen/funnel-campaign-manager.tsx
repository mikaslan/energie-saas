"use client";

import { useActionState, useEffect, useRef } from "react";
import type { FunnelCampaignDto } from "@/lib/integrations/funnel-campaigns/contract";
import type { LeadSourceDto } from "@/lib/integrations/lead-sources/contract";
import {
  archiveFunnelCampaignAction,
  createFunnelCampaignAction,
  type FunnelCampaignActionState,
} from "./funnel-campaign-actions";

const initialState: FunnelCampaignActionState = { status: "idle" };

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30";

function message(state: FunnelCampaignActionState): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success": return { text: state.message, isError: false };
    case "invalid": return {
      text: state.message ?? "Die Eingabe ist ungültig (Name, Slug a-z0-9._- und Quelle prüfen).",
      isError: true,
    };
    case "conflict": return {
      text: "Eine aktive Kampagne mit diesem Namen oder Slug existiert bereits.",
      isError: true,
    };
    case "not_found": return { text: "Die Kampagne oder Quelle wurde nicht gefunden.", isError: true };
    case "denied": return { text: "Dir fehlt die Berechtigung für diese Aktion.", isError: true };
    case "unauthenticated": return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    default: return null;
  }
}

function Feedback({ state }: { state: FunnelCampaignActionState }) {
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const feedback = message(state);
  useEffect(() => {
    if (feedback?.isError) feedbackRef.current?.focus();
  }, [feedback?.isError, state]);
  return (
    <p
      ref={feedbackRef}
      tabIndex={-1}
      role={feedback?.isError ? "alert" : "status"}
      aria-live="polite"
      className={`mt-4 text-sm font-semibold ${
        feedback === null ? "hidden" : feedback.isError ? "text-red-700" : "text-green-700"
      }`}
    >
      {feedback?.text}
    </p>
  );
}

// F12-01: Kampagnen-Verwaltung neben den Lead-Quellen (gleiche Schranke:
// lead_source.read/write, keine neuen Permissions). Leser sehen aktiv +
// archiviert, Schreiber legen an und archivieren.
export function FunnelCampaignManager({
  workspaceId,
  campaigns,
  sources,
  canWrite,
}: {
  workspaceId: string;
  campaigns: FunnelCampaignDto[];
  sources: LeadSourceDto[];
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createFunnelCampaignAction, initialState);
  const [archiveState, archiveDispatch] = useActionState(archiveFunnelCampaignAction, initialState);

  const active = campaigns.filter((campaign) => campaign.archivedAt === null);
  const archived = campaigns.filter((campaign) => campaign.archivedAt !== null);
  const activeSources = sources.filter((source) => source.archivedAt === null);

  return (
    <div className="mt-6 space-y-6">
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-950">Neue Funnel-Kampagne</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Variante mit eigener Lead-Quelle für die manuelle Erfassung —
            der Slug ist das reservierte Deeplink-Token für den späteren
            öffentlichen Funnel.
          </p>
        </div>

        {!canWrite ? (
          <p className="text-sm leading-6 text-slate-500">
            Du hast Lesezugriff. Zum Anlegen brauchst du Editor-Rechte.
          </p>
        ) : (
          <form action={createDispatch} data-testid="funnel-campaign-create-form">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Name</span>
                <input type="text" name="name" required maxLength={120} className={inputClass} />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Slug</span>
                <input
                  type="text"
                  name="slug"
                  required
                  maxLength={64}
                  placeholder="sommer-2026"
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Lead-Quelle</span>
                <select name="leadSourceId" required defaultValue="" className={inputClass}>
                  <option value="">Bitte wählen</option>
                  {activeSources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <Feedback state={createState} />

            <div className="mt-5">
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
              >
                Anlegen
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Aktive Kampagnen</h2>
        {active.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Noch keine aktiven Funnel-Kampagnen angelegt.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {active.map((campaign) => (
              <li key={campaign.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-900">{campaign.name}</span>
                  <span className="block text-xs text-slate-500">
                    {`${campaign.slug} · ${campaign.leadSourceName}`}
                  </span>
                </span>
                {canWrite ? (
                  <form action={archiveDispatch}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="id" value={campaign.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      Archivieren
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Feedback state={archiveState} />
      </section>

      {archived.length > 0 ? (
        <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-950">Archivierte Kampagnen</h2>
          <ul className="mt-3 divide-y divide-slate-100">
            {archived.map((campaign) => (
              <li key={campaign.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1 text-sm text-slate-500">{campaign.name}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
