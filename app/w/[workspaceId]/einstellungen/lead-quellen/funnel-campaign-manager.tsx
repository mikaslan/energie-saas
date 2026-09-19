"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { FunnelCampaignDto } from "@/lib/integrations/funnel-campaigns/contract";
import type { LeadSourceDto } from "@/lib/integrations/lead-sources/contract";
import type { LeadRoutingRuleDto, RoutableMember } from "@/modules/lead-sources";
import {
  archiveRoutingRuleAction,
  clearRoutingRuleAction,
  reactivateRoutingRuleAction,
  setRoutingRuleAction,
  type LeadSourceActionState,
} from "./actions";
import {
  archiveFunnelCampaignAction,
  createFunnelCampaignAction,
  type FunnelCampaignActionState,
} from "./funnel-campaign-actions";

const initialState: FunnelCampaignActionState = { status: "idle" };
const initialRuleState: LeadSourceActionState = { status: "idle" };

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
  members,
  canWrite,
  rules,
}: {
  workspaceId: string;
  campaigns: FunnelCampaignDto[];
  sources: LeadSourceDto[];
  members: RoutableMember[];
  canWrite: boolean;
  rules: LeadRoutingRuleDto[];
}) {
  const [createState, createDispatch] = useActionState(createFunnelCampaignAction, initialState);
  const [archiveState, archiveDispatch] = useActionState(archiveFunnelCampaignAction, initialState);

  const active = campaigns.filter((campaign) => campaign.archivedAt === null);
  const archived = campaigns.filter((campaign) => campaign.archivedAt !== null);
  const activeSources = sources.filter((source) => source.archivedAt === null);
  // F1-23: Kampagnen-Regeln (Dimension Kampagne) je Kampagne, sortiert
  // nach Priorität aufsteigend, dann Änderungsstand.
  const rulesByCampaign = new Map<string, LeadRoutingRuleDto[]>();
  for (const rule of rules) {
    if (!rule.funnelCampaignId) continue;
    const list = rulesByCampaign.get(rule.funnelCampaignId) ?? [];
    list.push(rule);
    rulesByCampaign.set(rule.funnelCampaignId, list);
  }
  for (const list of rulesByCampaign.values()) {
    list.sort((a, b) => a.priority - b.priority || (a.updatedAt < b.updatedAt ? -1 : 1));
  }

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
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">
                  Beauftragter (Auto-Routing, optional)
                </span>
                <select name="assigneeMembershipId" defaultValue="" className={inputClass}>
                  <option value="">Keine automatische Zuweisung</option>
                  {members.map((member) => (
                    <option key={member.membershipId} value={member.membershipId}>
                      {member.label}
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
              <li key={campaign.id} className="grid gap-2 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-slate-900">{campaign.name}</span>
                    <span className="block text-xs text-slate-500">
                      {`${campaign.slug} · ${campaign.leadSourceName}${
                        campaign.assignee ? ` · Zuweisung: ${campaign.assignee.label}` : ""
                      }`}
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
                </div>
                <CampaignRoutingSection
                  workspaceId={workspaceId}
                  campaignId={campaign.id}
                  campaignName={campaign.name}
                  rules={rulesByCampaign.get(campaign.id) ?? []}
                  members={members}
                  canWrite={canWrite}
                />
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

function RuleFeedback({ state }: { state: LeadSourceActionState }) {
  return <Feedback state={state} />;
}

// F1-23 (T8-UI): Kampagnen-Regeln sind NUR Suggest (kein Modus-, kein
// Auto-Feld) — daneben steht unverändert der F12-02-Beauftragte
// (Auto-Pfad). Gleiche Schranke lead_source.write wie die Quellen-Regeln.
function CampaignRoutingSection({
  workspaceId,
  campaignId,
  campaignName,
  rules,
  members,
  canWrite,
}: {
  workspaceId: string;
  campaignId: string;
  campaignName: string;
  rules: LeadRoutingRuleDto[];
  members: RoutableMember[];
  canWrite: boolean;
}) {
  const [setState, setDispatch] = useActionState(setRoutingRuleAction, initialRuleState);
  const [clearState, clearDispatch] = useActionState(clearRoutingRuleAction, initialRuleState);
  const [archiveState, archiveDispatch] = useActionState(archiveRoutingRuleAction, initialRuleState);
  const [reactivateState, reactivateDispatch] = useActionState(reactivateRoutingRuleAction, initialRuleState);
  const [editingId, setEditingId] = useState<string | null>(null);

  if (!canWrite) {
    if (rules.length === 0) {
      return (
        <p className="text-xs leading-5 text-slate-500" data-testid={`campaign-routing-readonly-${campaignId}`}>
          Kein Routing-Vorschlag hinterlegt.
        </p>
      );
    }
    return (
      <ul
        className="grid gap-1 text-xs leading-5 text-slate-500"
        data-testid={`campaign-routing-readonly-${campaignId}`}
        aria-label={`Routing-Vorschläge für ${campaignName}`}
      >
        {rules.map((rule) => (
          <li key={rule.id}>
            {`Routing-Vorschlag: ${rule.assigneeLabel} · Priorität ${rule.priority}`}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="rounded-md bg-slate-50 px-3 py-2" data-testid={`campaign-routing-form-${campaignId}`}>
      {rules.length > 0 ? (
        <ul className="mb-2 divide-y divide-slate-200" aria-label={`Routing-Vorschläge für ${campaignName}`}>
          {rules.map((rule) => (
            <li key={rule.id} data-testid={`campaign-routing-rule-${rule.id}`} className="grid gap-2 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-xs text-slate-600">
                  {`Vorschlag: ${rule.assigneeLabel} · Priorität ${rule.priority}`}
                  {rule.archivedAt !== null ? " · Archiviert" : ""}
                </span>
                <button
                  type="button"
                  onClick={() => setEditingId(editingId === rule.id ? null : rule.id)}
                  aria-expanded={editingId === rule.id}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600"
                >
                  Bearbeiten
                </button>
                <form action={clearDispatch}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="ruleId" value={rule.id} />
                  <input type="hidden" name="funnelCampaignId" value={campaignId} />
                  <button
                    type="submit"
                    aria-label={`Routing-Vorschlag für ${campaignName} entfernen`}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Vorschlag entfernen
                  </button>
                </form>
                {rule.archivedAt === null ? (
                  <form action={archiveDispatch}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="ruleId" value={rule.id} />
                    <button
                      type="submit"
                      aria-label={`Routing-Vorschlag für ${campaignName} archivieren`}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      Archivieren
                    </button>
                  </form>
                ) : (
                  <form action={reactivateDispatch}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="ruleId" value={rule.id} />
                    <button
                      type="submit"
                      aria-label={`Routing-Vorschlag für ${campaignName} reaktivieren`}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      Reaktivieren
                    </button>
                  </form>
                )}
              </div>
              {editingId === rule.id ? (
                <form action={setDispatch} className="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-white px-2 py-2">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="ruleId" value={rule.id} />
                  <input type="hidden" name="funnelCampaignId" value={campaignId} />
                  <input type="hidden" name="mode" value="suggest" />
                  <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium text-slate-700">
                    Betreuer
                    <select
                      name="assigneeMembershipId"
                      defaultValue={rule.assigneeMembershipId}
                      required
                      aria-label={`Routing-Vorschlag für ${campaignName} bearbeiten`}
                      className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-600"
                    >
                      <option value="">Bitte wählen</option>
                      {members.map((member) => (
                        <option key={member.membershipId} value={member.membershipId}>
                          {member.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs font-medium text-slate-700">
                    Priorität
                    <input
                      type="number"
                      name="priority"
                      min={0}
                      max={9999}
                      defaultValue={rule.priority}
                      aria-label="Priorität"
                      className="min-h-11 w-28 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-600"
                    />
                  </label>
                  <button
                    type="submit"
                    aria-label={`Routing-Vorschlag für ${campaignName} speichern`}
                    className="min-h-11 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Speichern
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Abbrechen
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <form action={setDispatch} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="funnelCampaignId" value={campaignId} />
        <input type="hidden" name="mode" value="suggest" />
        <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium text-slate-700">
          {`Routing-Vorschlag für „${campaignName}“`}
          <select
            name="assigneeMembershipId"
            defaultValue=""
            required
            aria-label={`Routing-Vorschlag für ${campaignName}`}
            className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-600"
          >
            <option value="">Bitte wählen</option>
            {members.map((member) => (
              <option key={member.membershipId} value={member.membershipId}>
                {member.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium text-slate-700">
          Priorität
          <input
            type="number"
            name="priority"
            min={0}
            max={9999}
            defaultValue={0}
            aria-label={`Priorität für ${campaignName}`}
            className="min-h-11 w-28 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-600"
          />
        </label>
        <button
          type="submit"
          aria-label={`Routing-Vorschlag für ${campaignName} speichern`}
          className="min-h-11 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          Speichern
        </button>
      </form>
      <RuleFeedback state={setState} />
      <RuleFeedback state={clearState} />
      <RuleFeedback state={archiveState} />
      <RuleFeedback state={reactivateState} />
    </div>
  );
}
