import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { SignOutButton } from "@/app/_components/sign-out-button";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  getCatalogImport,
  CatalogImportIntegrityError,
  listCatalogImportRows,
  type CatalogImportDetails,
  type CatalogImportRowReadModel,
} from "@/modules/catalog";
import { DeniedState } from "../../../_ui";
import { ImportControls } from "./import-controls";
import {
  expectedCatalogImportPageSize,
  nextCatalogImportAfterRow,
  parseCatalogImportAfterRow,
  previousCatalogImportAfterRow,
} from "./pagination";
import { StatusRefresh } from "./status-refresh";

export const metadata: Metadata = { title: "CSV-Importstatus | Energie-SaaS" };

const paramsSchema = z.strictObject({ workspaceId: z.uuid(), importId: z.uuid() });
const stateLabels: Record<CatalogImportDetails["state"], string> = {
  "ready_for_review": "Bereit zur Prüfung",
  "queued": "Eingeplant",
  "running": "Wird verarbeitet",
  "retry_wait": "Technischer Wiederholungsversuch",
  "succeeded": "Erfolgreich abgeschlossen",
  "partial": "Teilweise abgeschlossen",
  "failed_final": "Endgültig fehlgeschlagen",
  "cancelled_before_start": "Vor Start abgebrochen",
};
const jobErrorLabels: Record<string, string> = {
  actor_revoked: "Die ausführende Person besitzt keinen Workspacezugriff mehr.",
  capability_revoked: "Die erforderlichen Katalog- oder Preisrechte wurden entzogen.",
  lease_lost: "Eine Verarbeitungslaufzeit ist abgelaufen; der Worker wiederholt sicher.",
  enqueue_failed: "Die Verarbeitung konnte noch nicht erneut eingeplant werden.",
  invalid_persisted_input: "Die gespeicherte Vorschau hat eine Integritätsprüfung nicht bestanden.",
  technical_retry_exhausted: "Drei technische Wiederholungsversuche sind fehlgeschlagen.",
  all_rows_conflicted: "Alle validen Zeilen kollidieren mit einem neueren Katalogstand.",
  queue_locator_invalid: "Ein ungültiger Queue-Verweis wurde isoliert.",
};

type ImportLoad =
  | { kind: "loaded"; details: CatalogImportDetails; rows: readonly CatalogImportRowReadModel[] }
  | { kind: "not_found" }
  | { kind: "unauthenticated" }
  | { kind: "denied" };

