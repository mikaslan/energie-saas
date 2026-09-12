import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { SignOutButton } from "@/app/_components/sign-out-button";
import {
  getBoardPipelineSummary,
  getRequestBoard,
  listBoardColumnsForAdmin,
  type BoardColumnAdminEntry,
  type BoardPipelineSummary,
  type RequestBoardCard,
  type RequestBoardColumn,
  type RequestBoardScope,
} from "@/modules/boards";
import { listLeadSources } from "@/modules/lead-sources";
import { listFunnelCampaigns } from "@/modules/funnel-campaigns";
import { FOLLOW_UP_BAND_LABEL, type FollowUpBand } from "@/lib/follow-up";
import {
  LEAD_SCORE_BAND_LABEL,
  LEAD_SCORE_SIGNAL_LABEL,
  type LeadScoreBand,
} from "@/lib/lead-score";
import type { RequestBoardFollowUpFilter } from "@/modules/boards";
import { can } from "@/lib/permissions";
import { ManualLeadForm } from "./manual-lead-form";
import { ManualLeadBulkForm } from "./manual-lead-bulk-form";
import { BoardColumnAdmin } from "./board-column-admin";
import {
  RequestBoardCard as RequestBoardCardClient,
  RequestBoardClient,
  RequestBoardColumn as RequestBoardColumnClient,
} from "./board-client";

const workspaceIdSchema = z.uuid();

export const metadata: Metadata = {
  title: "Anfragen | WMEE Vertrieb",
};

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Berlin",
});

const numberFormatter = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 1,
});

// F1-05b: Pipeline-Beträge (Cent → Euro, de-DE).
const euroFormatter = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

function productLabels(card: RequestBoardCard): string[] {
  const labels: string[] = [];
  if (card.requestedProducts.photovoltaics) labels.push("Photovoltaik");
  if (card.requestedProducts.targetStorageKwh !== null) {
    labels.push(`Speicher ${numberFormatter.format(card.requestedProducts.targetStorageKwh)} kWh`);
  }
  if (card.requestedProducts.wallbox) labels.push("Wallbox");
  if (card.requestedProducts.bidirectionalCharging) labels.push("Bidirektionales Laden");
  if (card.requestedProducts.backupPower) labels.push("Ersatzstrom");
  return labels;
}

// F1-07: Ampel-Farbe des Score-Badges (Regel-Score v1, ESTIMATE).
function scoreBadgeClass(band: LeadScoreBand): string {
  if (band === "hot") return "bg-green-100 text-green-900";
  if (band === "warm") return "bg-amber-100 text-amber-900";
  return "bg-slate-200 text-slate-700";
}

// F1-06: Ampel-Farbe des Wiedervorlage-Badges.
function followUpBadgeClass(band: FollowUpBand): string {
  if (band === "escalated") return "bg-red-100 text-red-900";
  if (band === "overdue") return "bg-amber-100 text-amber-900";
  if (band === "due") return "bg-brand-100 text-brand-900";
  return "bg-slate-200 text-slate-700";
}

const followUpDateFormatter = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Berlin",
});

function scoreSignalsTitle(card: RequestBoardCard): string {
  if (!card.score) return "";
  const met = card.score.signals.map((signal) => LEAD_SCORE_SIGNAL_LABEL[signal]);
  return `Lead-Score ${card.score.value} von 100 (${LEAD_SCORE_BAND_LABEL[card.score.band]})${met.length > 0 ? `: ${met.join(", ")}` : ""}`;
}

function blockerLabels(card: RequestBoardCard): string[] {
  const labels: string[] = [];
  if (card.blockers.dedupeReviewRequired) labels.push("Kontakt prüfen");
  if (card.blockers.addressFollowUpRequired) labels.push("Adresse nachfassen");
  if (card.blockers.pinConfirmationRequired) labels.push("Pin offen");
  if (card.blockers.catalogResolutionPending) labels.push("Produkte offen");
  return labels;
}

function columnTone(column: RequestBoardColumn): string {
  if (column.color === "blue") return "bg-brand-600";
  if (column.color === "amber") return "bg-amber-500";
  if (column.color === "green") return "bg-emerald-600";
  return "bg-slate-400";
}

