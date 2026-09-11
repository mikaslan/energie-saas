import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import {
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPE_SINGULAR_LABELS,
  PAYMENT_STATUS_LABELS,
  VOID_REASON_LABELS,
  formatBerlinDate,
  formatDateOnly,
  formatEuro,
} from "../../labels";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import {
  COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
  commercialDocumentTypes,
} from "@/lib/integrations/invoicing/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  InvoicingNotFoundError,
  getDocumentDetail,
  listDepositCandidates,
  listPartialInvoices,
} from "@/modules/invoicing";
import { DeniedState } from "../../../_ui";
import { DepositLinkPanel } from "./deposit-link-panel";
import { DuplicateDocumentPanel } from "./duplicate-document-panel";
import { PartialInvoicePanel } from "./partial-invoice-panel";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const typeSchema = z.enum(commercialDocumentTypes);
const documentIdSchema = z.uuid();

// F5-02 Belegdetail (read-only, ESTIMATE-Layout): Kopf, Beträge, Skonto,
// Positionen, Storno — nur gespeicherte Werte, keine Ableitungen.
export default async function InvoicingDocumentDetailPage(
  props: PageProps<"/w/[workspaceId]/rechnungen/[type]/[documentId]">,
) {
  const params = await props.params;
  const parsedWorkspace = workspaceIdSchema.safeParse(params.workspaceId);
  const parsedType = typeSchema.safeParse(params.type);
  const parsedDocument = documentIdSchema.safeParse(params.documentId);
  if (!parsedWorkspace.success || !parsedType.success || !parsedDocument.success) {
    notFound();
  }
  const workspaceId = parsedWorkspace.data;
  const type = parsedType.data;
  const documentId = parsedDocument.data;
  const listHref = `/w/${workspaceId}/rechnungen/${type}`;

  const detail = await (async () => {
    try {
      return await authorizedQuery(
        workspaceId,
        "invoicing.read",
        "commercial_document_detail",
        (tx, ctx) => getDocumentDetail(tx, ctx, {
          schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
          type,
          documentId,
        }),
      );
    } catch (error) {
      if (error instanceof NotAuthenticatedError) {
        redirect(`/login?${new URLSearchParams({ next: `/w/${workspaceId}/rechnungen/${type}/${documentId}` }).toString()}`);
      }
      if (error instanceof PermissionDeniedError) {
        return null;
      }
      if (error instanceof InvoicingNotFoundError) {
        notFound();
      }
      throw error;
    }
  })();

  if (!detail) {
    return <DeniedState title={`Dieses ${DOCUMENT_TYPE_SINGULAR_LABELS[type]} ist für dich nicht freigegeben.`} />;
  }

  const candidates = type === "invoice" && detail.document.permissions.canWrite
    ? await (async () => {
      try {
        return await authorizedQuery(
          workspaceId,
          "invoicing.read",
          "commercial_document_deposit_candidates",
          (tx, ctx) => listDepositCandidates(tx, ctx, {
            schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
            type,
            documentId,
          }),
        );
      } catch (error) {
        if (error instanceof PermissionDeniedError) return [];
        throw error;
      }
    })()
    : [];

  // F8-05: Teilrechnungskette nur zur AB (reine Anzeige ohne
  // Schreibrecht; Fehler ohne Recht → leere Kette, Seite bleibt lesbar).
  const partialChain = type === "order_confirmation"
    ? await (async () => {
      try {
        return await authorizedQuery(
          workspaceId,
          "invoicing.read",
          "commercial_document_partial",
          (tx, ctx) => listPartialInvoices(tx, ctx, { orderId: documentId }),
        );
      } catch (error) {
        if (error instanceof PermissionDeniedError) return null;
        throw error;
      }
    })()
    : null;

  const { document, lines } = detail;
  // F8-04: Gutschrift-Detail zeigt den Block auch ohne eingehende Links,
  // sobald Allokationen auf Rechnungen bestehen (reine Anzeige, kein
  // Verlinken auf Gutschriften — Empfänger bleibt `invoice`).
  const showDeposits = (type === "invoice"
    && (document.permissions.canWrite || detail.linkedDeposits.length > 0))
    || (type === "credit_note" && detail.allocatedFinals.length > 0);
  const paidCents = document.paidCents ?? 0;
  const openCents = Math.max(document.grossCents - paidCents, 0);
  const skontoText = document.skontoPercentBps !== null && document.skontoDays !== null
    ? `${(document.skontoPercentBps / 100).toLocaleString("de-DE")} % innerhalb von ${document.skontoDays} Tagen`
    : "Kein Skonto vereinbart.";

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <nav aria-label="Brotkrumen">
        <Link
          href={listHref}
          className="text-sm font-semibold text-brand-800 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          ← Zurück zu {DOCUMENT_TYPE_LABELS[type]}
        </Link>
      </nav>
      <p className="mt-4 text-sm font-semibold text-brand-800">
        {DOCUMENT_TYPE_SINGULAR_LABELS[type]} · {DOCUMENT_STATUS_LABELS[document.status] ?? document.status}
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-slate-950">
        {document.number ?? document.name}
      </h1>
      {document.number ? (
        <p className="mt-1 text-sm text-slate-600">{document.name}</p>
      ) : null}

      <section
        aria-label="Belegkopf"
        data-invoice-detail="head"
        className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      >
        <h2 className="text-base font-semibold text-slate-950">Belegdaten</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">Status</dt>
            <dd className="font-semibold text-slate-900">{DOCUMENT_STATUS_LABELS[document.status] ?? document.status}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">Zahlstatus</dt>
            <dd className="font-semibold text-slate-900">
              {document.paymentStatus ? (PAYMENT_STATUS_LABELS[document.paymentStatus] ?? document.paymentStatus) : "—"}
            </dd>
          </div>
          {document.dueDate ? (
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Fällig</dt>
              <dd className="font-semibold text-slate-900">{formatDateOnly(document.dueDate)}</dd>
            </div>
          ) : null}
          {document.issuedAt ? (
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Ausgestellt</dt>
              <dd className="font-semibold text-slate-900">{formatBerlinDate(document.issuedAt)}</dd>
            </div>
          ) : null}
          {document.sentAt ? (
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Versendet</dt>
              <dd className="font-semibold text-slate-900">{formatBerlinDate(document.sentAt)}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section
        aria-label="Beträge"
        data-invoice-detail="amounts"
        className="mt-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      >
        <h2 className="text-base font-semibold text-slate-950">Beträge</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">Netto</dt>
            <dd className="font-semibold tabular-nums text-slate-900">{formatEuro(document.netCents)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">Steuer</dt>
            <dd className="font-semibold tabular-nums text-slate-900">{formatEuro(document.taxCents)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">Brutto</dt>
            <dd className="font-semibold tabular-nums text-slate-900">{formatEuro(document.grossCents)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">Bezahlt</dt>
            <dd className="font-semibold tabular-nums text-slate-900">{formatEuro(paidCents)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">Offen</dt>
            <dd className="font-semibold tabular-nums text-slate-900">{formatEuro(openCents)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">Skonto</dt>
            <dd className="font-semibold text-slate-900">{skontoText}</dd>
          </div>
        </dl>
      </section>

      <section
        aria-label="Positionen"
        data-invoice-detail="lines"
        className="mt-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      >
        <h2 className="text-base font-semibold text-slate-950">Positionen</h2>
        {lines.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-600">Noch keine Positionen erfasst.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {lines.map((line) => (
              <li key={line.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                <span className="text-slate-800">
                  <span className="mr-2 font-semibold tabular-nums text-slate-500">{line.position}.</span>
                  {line.name}
                  <span className="block text-xs text-slate-500">
                    {(line.quantityMilli / 1000).toLocaleString("de-DE")} {line.unit} · {(line.taxRateBps / 100).toLocaleString("de-DE")} % USt.
                  </span>
                </span>
                <span className="font-semibold tabular-nums text-slate-900">{formatEuro(line.grossCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showDeposits ? (
        <DepositLinkPanel workspaceId={workspaceId} detail={detail} candidates={candidates} />
      ) : null}

      {type === "order_confirmation"
      && document.permissions.canWrite
      && document.status !== "voided" ? (
        <DuplicateDocumentPanel workspaceId={workspaceId} documentId={documentId} />
      ) : null}

      {type === "order_confirmation"
      && partialChain !== null
      && ((document.permissions.canWrite && document.status !== "voided")
        || partialChain.partials.length > 0) ? (
        <PartialInvoicePanel
          workspaceId={workspaceId}
          documentId={documentId}
          chain={partialChain}
          canWrite={document.permissions.canWrite && document.status !== "voided"}
        />
      ) : null}

      {document.status === "voided" ? (
        <section
          aria-label="Storno"
          data-invoice-detail="void"
          className="mt-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h2 className="text-base font-semibold text-slate-950">Storno</h2>
          <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Grund</dt>
              <dd className="font-semibold text-slate-900">
                {document.voidReason ? (VOID_REASON_LABELS[document.voidReason] ?? document.voidReason) : "—"}
              </dd>
            </div>
            {document.voidedAt ? (
              <div className="flex justify-between gap-4">
                <dt className="text-slate-600">Storniert am</dt>
                <dd className="font-semibold text-slate-900">{formatBerlinDate(document.voidedAt)}</dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}
    </main>
  );
}