async function loadImport(
  workspaceId: string,
  importId: string,
  afterRow: number,
): Promise<ImportLoad> {
  try {
    return await authorizedQuery(
      workspaceId,
      "catalog.manage",
      "catalog_import_details",
      async (tx, ctx) => {
        const details = await getCatalogImport(tx, ctx, { importId });
        if (details === null) return { kind: "not_found" as const };
        if (afterRow !== 1 && afterRow > details.counts.total) {
          return { kind: "not_found" as const };
        }
        const page = await listCatalogImportRows(tx, ctx, {
          importId,
          afterRow,
          limit: 100,
        });
        const expectedCount = expectedCatalogImportPageSize(
          details.counts.total,
          afterRow,
        );
        if (page.rows.length !== expectedCount) {
          throw new CatalogImportIntegrityError();
        }
        return {
          kind: "loaded" as const,
          details,
          rows: page.rows,
        };
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

function formatDate(value: string | null): string {
  if (value === null) return "–";
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(new Date(value));
}

function formatCents(value: number): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
  }).format(value / 100);
}

function technicalSummary(
  command: NonNullable<CatalogImportRowReadModel["sourceCommand"]>,
): string {
  const technical = command.technicalData;
  switch (technical.schemaVersion) {
    case "module.v1": return `${technical.nominalPowerWatts.toLocaleString("de-DE")} Wp`;
    case "inverter.v1": return `${technical.nominalAcPowerWatts.toLocaleString("de-DE")} W AC, ${technical.phaseCount}-phasig`;
    case "battery.v1": return `${technical.usableCapacityWh.toLocaleString("de-DE")} Wh nutzbar`;
    case "wallbox.v1": return `${technical.maxChargingPowerWatts.toLocaleString("de-DE")} W`;
    case "heat_pump.v1": return `${technical.nominalHeatingPowerWatts.toLocaleString("de-DE")} W, SCOP ${(technical.scopHundredths / 100).toLocaleString("de-DE")}`;
    case "mounting.v1": return technical.systemName;
    case "other.v1": return `${technical.attributes.length} strukturierte Attribute`;
  }
}

function stateTone(state: CatalogImportDetails["state"]): string {
  if (state === "succeeded") return "border-emerald-200 bg-emerald-50 text-emerald-950";
  if (state === "partial" || state === "retry_wait") return "border-amber-300 bg-amber-50 text-amber-950";
  if (state === "failed_final" || state === "cancelled_before_start") return "border-red-200 bg-red-50 text-red-950";
  return "border-blue-200 bg-blue-50 text-blue-950";
}

export default async function CatalogImportDetailsPage({
  params,
  searchParams,
}: PageProps<"/w/[workspaceId]/katalog/importe/[importId]">) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const rawSearch = await searchParams;
  const afterRow = parseCatalogImportAfterRow(rawSearch.after);
  if (afterRow === null) notFound();
  const { workspaceId, importId } = parsed.data;
  const detailPath = `/w/${workspaceId}/katalog/importe/${importId}`;
  const currentPath = afterRow === 1 ? detailPath : `${detailPath}?after=${afterRow}`;
  const result = await loadImport(workspaceId, importId, afterRow);
  if (result.kind === "unauthenticated") {
    redirect(`/login?next=${encodeURIComponent(currentPath)}`);
  }
  if (result.kind === "denied") {
    return <DeniedState title="Dieser CSV-Import ist für dich nicht freigegeben." />;
  }
  if (result.kind === "not_found") notFound();
  const { details, rows } = result;
  const visibleState = details.snapshotRedactedAt === null ? details.state : "snapshot_redacted";
  const firstVisibleRow = rows.at(0)?.rowNumber ?? null;
  const lastVisibleRow = rows.at(-1)?.rowNumber ?? null;
  const previousAfterRow = previousCatalogImportAfterRow(afterRow);
  const nextAfterRow = nextCatalogImportAfterRow(
    details.counts.total,
    lastVisibleRow,
  );

  return (
    <main className="min-h-screen bg-slate-50" data-catalog-import-detail-state={visibleState}>
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <nav aria-label="Bereichsnavigation" className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <Link href={`/w/${workspaceId}/katalog`} className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
            <span aria-hidden="true" className="mr-2">←</span>
            Zum Produktkatalog
          </Link>
          <SignOutButton />
        </nav>

        <header className="mb-8 border-b border-slate-200 pb-7">
          <p className="text-sm font-semibold text-blue-700">Revisionsgebundener CSV-Import</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
            {details.fileName ?? "Geschützte Importvorschau"}
          </h1>
          <p className="mt-2 font-mono text-xs text-slate-500">Import {details.importId}</p>
        </header>

        <div className="grid gap-6">
          <section aria-labelledby="import-status-title" className={`rounded-lg border p-5 sm:p-6 ${stateTone(details.state)}`}>
            <h2 id="import-status-title" className="text-lg font-semibold">{stateLabels[details.state]}</h2>
            <p className="mt-2 text-sm leading-6">
              {details.errorCode ? jobErrorLabels[details.errorCode] ?? "Der Import besitzt einen festen technischen Fehlercode." : "Der Status stammt aus dem autoritativen Importjob."}
            </p>
            {details.state === "retry_wait" && details.nextAttemptAt ? <p className="mt-2 text-sm">Nächster Versuch: {formatDate(details.nextAttemptAt)}</p> : null}
            <div className="mt-4"><StatusRefresh state={details.state} /></div>
          </section>

          <section aria-labelledby="import-counts-title" className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 id="import-counts-title" className="text-lg font-semibold text-slate-950">Zeilen und Ergebnisse</h2>
            <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div><dt className="text-slate-500">Gesamt</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-slate-950">{details.counts.total}</dd></div>
              <div><dt className="text-slate-500">Valide</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-emerald-800">{details.counts.valid}</dd></div>
              <div><dt className="text-slate-500">Fehlerhaft</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-red-800">{details.counts.invalid}</dd></div>
              <div><dt className="text-slate-500">Konflikte</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-amber-800">{details.resultCounts.conflict}</dd></div>
            </dl>
            <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-200 pt-5 text-sm sm:grid-cols-4">
              <div><dt className="text-slate-500">Neu</dt><dd className="mt-1 font-semibold tabular-nums text-slate-950">{details.resultCounts.created}</dd></div>
              <div><dt className="text-slate-500">Revidiert</dt><dd className="mt-1 font-semibold tabular-nums text-slate-950">{details.resultCounts.revised}</dd></div>
              <div><dt className="text-slate-500">Unverändert</dt><dd className="mt-1 font-semibold tabular-nums text-slate-950">{details.resultCounts.unchanged}</dd></div>
              <div><dt className="text-slate-500">Erstellt</dt><dd className="mt-1 font-semibold text-slate-950">{formatDate(details.createdAt)}</dd></div>
            </dl>
            {details.counts.invalid > 0 ? (
              <a href={`${detailPath}/fehlerbericht`} className="mt-5 inline-flex min-h-11 items-center rounded-md border border-red-300 bg-white px-4 text-sm font-semibold text-red-800 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2">
                Fehlerbericht herunterladen
              </a>
            ) : null}
          </section>

          {details.snapshotRedactedAt !== null ? (
            <section aria-labelledby="redacted-title" className="rounded-lg border border-slate-300 bg-white p-5 shadow-sm sm:p-6">
              <h2 id="redacted-title" className="text-lg font-semibold text-slate-950">Vorschau datenschutzgerecht entfernt</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">Dateiname, Mapping, normalisierte SKU, Commands und freie Fehlerquellen wurden nach der Aufbewahrungsfrist atomar redigiert. Ergebniszähler und Produktrevisionen bleiben als Nachweis erhalten.</p>
              <p className="mt-2 text-sm text-slate-500">Redigiert: {formatDate(details.snapshotRedactedAt)}</p>
            </section>
          ) : null}

          <section aria-labelledby="import-preview-title" className="grid gap-4">
              <div>
                <h2 id="import-preview-title" className="text-lg font-semibold text-slate-950">
                  {details.snapshotRedactedAt === null
                    ? "Geschützte normalisierte Vorschau"
                    : "Redigierte Fehler und Ergebnisse"}
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  {details.snapshotRedactedAt === null
                    ? "Technik, EK, VK und Herkunft sind nur innerhalb der Importberechtigung sichtbar."
                    : "Feste Fehlercodes, Verarbeitungsergebnisse und Produktlinks bleiben als Nachweis erhalten."}
                </p>
              </div>
              <ol className="grid gap-4">
                {rows.map((row) => {
                  const command = row.sourceCommand;
                  const commercial = command?.commercial;
                  const snapshotVisible = details.snapshotRedactedAt === null;
                  return (
                    <li key={row.rowNumber} className={row.validationStatus === "invalid" ? "rounded-lg border border-red-200 bg-red-50 p-5" : "rounded-lg border border-slate-200 bg-white p-5 shadow-sm"}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-700">CSV-Zeile {row.rowNumber}</p>
                          <h3 className="mt-1 font-semibold text-slate-950">
                            {snapshotVisible
                              ? command?.presentation.displayName ?? "Fehlerhafte Zeile"
                              : row.validationStatus === "invalid" ? "Fehlerhafte Zeile" : "Verarbeitete Zeile"}
                          </h3>
                          {snapshotVisible && row.normalizedSku ? <p className="mt-1 font-mono text-xs text-blue-700">{row.normalizedSku}</p> : null}
                        </div>
                        <span className={row.validationStatus === "valid" ? "rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-900" : "rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-900"}>{row.validationStatus === "valid" ? row.operation === "create" ? "Neu" : row.operation === "revise" ? "Revision" : "Unverändert" : "Fehler"}</span>
                      </div>
                      {snapshotVisible && command && commercial ? (
                        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                          <div><dt className="text-slate-500">Technik</dt><dd className="mt-1 font-medium text-slate-950">{technicalSummary(command)}</dd></div>
                          <div><dt className="text-slate-500">EK netto</dt><dd className="mt-1 font-medium tabular-nums text-slate-950">{formatCents(commercial.purchasePriceNetCents)}</dd></div>
                          <div><dt className="text-slate-500">VK netto</dt><dd className="mt-1 font-medium tabular-nums text-slate-950">{formatCents(commercial.salesPriceNetCents)}</dd></div>
                          <div><dt className="text-slate-500">Herkunft</dt><dd className="mt-1 break-words font-medium text-slate-950">{command.technicalProvenance.reference} · {command.technicalProvenance.observedOn}</dd></div>
                        </dl>
                      ) : null}
                      {row.errors ? (
                        <ul aria-label={`Fehler in CSV-Zeile ${row.rowNumber}`} className="mt-4 grid gap-2">
                          {row.errors.map((error, index) => <li key={`${error.code}-${index}`} className="text-sm text-red-950"><span className="font-semibold">{error.code}</span>: {error.message}{error.field ? ` (${error.field})` : ""}{snapshotVisible && error.sourceHeader ? ` · Quellspalte: ${error.sourceHeader}` : ""}</li>)}
                        </ul>
                      ) : null}
                      {row.result?.componentId ? (
                        <Link href={`/w/${workspaceId}/katalog/${row.result.componentId}`} className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 hover:text-blue-900">Ergebnisprodukt öffnen <span aria-hidden="true" className="ml-2">→</span></Link>
                      ) : row.result?.state === "conflict" ? <p className="mt-4 text-sm font-medium text-amber-900">Verarbeitungskonflikt: {row.result.errorCode}</p> : null}
                    </li>
                  );
                })}
              </ol>
              <nav aria-label="Importzeilen-Seiten" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm">
                <p className="text-slate-600">
                  {firstVisibleRow !== null && lastVisibleRow !== null
                    ? `Datenzeilen ${firstVisibleRow - 1}–${lastVisibleRow - 1} von ${details.counts.total.toLocaleString("de-DE")}`
                    : "Keine Zeilen auf dieser Seite"}
                </p>
                <div className="flex gap-3">
                  {previousAfterRow !== null ? (
                    <Link prefetch={false} href={previousAfterRow === 1 ? detailPath : `${detailPath}?after=${previousAfterRow}`} rel="prev" className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 font-semibold text-blue-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Vorherige 100</Link>
                  ) : null}
                  {nextAfterRow !== null ? (
                    <Link prefetch={false} href={`${detailPath}?after=${nextAfterRow}`} rel="next" className="inline-flex min-h-11 items-center rounded-md border border-blue-700 px-4 font-semibold text-blue-700 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Nächste 100</Link>
                  ) : null}
                </div>
              </nav>
          </section>

          <ImportControls workspaceId={workspaceId} importId={importId} importState={details.state} validCount={details.counts.valid} />
        </div>
      </div>
    </main>
  );
}