function AccessDenied() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-6 py-16">
      <section className="w-full rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">WMEE Vertrieb</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">Kein Zugriff</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Für diesen Arbeitsbereich liegt keine passende Mitgliedschaft vor.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
        >
          Zur Startseite
        </Link>
      </section>
    </main>
  );
}

export default async function RequestsPage({
  params,
  searchParams,
}: PageProps<"/w/[workspaceId]/anfragen">) {
  const { workspaceId } = await params;
  const parsedWorkspaceId = workspaceIdSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) notFound();
  const validWorkspaceId = parsedWorkspaceId.data;

  // F15-01: Bereichs-Umschalter (?bereich=gewerbe). Unbekannte Werte
  // brechen fail-closed ab — kein stiller Default.
  const rawScope = (await searchParams)?.bereich;
  const scopeValue = Array.isArray(rawScope) ? rawScope[0] : rawScope;
  let scope: RequestBoardScope = "residential";
  if (scopeValue !== undefined) {
    if (scopeValue === "gewerbe") scope = "commercial";
    else if (scopeValue === "wohnbau") scope = "residential";
    else notFound();
  }

  // F1-07: Score-Preset (?score=heiss|warm|kalt). Unbekannte Werte
  // brechen fail-closed ab — kein stiller Alle-Fallback.
  const rawScore = (await searchParams)?.score;
  const scoreValue = Array.isArray(rawScore) ? rawScore[0] : rawScore;
  let scoreBand: LeadScoreBand | undefined;
  if (scoreValue !== undefined) {
    if (scoreValue === "heiss") scoreBand = "hot";
    else if (scoreValue === "warm") scoreBand = "warm";
    else if (scoreValue === "kalt") scoreBand = "cold";
    else notFound();
  }
  // F1-06: Wiedervorlage-Preset (?wiedervorlage=anstehend|ueberfaellig).
  // Unbekannte Werte brechen fail-closed ab — kein stiller Alle-Fallback.
  const rawFollowUp = (await searchParams)?.wiedervorlage;
  const followUpValue = Array.isArray(rawFollowUp) ? rawFollowUp[0] : rawFollowUp;
  let followUpFilter: RequestBoardFollowUpFilter | undefined;
  if (followUpValue !== undefined) {
    if (followUpValue === "anstehend") followUpFilter = "due";
    else if (followUpValue === "ueberfaellig") followUpFilter = "overdue";
    else notFound();
  }
  const boardHref = (
    targetScope: RequestBoardScope,
    band: LeadScoreBand | undefined,
    followUp: RequestBoardFollowUpFilter | undefined,
  ): string => {
    const params = new URLSearchParams();
    if (targetScope === "commercial") params.set("bereich", "gewerbe");
    if (band === "hot") params.set("score", "heiss");
    else if (band === "warm") params.set("score", "warm");
    else if (band === "cold") params.set("score", "kalt");
    if (followUp === "due") params.set("wiedervorlage", "anstehend");
    else if (followUp === "overdue") params.set("wiedervorlage", "ueberfaellig");
    const query = params.toString();
    return `/w/${validWorkspaceId}/anfragen${query ? `?${query}` : ""}`;
  };

  let board: Awaited<ReturnType<typeof getRequestBoard>> | undefined;
  let canCreateManualLead = false;
  let leadSourceOptions: Array<{ id: string; name: string }> = [];
  let campaignOptions: Array<{
    id: string; name: string; leadSourceName: string; assigneeLabel: string | null;
  }> = [];
  let adminColumns: BoardColumnAdminEntry[] = [];
  let pipelineSummary: BoardPipelineSummary | undefined;
  let unauthenticated = false;
  let denied = false;
  try {
    const loaded = await authorizedQuery(
      validWorkspaceId,
      "project.read",
      "kanban_board",
      async (tx, ctx) => {
        const board = await getRequestBoard(tx, ctx, { scope, scoreBand, followUpFilter });
        const canCreate = can(ctx, "project.write");
        // F1-05a: Spaltenverwaltung (nur Editoren; gleiche Schranke wie
        // die Anlage; ohne Recht leere Liste, Board bleibt nutzbar).
        const adminColumns = canCreate
          ? await listBoardColumnsForAdmin(tx, ctx, { boardId: board.id })
          : [];
        return {
          board,
          canCreate,
          adminColumns,
          pipelineSummary: await getBoardPipelineSummary(tx, ctx, { boardId: board.id }),
          // F1-11: Quellen-Dropdown (gleiche Leseschranke wie die
          // Verwaltung; ohne Recht leere Liste, Formular bleibt nutzbar).
          sources: await listLeadSources(tx, ctx, { includeArchived: false }).catch(
            (error: unknown) => {
              if (error instanceof PermissionDeniedError) return [];
              throw error;
            },
          ),
          // F12-01: Kampagnen-Dropdown (gleiche Schranke/Muster wie Quellen).
          campaigns: await listFunnelCampaigns(tx, ctx).catch(
            (error: unknown) => {
              if (error instanceof PermissionDeniedError) return [];
              throw error;
            },
          ),
        };
      },
    );
    board = loaded.board;
    canCreateManualLead = loaded.canCreate;
    adminColumns = loaded.adminColumns;
    pipelineSummary = loaded.pipelineSummary;
    leadSourceOptions = loaded.sources.map((source) => ({ id: source.id, name: source.name }));
    campaignOptions = loaded.campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      leadSourceName: campaign.leadSourceName,
      assigneeLabel: campaign.assignee?.label ?? null,
    }));
  } catch (error) {
    if (error instanceof NotAuthenticatedError) unauthenticated = true;
    else if (error instanceof PermissionDeniedError) denied = true;
    else throw error;
  }

  if (unauthenticated) {
    redirect(`/login?${new URLSearchParams({ next: boardHref(scope, scoreBand, followUpFilter) }).toString()}`);
  }
  if (denied) return <AccessDenied />;
  if (!board) throw new Error("Anfrage-Board konnte nicht geladen werden");
  if (!pipelineSummary) throw new Error("Pipeline-Kennzahlen konnten nicht geladen werden");

  const columns = board.columns.map(({ id, name }) => ({ id, name }));
  const cards = board.columns.flatMap((column) =>
    column.cards.map((card) => ({ id: card.id, label: card.contactName })),
  );
  const totalCards = cards.length;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-[1480px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md bg-brand-700 text-sm font-bold text-white" aria-hidden="true">
              W
            </span>
            <div>
              <p className="text-sm font-semibold leading-5">WMEE Vertrieb</p>
              <p className="text-xs text-slate-500">Geschützter Arbeitsbereich</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {board.audience === "internal" ? (
              <Link
                href={`/w/${validWorkspaceId}/dashboard`}
                className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
              >
                Übersicht
              </Link>
            ) : null}
            {board.audience === "internal" ? (
              <Link
                href={`/w/${validWorkspaceId}/aufgaben`}
                className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
              >
                Aufgaben
              </Link>
            ) : null}
            {board.permissions.canOpenCatalog ? (
              <Link
                href={`/w/${validWorkspaceId}/katalog`}
                className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
              >
                Produktkatalog
              </Link>
            ) : null}
            {!board.permissions.canMoveCards ? (
              <span className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">
                Nur Lesezugriff
              </span>
            ) : null}
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <nav aria-label="Anfrageansichten" className="mb-6 flex flex-wrap gap-2 border-b border-slate-300">
          <Link
            aria-current="page"
            href={boardHref(scope, scoreBand, followUpFilter)}
            className="inline-flex min-h-11 items-center border-b-2 border-brand-700 px-3 text-sm font-semibold text-brand-800 outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Offen
          </Link>
          <Link
            href={`/w/${validWorkspaceId}/anfragen/abgeschlossen`}
            className="inline-flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-semibold text-slate-600 outline-none hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Abgeschlossen
          </Link>
        </nav>
        <div className="mb-6 flex flex-wrap items-center gap-2" data-testid="board-scope-toggle">
          <Link
            aria-current={scope === "residential" ? "page" : undefined}
            href={boardHref("residential", scoreBand, followUpFilter)}
            className={`inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 ${scope === "residential" ? "border-brand-700 bg-brand-700 text-white" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}
          >
            Wohnbau
          </Link>
          <Link
            aria-current={scope === "commercial" ? "page" : undefined}
            href={boardHref("commercial", scoreBand, followUpFilter)}
            className={`inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 ${scope === "commercial" ? "border-brand-700 bg-brand-700 text-white" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}
          >
            Gewerbe
          </Link>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
            {board.scope === "commercial" ? "Gewerbe-Bereich" : "Wohnbau-Bereich"}
          </span>
        </div>
        {board.audience === "internal" ? (
          <>
          <div className="mb-6 flex flex-wrap items-center gap-2" data-testid="board-score-presets">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">
              Lead-Score
            </span>
            {(
              [
                { band: undefined, label: "Alle" },
                { band: "hot", label: "Heiß" },
                { band: "warm", label: "Warm" },
                { band: "cold", label: "Kalt" },
              ] as Array<{ band: LeadScoreBand | undefined; label: string }>
            ).map((preset) => (
              <Link
                key={preset.label}
                aria-current={scoreBand === preset.band ? "page" : undefined}
                href={boardHref(scope, preset.band, followUpFilter)}
                className={`inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 ${scoreBand === preset.band ? "border-brand-700 bg-brand-700 text-white" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}
              >
                {preset.label}
              </Link>
            ))}
            {scoreBand !== undefined ? (
              <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-800">
                Filter aktiv: {LEAD_SCORE_BAND_LABEL[scoreBand]}
              </span>
            ) : null}
          </div>
          <div className="mb-6 flex flex-wrap items-center gap-2" data-testid="board-followup-presets">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">
              Wiedervorlage
            </span>
            {(
              [
                { filter: undefined, label: "Alle" },
                { filter: "due", label: "Anstehend" },
                { filter: "overdue", label: "Überfällig" },
              ] as Array<{ filter: RequestBoardFollowUpFilter | undefined; label: string }>
            ).map((preset) => (
              <Link
                key={preset.label}
                aria-current={followUpFilter === preset.filter ? "page" : undefined}
                href={boardHref(scope, scoreBand, preset.filter)}
                className={`inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 ${followUpFilter === preset.filter ? "border-brand-700 bg-brand-700 text-white" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}
              >
                {preset.label}
              </Link>
            ))}
            {followUpFilter !== undefined ? (
              <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-800">
                Filter aktiv: {followUpFilter === "due" ? "Anstehend" : "Überfällig"}
              </span>
            ) : null}
          </div>
          </>
        ) : null}
        {canCreateManualLead ? (
          <div className="mb-6 flex flex-wrap items-start gap-3">
            <ManualLeadForm
              workspaceId={validWorkspaceId}
              scope={scope}
              scopeLabel={scope === "commercial" ? "Gewerbe" : "Wohnbau"}
              sources={leadSourceOptions}
              campaigns={campaignOptions}
            />
            <ManualLeadBulkForm
              workspaceId={validWorkspaceId}
              scope={scope}
              scopeLabel={scope === "commercial" ? "Gewerbe" : "Wohnbau"}
            />
            <BoardColumnAdmin
              workspaceId={validWorkspaceId}
              boardId={board.id}
              scopeLabel={scope === "commercial" ? "Gewerbe" : "Wohnbau"}
              columns={adminColumns}
            />
          </div>
        ) : null}
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">Rechner-Leads</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">{board.name}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Neue Solarrechner-Anfragen prüfen, qualifizieren und in die nächste Vertriebsstufe bewegen.
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-right shadow-sm">
            <p className="text-2xl font-semibold tabular-nums">{totalCards}</p>
            <p className="text-xs text-slate-500">offene {totalCards === 1 ? "Anfrage" : "Anfragen"}</p>
          </div>
          <div
            data-testid="pipeline-summary"
            className="rounded-md border border-slate-200 bg-white px-4 py-3 text-right shadow-sm"
          >
            <p className="text-2xl font-semibold tabular-nums">
              {euroFormatter.format(pipelineSummary.totalNetCents / 100)}
            </p>
            <p className="text-xs text-slate-500">Angebotswert</p>
            <p className="mt-1 text-sm font-semibold tabular-nums text-slate-800">
              {pipelineSummary.weightedTotalNetCents === null
                ? "Gewichtet: — (keine Ratio)"
                : `Gewichtet: ${euroFormatter.format(pipelineSummary.weightedTotalNetCents / 100)}`}
            </p>
          </div>
        </div>

        <RequestBoardClient
          workspaceId={validWorkspaceId}
          boardId={board.id}
          columns={columns}
          cards={cards}
          canMove={board.permissions.canMoveCards}
        >
          <div className="grid gap-4 md:grid-cols-2 md:items-start xl:grid-cols-4">
            {board.columns.map((column) => (
              <RequestBoardColumnClient key={column.id} columnId={column.id}>
                <header className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-lg border-b border-slate-200 bg-slate-50/95 px-4 py-3 backdrop-blur">
                  <div className="flex items-center gap-2">
                    <span className={`size-2.5 rounded-full ${columnTone(column)}`} aria-hidden="true" />
                    <h2 className="text-sm font-semibold">{column.name}</h2>
                  </div>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-600 ring-1 ring-slate-200">
                    {column.cards.length}
                  </span>
                </header>
                <ul className="grid list-none gap-3 p-3" aria-label={`Anfragen in ${column.name}`}>
                  {column.cards.length === 0 ? (
                    <li className="rounded-md border border-dashed border-slate-300 bg-white/60 px-4 py-8 text-center text-sm text-slate-500">
                      Keine Anfragen in diesem Status
                    </li>
                  ) : null}
                  {column.cards.map((card) => {
                    const products = productLabels(card);
                    const blockers = blockerLabels(card);
                    return (
                      <li key={card.id}>
                        <RequestBoardCardClient
                          projectId={card.id}
                          currentColumnId={column.id}
                          projectLabel={card.contactName}
                        >
                          <div className="pr-8">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand-800">
                              {card.sourceLabel}
                            </p>
                            <h3 className="mt-1 text-base font-semibold leading-6 text-slate-950">
                              {card.contactName}
                            </h3>
                            <p className="mt-0.5 truncate text-xs text-slate-500">{card.name}</p>
                            {card.score ? (
                              <p className="mt-2">
                                <span
                                  data-testid={`score-${card.id}`}
                                  title={scoreSignalsTitle(card)}
                                  className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${scoreBadgeClass(card.score.band)}`}
                                >
                                  <span aria-hidden="true">●</span>
                                  Score {card.score.value} · {LEAD_SCORE_BAND_LABEL[card.score.band]}
                                </span>
                              </p>
                            ) : null}
                            {card.followUp ? (
                              <p className="mt-2">
                                <span
                                  data-testid={`followup-${card.id}`}
                                  title={`Wiedervorlage fällig am ${followUpDateFormatter.format(new Date(card.followUp.at))} (${FOLLOW_UP_BAND_LABEL[card.followUp.band]})`}
                                  className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${followUpBadgeClass(card.followUp.band)}`}
                                >
                                  <span aria-hidden="true">◷</span>
                                  WV {followUpDateFormatter.format(new Date(card.followUp.at))} · {FOLLOW_UP_BAND_LABEL[card.followUp.band]}
                                </span>
                              </p>
                            ) : null}
                          </div>
                          <p className="mt-3 flex items-center gap-1.5 text-sm text-slate-700">
                            <span aria-hidden="true">⌖</span>
                            {card.locationLabel}
                          </p>
                          {board.audience === "internal" && card.assignment ? (
                            <p className="mt-2 break-words text-xs text-slate-600">
                              <span className="font-semibold text-slate-700">Hauptverantwortung:</span>{" "}
                              {card.assignment.keyAccountLabel ?? "Nicht zugewiesen"}
                            </p>
                          ) : null}
                          {products.length > 0 ? (
                            <ul className="mt-3 flex list-none flex-wrap gap-1.5" aria-label="Angefragte Produkte">
                              {products.map((label) => (
                                <li key={label} className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700">
                                  {label}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {blockers.length > 0 ? (
                            <ul className="mt-3 grid list-none gap-1.5" aria-label="Offene Prüfungen">
                              {blockers.map((label) => (
                                <li key={label} className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
                                  <span aria-hidden="true">△</span>{label}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
                            <time dateTime={card.createdAt} className="text-[11px] tabular-nums text-slate-500">
                              {dateFormatter.format(new Date(card.createdAt))}
                            </time>
                            <Link
                              href={`/w/${validWorkspaceId}/anfragen/${card.id}`}
                              className="rounded text-xs font-semibold text-brand-800 outline-none hover:text-brand-900 hover:underline focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
                            >
                              Projekt öffnen
                            </Link>
                          </div>
                        </RequestBoardCardClient>
                      </li>
                    );
                  })}
                </ul>
              </RequestBoardColumnClient>
            ))}
          </div>
        </RequestBoardClient>
      </div>
    </main>
  );
}
