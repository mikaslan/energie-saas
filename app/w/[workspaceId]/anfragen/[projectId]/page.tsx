import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  getProjectTriageDetail,
  type ProjectTriageDetail,
} from "@/modules/projects";
import { AddressEditor } from "./address-editor";
import { PinForm } from "./pin-form";

export const metadata: Metadata = {
  title: "Projektakte | Energie-SaaS",
};

const routeParamsSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
});

const decimalFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const coordinateFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 5,
  maximumFractionDigits: 6,
});

const percentFormatter = new Intl.NumberFormat("de-DE", {
  style: "percent",
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

type LoadResult =
  | { kind: "loaded"; detail: ProjectTriageDetail | null }
  | { kind: "unauthenticated" }
  | { kind: "denied" };

async function loadProjectDetail(
  workspaceId: string,
  projectId: string,
): Promise<LoadResult> {
  try {
    const detail = await authorizedQuery(
      workspaceId,
      "project.read",
      "project",
      (tx, ctx) => getProjectTriageDetail(tx, ctx, projectId),
    );
    return { kind: "loaded", detail };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return { kind: "unauthenticated" };
    }
    if (error instanceof PermissionDeniedError) {
      return { kind: "denied" };
    }
    throw error;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "Nicht übermittelt";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Nicht übermittelt" : dateFormatter.format(date);
}

function formatNumber(value: number | null, unit?: string): string {
  if (value === null || !Number.isFinite(value)) return "–";
  const formatted = decimalFormatter.format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "–";
  return percentFormatter.format(value);
}

function formatCents(value: number | null): string {
  if (value === null || !Number.isSafeInteger(value)) return "–";

  const negative = value < 0;
  const absoluteCents = Math.abs(value);
  const euros = Math.floor(absoluteCents / 100);
  const remainder = (absoluteCents % 100).toString().padStart(2, "0");
  const groupedEuros = new Intl.NumberFormat("de-DE", {
    maximumFractionDigits: 0,
  }).format(euros);

  return `${negative ? "−" : ""}${groupedEuros},${remainder}\u00a0€`;
}

function formatInvestmentRange(low: number | null, high: number | null): string {
  const lowLabel = formatCents(low);
  const highLabel = formatCents(high);
  if (lowLabel === "–" && highLabel === "–") return "–";
  if (lowLabel === "–") return `bis ${highLabel}`;
  if (highLabel === "–") return `ab ${lowLabel}`;
  return `${lowLabel} – ${highLabel}`;
}

function phaseLabel(value: string): string {
  return value === "request" ? "Anfrage" : value;
}

function outcomeLabel(value: string): string {
  if (value === "open") return "Offen";
  if (value === "won") return "Gewonnen";
  if (value === "lost") return "Verloren";
  return value;
}

function branchLabel(value: string | null): string {
  if (value === "new_installation") return "Neuanlage";
  if (value === "existing_installation") return "Bestehende Anlage";
  return value ?? "Nicht übermittelt";
}

function addressModeLabel(value: string): string {
  if (value === "selected") return "Ausgewählte Adresse";
  if (value === "regional_estimate") return "Regionale Schätzung";
  return "Nicht klassifiziert";
}

function precisionLabel(value: string | null): string {
  if (value === "house") return "Hausgenau";
  if (value === "street") return "Straßengenau";
  if (value === "locality") return "Ortsgenau";
  if (value === "region") return "Regional";
  return "Nicht klassifiziert";
}

function integrityLabel(value: string | null): string {
  return value === "client_reported_unverified"
    ? "Vom Rechner gemeldet, ungeprüft"
    : value ?? "Nicht übermittelt";
}

function priceSourceLabel(value: string | null): string {
  return value === "market_estimate"
    ? "Marktschätzung"
    : value ?? "Nicht übermittelt";
}

function YesNo({ value }: { value: boolean }) {
  return (
    <span
      className={
        value
          ? "inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-800"
          : "inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600"
      }
    >
      {value ? "Ja" : "Nein"}
    </span>
  );
}

function DetailItem({
  term,
  children,
  numeric = false,
}: {
  term: string;
  children: React.ReactNode;
  numeric?: boolean;
}) {
  return (
    <div className="grid gap-1 border-b border-slate-100 py-3 last:border-b-0 sm:grid-cols-[minmax(9rem,0.8fr)_minmax(0,1.2fr)] sm:gap-5">
      <dt className="text-sm text-slate-500">{term}</dt>
      <dd
        className={`min-w-0 text-sm font-medium text-slate-900 ${
          numeric ? "tabular-nums" : ""
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

function Section({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-950">{title}</h2>
        {intro ? <p className="mt-1 text-sm leading-6 text-slate-600">{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

function DeniedState() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-6 py-12">
      <section className="w-full rounded-lg border border-amber-200 bg-amber-50 p-6 sm:p-8">
        <p className="text-sm font-semibold text-amber-800">Zugriff eingeschränkt</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">
          Diese Projektakte ist für dich nicht freigegeben.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-700">
          Dir fehlt die Berechtigung für diesen Workspace. Es wurden keine
          Projektdaten geladen. Wende dich bei Bedarf an eine
          Workspace-Administration.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Zur Startseite
        </Link>
      </section>
    </main>
  );
}

export default async function ProjectTriagePage({
  params,
}: PageProps<"/w/[workspaceId]/anfragen/[projectId]">) {
  const parsedParams = routeParamsSchema.safeParse(await params);
  if (!parsedParams.success) notFound();

  const { workspaceId, projectId } = parsedParams.data;
  const detailPath = `/w/${workspaceId}/anfragen/${projectId}`;
  const result = await loadProjectDetail(workspaceId, projectId);

  if (result.kind === "unauthenticated") {
    redirect(`/login?next=${encodeURIComponent(detailPath)}`);
  }
  if (result.kind === "denied") return <DeniedState />;
  if (result.detail === null) notFound();

  const detail = result.detail;
  const activeBlockers = [
    detail.blockers.dedupeReviewRequired
      ? "Mögliche Dublette muss geprüft werden"
      : null,
    detail.blockers.addressFollowUpRequired
      ? "Adresse muss nachbearbeitet werden"
      : null,
    detail.blockers.pinConfirmationRequired
      ? "Planungs-Pin ist noch nicht bestätigt"
      : null,
    detail.blockers.catalogResolutionPending
      ? "Katalogzuordnung ist noch offen"
      : null,
  ].filter((blocker): blocker is string => blocker !== null);
  const coordinates =
    detail.site.latitude !== null
    && detail.site.longitude !== null
    && Number.isFinite(detail.site.latitude)
    && Number.isFinite(detail.site.longitude)
      ? `${coordinateFormatter.format(detail.site.latitude)}, ${coordinateFormatter.format(detail.site.longitude)}`
      : "Nicht verfügbar";

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <nav aria-label="Brotkrumen" className="mb-6 flex items-start justify-between gap-4">
          <Link
            href={`/w/${workspaceId}/anfragen`}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            <span aria-hidden="true" className="mr-2">←</span>
            Zurück zu den Anfragen
          </Link>
          <SignOutButton />
        </nav>

        <header className="mb-8 border-b border-slate-200 pb-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-blue-700">Projektakte</p>
              <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
                {detail.contact.displayName}
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                {detail.project.name} · Erstellt am {formatDate(detail.project.createdAt)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2" aria-label="Projektstatus">
              <span className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                {phaseLabel(detail.project.phase)}
              </span>
              <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-800">
                {outcomeLabel(detail.project.outcome)} · {detail.project.columnName}
              </span>
            </div>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] lg:items-start">
          <div className="grid min-w-0 gap-6">
            <Section title="Identität und Kontakt">
              <dl>
                <DetailItem term="Ansprechperson">{detail.contact.displayName}</DetailItem>
                <DetailItem term="E-Mail">
                  {detail.contact.email ?? "Nicht übermittelt"}
                </DetailItem>
                <DetailItem term="Telefon">
                  {detail.contact.phone ?? "Nicht übermittelt"}
                </DetailItem>
                <DetailItem term="Projekt-ID">
                  <code className="break-all font-mono text-xs font-normal text-slate-700">
                    {detail.project.id}
                  </code>
                </DetailItem>
              </dl>
            </Section>

            <Section
              title="Adresse und Qualität"
              intro="Die Qualitätsangaben bestimmen, ob der Standort als Planungs-Pin bestätigt werden darf."
            >
              <dl>
                <DetailItem term="Adresse">
                  {detail.site.formattedAddress ?? "Nicht übermittelt"}
                </DetailItem>
                <DetailItem term="Adressmodus">
                  {addressModeLabel(detail.site.addressMode)}
                </DetailItem>
                <DetailItem term="Genauigkeit">
                  {precisionLabel(detail.site.precision)}
                </DetailItem>
                <DetailItem term="Koordinaten" numeric>{coordinates}</DetailItem>
                <DetailItem term="Planungs-Pin">
                  {detail.site.pinConfirmed ? "Bestätigt" : "Nicht bestätigt"}
                </DetailItem>
                <DetailItem term="Adressrevision" numeric>
                  {detail.site.addressRevision}
                </DetailItem>
                <DetailItem term="Pinlage">
                  {detail.site.addressMode !== "selected"
                    ? "Noch nicht hausgenau bewertet"
                    : detail.site.pinAdjusted
                      ? "Gegenüber dem Hauspunkt angepasst"
                      : "Am ermittelten Hauspunkt"}
                </DetailItem>
                <DetailItem term="Adressprüfung">
                  {detail.site.addressFollowUpRequired
                    ? "Nachbearbeitung erforderlich"
                    : "Keine Nachbearbeitung markiert"}
                </DetailItem>
              </dl>
              {detail.permissions.canCorrectAddress ? (
                <div className="mt-5 border-t border-slate-200 pt-5">
                  <AddressEditor
                    workspaceId={workspaceId}
                    projectId={projectId}
                    addressRevision={detail.site.addressRevision}
                  />
                </div>
              ) : null}
            </Section>

            <Section title="Bedarf">
              <dl>
                <DetailItem term="Vorhaben">{branchLabel(detail.requirements.branch)}</DetailItem>
                <DetailItem term="Gewünschter Speicher" numeric>
                  {formatNumber(detail.requirements.targetStorageKwh, "kWh")}
                </DetailItem>
                <DetailItem term="Wallbox"><YesNo value={detail.requirements.wallbox} /></DetailItem>
                <DetailItem term="Bidirektionales Laden">
                  <YesNo value={detail.requirements.bidirectionalCharging} />
                </DetailItem>
                <DetailItem term="Ersatzstrom"><YesNo value={detail.requirements.backupPower} /></DetailItem>
              </dl>
            </Section>

            <Section title="Rechner-Schätzung">
              <div
                role="note"
                className="mb-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3"
              >
                <p className="font-semibold text-amber-950">
                  {detail.calculatorEstimate.label}
                </p>
                <p className="mt-1 text-sm leading-6 text-amber-900">
                  Diese Werte wurden noch nicht fachlich geprüft und dürfen
                  nicht als Angebots- oder Preisgrundlage verwendet werden.
                </p>
              </div>
              <dl>
                <DetailItem term="PV-Leistung" numeric>
                  {formatNumber(detail.calculatorEstimate.systemPeakPowerKwp, "kWp")}
                </DetailItem>
                <DetailItem term="Speicherkapazität" numeric>
                  {formatNumber(detail.calculatorEstimate.storageCapacityKwh, "kWh")}
                </DetailItem>
                <DetailItem term="Autarkiegrad" numeric>
                  {formatPercent(detail.calculatorEstimate.autonomyRate)}
                </DetailItem>
                <DetailItem term="Investitionsrahmen" numeric>
                  {formatInvestmentRange(
                    detail.calculatorEstimate.investmentLowCents,
                    detail.calculatorEstimate.investmentHighCents,
                  )}
                </DetailItem>
                <DetailItem term="Amortisation" numeric>
                  {formatNumber(detail.calculatorEstimate.amortizationYears, "Jahre")}
                </DetailItem>
              </dl>
            </Section>

            <Section title="Quelle und technische Provenienz">
              <dl>
                <DetailItem term="Quelle">{detail.source.label}</DetailItem>
                <DetailItem term="Eingegangen">{formatDate(detail.source.submittedAt)}</DetailItem>
                <DetailItem term="Rechner-Engine">
                  {detail.source.calculatorEngine ?? "Nicht übermittelt"}
                </DetailItem>
                <DetailItem term="Producer-Revision">
                  <span className="break-all font-mono text-xs font-normal">
                    {detail.source.producerRevision ?? "Nicht übermittelt"}
                  </span>
                </DetailItem>
                <DetailItem term="Ergebnisqualität">
                  {integrityLabel(detail.calculatorEstimate.integrity)}
                </DetailItem>
                <DetailItem term="Preisquelle">
                  {priceSourceLabel(detail.calculatorEstimate.priceSource)}
                </DetailItem>
              </dl>
            </Section>
          </div>

          <aside className="grid gap-6 lg:sticky lg:top-6">
            <Section title="Blocker">
              {activeBlockers.length > 0 ? (
                <ul className="grid gap-2">
                  {activeBlockers.map((blocker) => (
                    <li
                      key={blocker}
                      className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm leading-5 text-amber-950"
                    >
                      <span aria-hidden="true" className="font-bold">!</span>
                      <span>{blocker}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
                  Keine offenen Triage-Blocker.
                </p>
              )}
            </Section>

            <Section title="Standortfreigabe">
              {detail.permissions.canConfirmPin ? (
                <PinForm
                  workspaceId={workspaceId}
                  projectId={projectId}
                  addressRevision={detail.site.addressRevision}
                />
              ) : !detail.permissions.canMoveCard ? (
                <div
                  role="status"
                  className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3"
                >
                  <p className="text-sm font-semibold text-slate-900">Nur Lesezugriff</p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    Du kannst die Projektakte ansehen, aber keine Pin-Bestätigung ausführen.
                  </p>
                </div>
              ) : detail.site.pinConfirmed ? (
                <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm font-semibold text-emerald-900">
                  Der Planungs-Pin ist bestätigt.
                </p>
              ) : (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm leading-6 text-amber-950">
                  Die aktuelle Adressqualität erlaubt noch keine Pin-Bestätigung.
                </p>
              )}
            </Section>
          </aside>
        </div>
      </div>
    </main>
  );
}
