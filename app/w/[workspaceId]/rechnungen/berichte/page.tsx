import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import {
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_SINGULAR_LABELS,
  PAYMENT_STATUS_LABELS,
  formatEuro,
} from "../labels";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import {
  INVOICING_REPORT_COMMAND_VERSION,
  type InvoicingReportV1,
} from "@/lib/integrations/invoicing/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import { getInvoicingReport } from "@/modules/invoicing";
import { DeniedState } from "../../_ui";

export const metadata: Metadata = {
  title: "Berichte | Rechnungen & Dokumente | Energie-SaaS",
};

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const monthSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/u);

function currentBerlinMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function formatDelta(current: number, previous: number | null): string {
  if (previous === null) return "Kein Vormonat";
  const delta = current - previous;
  if (delta === 0) return "±0,00 € zum Vormonat";
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${formatEuro(Math.abs(delta))} zum Vormonat`;
}

function KpiCard({
  title,
  valueCents,
  previousCents,
}: {
  title: string;
  valueCents: number;
  previousCents: number | null;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">{title}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">{formatEuro(valueCents)}</p>
      <p className="mt-1 text-xs text-slate-500">{formatDelta(valueCents, previousCents)}</p>
    </div>
  );
}

function StatusBucketRow({ label, cents, count }: { label: string; cents: number; count?: number }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-2 last:border-b-0">
      <span className="text-sm text-slate-700">
        {label}{count !== undefined ? <span className="text-xs text-slate-500"> ({count})</span> : null}
      </span>
      <span className="text-sm font-semibold tabular-nums text-slate-900">{formatEuro(cents)}</span>
    </div>
  );
}

export default async function InvoicingReportsPage(
  props: PageProps<"/w/[workspaceId]/rechnungen/berichte">,
) {
  const parsed = workspaceIdSchema.safeParse((await props.params).workspaceId);
  if (!parsed.success) notFound();
  const workspaceId = parsed.data;

  const rawSearch = await props.searchParams;
  const monthValue = firstQueryValue(rawSearch.monat);
  // DECIDED (Kimi-P3-1): die Seite fällt bei ungültigem monat still auf den
  // aktuellen Monat zurück (Formularsteuerung); die CSV-Route antwortet mit
  // 400 (API-Parameter). Bewusst unterschiedliche Ebenen.
  const month = monthValue !== undefined && monthSchema.safeParse(monthValue).success
    ? monthValue
    : currentBerlinMonth();

  let report: InvoicingReportV1 | null = null;
  try {
    report = await authorizedQuery(
      workspaceId,
      "invoicing.read",
      "invoicing_report",
      (tx, ctx) => getInvoicingReport(tx, ctx, {
        schemaVersion: INVOICING_REPORT_COMMAND_VERSION,
        month,
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({ next: `/w/${workspaceId}/rechnungen/berichte` }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Berichte sind für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!report) throw new Error("Bericht konnte nicht geladen werden");

  const buckets = report.revenueByStatus;
  const overdue = report.overdueBuckets;
  const csvUrl = `/w/${workspaceId}/rechnungen/berichte/csv?monat=${encodeURIComponent(month)}`;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Berichte</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Monatsübersicht {month}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Einnahmen, Zahlungseingänge und offene Posten auf einen Blick.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <form method="GET" action={`/w/${workspaceId}/rechnungen/berichte`} className="inline">
            <label htmlFor="report-month" className="sr-only">Monat wählen</label>
            <input
              id="report-month"
              type="month"
              name="monat"
              defaultValue={month}
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
            />
            <button
              type="submit"
              className="ml-2 inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Anzeigen
            </button>
          </form>
          <Link
            href={csvUrl}
            className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Daten herunterladen (CSV)
          </Link>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          title="Einnahmen diesen Monat"
          valueCents={report.revenueThisMonthCents}
          previousCents={report.previousMonth.revenueCents}
        />
        <KpiCard
          title="Zahlungseingänge diesen Monat"
          valueCents={report.cashflowThisMonthCents}
          previousCents={report.previousMonth.cashflowCents}
        />
        <KpiCard
          title="Ausstehend"
          valueCents={report.outstandingCents}
          previousCents={report.previousMonth.outstandingCents}
        />
        <KpiCard
          title="Überfällig"
          valueCents={report.overdueCents}
          previousCents={report.previousMonth.overdueCents}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section aria-label="Einnahmen nach Status" className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-semibold text-slate-950">Einnahmen nach Status</h3>
          <div className="mt-3">
            <StatusBucketRow label="Versendet" cents={buckets.sentCents} count={buckets.sentCount} />
            <StatusBucketRow label="Bezahlt" cents={buckets.paidCents} count={buckets.paidCount} />
            <StatusBucketRow label="Überfällig" cents={buckets.overdueCents} count={buckets.overdueCount} />
            <StatusBucketRow label="Entwurf" cents={buckets.draftCents} count={buckets.draftCount} />
            <StatusBucketRow label="Storniert" cents={buckets.voidedCents} count={buckets.voidedCount} />
          </div>
        </section>

        <section aria-label="Überfälligkeitsbericht" className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-semibold text-slate-950">Überfälligkeit</h3>
          <div className="mt-3">
            <StatusBucketRow label="0–30 Tage" cents={overdue.days0To30Cents} />
            <StatusBucketRow label="31–60 Tage" cents={overdue.days31To60Cents} />
            <StatusBucketRow label="61–90 Tage" cents={overdue.days61To90Cents} />
            <StatusBucketRow label="Über 90 Tage" cents={overdue.over90Cents} />
            <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2">
              <span className="text-sm font-semibold text-slate-900">Insgesamt ausstehend</span>
              <span className="text-sm font-semibold tabular-nums text-slate-900">
                {formatEuro(overdue.totalOutstandingCents)}
              </span>
            </div>
          </div>
        </section>
      </div>

      <section aria-label="Neueste Dokumente" className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold text-slate-950">Neueste Dokumente</h3>
        {report.latestDocuments.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-600">
            Keine Einträge
          </p>
        ) : (
          <ul className="mt-3 grid list-none gap-1">
            {report.latestDocuments.map((document) => (
              <li
                key={document.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 py-2 last:border-b-0"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-900">{document.name}</span>
                  <span className="block text-xs text-slate-500">
                    {DOCUMENT_TYPE_SINGULAR_LABELS[document.type as keyof typeof DOCUMENT_TYPE_SINGULAR_LABELS]}
                    {" · "}
                    {DOCUMENT_STATUS_LABELS[document.status] ?? document.status}
                    {document.paymentStatus !== null
                      ? ` · ${PAYMENT_STATUS_LABELS[document.paymentStatus] ?? document.paymentStatus}`
                      : ""}
                  </span>
                </span>
                <span className="text-sm font-semibold tabular-nums text-slate-900">
                  {formatEuro(document.grossCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
