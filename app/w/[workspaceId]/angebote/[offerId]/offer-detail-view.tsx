import Link from "next/link";
import { OfferVariantEditor } from "./offer-editor";
import { OfferPdfDraftPanel } from "./offer-pdf-draft-panel";
import {
  OfferReleaseCandidatePanel,
  type OfferRecipientPresenceSurfaceView,
  type OfferRecipientSurfaceView,
  type OfferReleaseCandidateSurfaceView,
  type OfferReleaseProfileSurfaceView,
  type OfferReleaseValidityWindowSurfaceView,
} from "./offer-release-candidate-panel";
import offerThemeStyles from "../offer-theme.module.css";
import { formatOfferCents, formatOfferCentsTotal, formatOfferRetryDate } from "./offer-format";

export type OfferDetailState =
  | "loaded"
  | "blocked"
  | "outdated"
  | "dirty"
  | "pending"
  | "conflict"
  | "validation"
  | "unavailable"
  | "unauthenticated"
  | "success"
  | "read_only";

export interface OfferDetailActionState {
  status: string;
  currentRevision?: number;
  retryAfter?: string;
  errors?: readonly string[];
  code?: string;
}

export interface OfferVariantTabView {
  id: string;
  name: string;
  revision: number;
  active: boolean;
  href: string;
}

export interface OfferPdfDraftSurfaceView {
  jobId: string;
  variantId: string;
  variantRevision: number;
  state: "queued" | "running" | "retry_wait" | "succeeded" | "failed_final";
  attemptCount: number;
  nextAttemptAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  canDownload: boolean;
}

interface OfferProductView {
  kind: "catalog" | "custom";
  displayName: string;
  description?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  unit: "piece" | "set" | "meter" | string;
}

interface OfferLineComputedView {
  lineBaseNetCents?: number;
  lineDiscountedNetCents?: number;
  sectionDiscountedNetCents?: number;
  finalSalesNetCents: number;
  salesTaxCents: number;
  salesGrossCents: number;
  purchaseNetCents?: number;
  marginNetCents?: number;
}

export interface OfferLineView {
  lineDomainId: string;
  position: number;
  positionType: "required" | "additional" | "optional" | string;
  isHidden: boolean;
  quantityMilli: number;
  componentCategory: OfferComponentCategory;
  source: { kind: "catalog" | "custom" };
  product: OfferProductView;
  salesPricing: {
    originalUnitNetCents: number;
    effectiveUnitNetCents: number;
    provenance?: OfferPricingProvenanceView;
  };
  purchasePricing?: {
    originalUnitNetCents?: number;
    effectiveUnitNetCents?: number;
    provenance?: OfferPricingProvenanceView;
  };
  lineDiscountBps: number;
  taxTreatment: string;
  taxRateBps: number;
  computed: OfferLineComputedView;
}

export interface OfferSectionView {
  sectionDomainId: string;
  position: number;
  title: string;
  category: OfferComponentCategory;
  discountBps: number;
  lines: readonly OfferLineView[];
}

export interface OfferVariantSnapshotView {
  workspaceId: string;
  offerId: string;
  variantId: string;
  revision: number;
  variantName: string;
  description: string | null;
  globalDiscountBps: number;
  customDealNetCents: number | null;
  contactContext: {
    displayName: string;
  };
  installationSiteContext: {
    formattedAddress: string;
  };
  currency: "EUR" | string;
  priceBasis: "net" | string;
  sections: readonly OfferSectionView[];
  totals: {
    basisNetCents: number;
    basisTaxCents: number;
    basisGrossCents: number;
    optionalNetCents: number;
    optionalTaxCents: number;
    optionalGrossCents: number;
  };
}

interface OfferVariantViewEnvelope {
  schemaVersion: string;
  snapshot: OfferVariantSnapshotView;
}

export interface OfferDetailSurfaceView {
  state: OfferDetailState;
  workspaceId: string;
  recoveryScope?: string;
  offer?: {
    id: string;
    projectId: string;
    offerNumber: string;
    status: string;
    outdated: boolean;
    forecastValueNetCents: number | null;
  };
  variants?: readonly OfferVariantTabView[];
  activeVariant?: OfferVariantViewEnvelope;
  permissions?: {
    canEdit: boolean;
    canDuplicate: boolean;
    canCreateBasis: boolean;
    canReadPurchasePrice: boolean;
    canEditPrice: boolean;
    canApplyDiscount: boolean;
    canEditPurchasePrice: boolean;
    canGeneratePdf: boolean;
    canPrepareRelease: boolean;
    canApproveRelease: boolean;
  };
  basisInput?: {
    expectedRequirementRevision: number;
    expectedCalculationRevision: number;
    expectedResolutionRevision: number;
  };
  actionState?: OfferDetailActionState;
  blockers?: readonly { code: string; label: string }[];
  pdfDrafts?: readonly OfferPdfDraftSurfaceView[];
  offerRelease?: {
    profile: OfferReleaseProfileSurfaceView | null;
    recipient: OfferRecipientSurfaceView | null;
    recipientPresence: OfferRecipientPresenceSurfaceView | null;
    sourcePdfDraftId: string | null;
    validityWindow: OfferReleaseValidityWindowSurfaceView;
    candidates: readonly OfferReleaseCandidateSurfaceView[];
  };
}

export type OfferComponentCategory =
  | "module" | "inverter" | "battery" | "wallbox" | "heat_pump" | "mounting" | "other";

interface OfferPricingProvenanceView {
  kind: "catalog_seed" | "manual_override" | "custom";
  reasonCode?: "customer_specific_pricing" | "negotiated" | "correction" | "other";
  originalProvenance?: { kind: "catalog_seed" | "custom" };
}

const quantityFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});

const percentFormatter = new Intl.NumberFormat("de-DE", {
  style: "percent",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function formatCents(value: number | undefined): string {
  return formatOfferCents(value);
}

function formatQuantity(quantityMilli: number, unit: string): string {
  const unitLabel = unit === "piece" ? "Stk." : unit === "set" ? "Set" : "m";
  return `${quantityFormatter.format(quantityMilli / 1_000)} ${unitLabel}`;
}

function formatBasisPoints(value: number): string {
  return percentFormatter.format(value / 10_000);
}

function positionTypeLabel(value: string): string {
  if (value === "required") return "Erforderlich";
  if (value === "additional") return "Zusatzleistung";
  if (value === "optional") return "Optional";
  return "Nicht klassifiziert";
}

function taxLabel(treatment: string, rateBps: number): string {
  if (treatment === "standard_19") return "19 % USt.";
  if (treatment === "zero_operator_confirmed") return "0 % USt. · bestätigt";
  return `${formatBasisPoints(rateBps)} USt.`;
}

function provenanceLabel(provenance: OfferPricingProvenanceView | undefined): string {
  if (!provenance) return "Nicht verfügbar";
  if (provenance.kind === "catalog_seed") return "Katalogpreis";
  if (provenance.kind === "custom") return "Freie Position";
  const reasons: Record<string, string> = {
    customer_specific_pricing: "kundenspezifisch",
    negotiated: "verhandelt",
    correction: "Korrektur",
    other: "sonstiger Grund",
  };
  return `Manueller Override · ${reasons[provenance.reasonCode ?? ""] ?? "dokumentiert"}`;
}

function DetailStatus({ view }: { view: OfferDetailSurfaceView }) {
  const retryAfter = view.actionState?.retryAfter;

  if (view.state === "loaded") return null;
  if (view.state === "read_only") {
    return (
      <aside className="rounded-md border border-slate-300 bg-white px-4 py-3 text-base leading-6 text-slate-700">
        <p className="font-semibold text-slate-950">Nur Lesezugriff</p>
        <p className="mt-1">Der gespeicherte Angebotsstand kann geprüft, aber nicht verändert werden.</p>
      </aside>
    );
  }
  if (view.state === "outdated") {
    return (
      <aside role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-base leading-6 text-amber-950">
        <p className="font-semibold">Die Projektgrundlage ist nicht mehr aktuell.</p>
        <p className="mt-1">
          Dieser gespeicherte Stand bleibt als Snapshot unverändert. Eine neue Grundlage muss
          ausdrücklich als eigene Variante angelegt werden.
        </p>
      </aside>
    );
  }
  if (view.state === "dirty") {
    return (
      <aside role="status" className="rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-base leading-6 text-blue-950">
        <p className="font-semibold">Ungespeicherte Änderungen im lokalen Entwurf</p>
        <p className="mt-1">Der gespeicherte Serverstand wurde noch nicht verändert.</p>
      </aside>
    );
  }
  if (view.state === "pending") {
    return (
      <aside aria-live="polite" className="rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-base leading-6 text-blue-950">
        <p className="font-semibold">Änderungen werden geprüft und gespeichert …</p>
        <p className="mt-1">Bis zur Serverantwort bleibt eine weitere Aktion gesperrt.</p>
      </aside>
    );
  }
  if (view.state === "conflict") {
    const revision = view.actionState?.currentRevision;
    return (
      <aside role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-base leading-6 text-amber-950">
        <p className="font-semibold">Der gespeicherte Stand wurde zwischenzeitlich geändert.</p>
        <p className="mt-1">
          {revision ? `Der Serverstand ist jetzt Revision ${revision}. ` : ""}
          Deine Eingaben im lokalen Entwurf bleiben erhalten und müssen mit dem aktuellen Stand
          abgeglichen werden.
        </p>
      </aside>
    );
  }
  if (view.state === "validation") {
    return (
      <aside role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-4 py-3 text-base leading-6 text-rose-950">
        <p className="font-semibold">Der Entwurf enthält noch ungültige Angaben.</p>
        <p className="mt-1">Deine Eingaben bleiben erhalten. Prüfe die markierten Felder.</p>
        {view.actionState?.errors?.length ? (
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {view.actionState.errors.map((message) => <li key={message}>{message}</li>)}
          </ul>
        ) : null}
      </aside>
    );
  }
  if (view.state === "unavailable") {
    return (
      <aside role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-base leading-6 text-amber-950">
        <p className="font-semibold">Speichern ist vorübergehend nicht verfügbar.</p>
        <p className="mt-1">Deine Eingaben im lokalen Entwurf bleiben erhalten.</p>
        {retryAfter ? (
          <p className="mt-2">
            Frühester neuer Versuch:{" "}
            <time dateTime={retryAfter}>{formatOfferRetryDate(retryAfter)}</time>
          </p>
        ) : null}
      </aside>
    );
  }
  if (view.state === "unauthenticated") {
    return (
      <aside role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-4 py-3 text-base leading-6 text-rose-950">
        <p className="font-semibold">Deine Sitzung ist abgelaufen.</p>
        <p className="mt-1">
          Die Anmeldung muss erneuert werden. Deine Eingaben im lokalen Entwurf werden auf dieser
          Seite nicht still verworfen.
        </p>
        <Link
          href="/login"
          className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Zur Anmeldung
        </Link>
      </aside>
    );
  }
  if (view.state === "success") {
    return (
      <aside aria-live="polite" className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-base leading-6 text-emerald-950">
        <p className="font-semibold">Der neue Angebotsstand wurde gespeichert.</p>
      </aside>
    );
  }

  return (
    <aside role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-base leading-6 text-amber-950">
      <p className="font-semibold">Der Angebotsentwurf ist noch blockiert.</p>
      {view.blockers?.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {view.blockers.map((blocker) => <li key={blocker.code}>{blocker.label}</li>)}
        </ul>
      ) : (
        <p className="mt-1">Prüfe die offenen Voraussetzungen in der zugehörigen Anfrage.</p>
      )}
    </aside>
  );
}

function VariantNavigation({ variants }: { variants: readonly OfferVariantTabView[] }) {
  return (
    <nav aria-label="Angebotsvarianten" className="overflow-x-auto">
      <ul className="flex min-w-max list-none gap-2 pb-1">
        {variants.map((variant) => (
          <li key={variant.id}>
            <Link
              href={variant.href}
              aria-current={variant.active ? "page" : undefined}
              className={
                variant.active
                  ? "inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                  : "inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              }
            >
              {variant.name}
              <span className={variant.active ? "ml-2 text-xs text-white" : "ml-2 text-xs text-slate-700"}>Rev. {variant.revision}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function PurchaseValues({ line }: { line: OfferLineView }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-xs">
      <div>
        <dt className="text-slate-500">Einkaufspreis</dt>
        <dd className="mt-1 font-semibold tabular-nums text-slate-900">
          {formatCents(line.purchasePricing?.effectiveUnitNetCents)}
        </dd>
      </div>
      <div>
        <dt className="text-slate-500">Marge</dt>
        <dd className="mt-1 font-semibold tabular-nums text-slate-900">
          {formatCents(line.computed.marginNetCents)}
        </dd>
      </div>
      <div className="col-span-2">
        <dt className="text-slate-500">Preisprovenienz</dt>
        <dd className="mt-1 font-semibold text-slate-900">
          VK: {provenanceLabel(line.salesPricing.provenance)} · EK: {provenanceLabel(line.purchasePricing?.provenance)}
        </dd>
      </div>
    </dl>
  );
}

function OfferLineCard({
  line,
  canReadPurchasePrice,
}: {
  line: OfferLineView;
  canReadPurchasePrice: boolean;
}) {
  return (
    <li className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">
              {positionTypeLabel(line.positionType)}
            </span>
            {line.isHidden ? (
              <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
                Intern ausgeblendet
              </span>
            ) : null}
          </div>
          <h3 className="mt-2 break-words text-base font-semibold text-slate-950">
            {line.product.displayName}
          </h3>
          {line.product.manufacturer || line.product.model ? (
            <p className="mt-1 text-xs text-slate-500">
              {[line.product.manufacturer, line.product.model].filter(Boolean).join(" · ")}
            </p>
          ) : null}
        </div>
        <p className="text-right text-sm font-semibold tabular-nums text-slate-950">
          {formatCents(line.computed.finalSalesNetCents)}
          <span className="block text-xs font-normal text-slate-500">Netto</span>
        </p>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-slate-100 pt-3 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-slate-500">Menge</dt>
          <dd className="mt-1 font-semibold tabular-nums text-slate-900">
            {formatQuantity(line.quantityMilli, line.product.unit)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">VK je Einheit</dt>
          <dd className="mt-1 font-semibold tabular-nums text-slate-900">
            {formatCents(line.salesPricing.effectiveUnitNetCents)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Zeilenrabatt</dt>
          <dd className="mt-1 font-semibold tabular-nums text-slate-900">
            {formatBasisPoints(line.lineDiscountBps)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Steuer</dt>
          <dd className="mt-1 font-semibold text-slate-900">
            {taxLabel(line.taxTreatment, line.taxRateBps)}
          </dd>
        </div>
        <div className="col-span-2 sm:col-span-4">
          <dt className="text-slate-500">VK-Preisprovenienz</dt>
          <dd className="mt-1 font-semibold text-slate-900">
            {provenanceLabel(line.salesPricing.provenance)}
          </dd>
        </div>
      </dl>
      {canReadPurchasePrice ? <PurchaseValues line={line} /> : null}
    </li>
  );
}

function OfferSectionCard({
  section,
  canReadPurchasePrice,
}: {
  section: OfferSectionView;
  canReadPurchasePrice: boolean;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:p-5">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
            Sektion {section.position}
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">{section.title}</h2>
        </div>
        {section.discountBps > 0 ? (
          <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-900">
            {formatBasisPoints(section.discountBps)} Sektionsrabatt
          </span>
        ) : null}
      </header>
      <ul className="grid list-none gap-3">
        {section.lines.map((line) => (
          <OfferLineCard
            key={line.lineDomainId}
            line={line}
            canReadPurchasePrice={canReadPurchasePrice}
          />
        ))}
      </ul>
    </section>
  );
}

function TotalsCard({
  snapshot,
  canReadPurchasePrice,
}: {
  snapshot: OfferVariantSnapshotView;
  canReadPurchasePrice: boolean;
}) {
  const lines = snapshot.sections.flatMap((section) => section.lines);
  return (
    <aside className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm lg:sticky lg:top-6">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
        Preiszusammenfassung
      </p>
      <h2 className="mt-1 text-lg font-semibold text-slate-950">Serverberechneter Stand</h2>
      <dl className="mt-5 grid gap-3 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-slate-600">Netto</dt>
          <dd className="font-semibold tabular-nums text-slate-950">
            {formatCents(snapshot.totals.basisNetCents)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-slate-600">Umsatzsteuer</dt>
          <dd className="font-semibold tabular-nums text-slate-950">
            {formatCents(snapshot.totals.basisTaxCents)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-slate-200 pt-3 text-base">
          <dt className="font-semibold text-slate-950">Brutto</dt>
          <dd className="font-bold tabular-nums text-slate-950">
            {formatCents(snapshot.totals.basisGrossCents)}
          </dd>
        </div>
        {snapshot.totals.optionalGrossCents > 0 ? (
          <div className="mt-1 rounded-md bg-slate-50 px-3 py-3">
            <dt className="text-xs text-slate-500">Optionen separat · Brutto</dt>
            <dd className="mt-1 font-semibold tabular-nums text-slate-950">
              {formatCents(snapshot.totals.optionalGrossCents)}
            </dd>
          </div>
        ) : null}
      </dl>
      {canReadPurchasePrice ? (
        <dl className="mt-4 grid gap-3 border-t border-slate-200 pt-4 text-sm">
          <div className="flex items-center justify-between gap-4"><dt className="text-slate-600">EK gesamt</dt><dd className="font-semibold tabular-nums">{formatOfferCentsTotal(lines.map((line) => line.computed.purchaseNetCents))}</dd></div>
          <div className="flex items-center justify-between gap-4"><dt className="text-slate-600">Marge gesamt</dt><dd className="font-semibold tabular-nums">{formatOfferCentsTotal(lines.map((line) => line.computed.marginNetCents))}</dd></div>
        </dl>
      ) : null}
      <p className="mt-5 border-t border-slate-100 pt-4 text-base leading-6 text-slate-600">
        Unverbindlicher interner Entwurf. Preise werden ausschließlich aus dem gespeicherten
        Variantenstand dargestellt.
      </p>
    </aside>
  );
}

function SalesForecast({ value }: { value: number | null }) {
  return (
    <aside className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">
        Vertriebsprognose
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-slate-950">
        {value === null ? "Nicht hinterlegt" : `${formatOfferCents(value)} netto`}
      </p>
      <p className="mt-1 text-base leading-6 text-slate-600">
        Separater Vertriebswert aus dem Angebot. Er verändert keine Position und keine Kundensumme.
      </p>
    </aside>
  );
}

export function OfferDetailView({ view }: { view: OfferDetailSurfaceView }) {
  const canEdit = view.permissions?.canEdit === true;
  const canReadPurchasePrice = view.permissions?.canReadPurchasePrice === true;
  const pending = view.state === "pending";

  if (!view.offer || !view.activeVariant) {
    return (
      <main
        data-offer-detail-state={view.state}
        data-wmee-scope="offer"
        className={`${offerThemeStyles.offerTheme} min-h-[70vh] bg-slate-50 px-4 py-8 sm:px-6`}
      >
        <a href="#offer-empty-main" className="sr-only rounded bg-white px-3 py-2 font-semibold focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:ring-2 focus:ring-emerald-700">
          Zum Angebotsstatus springen
        </a>
        <div id="offer-empty-main" className="mx-auto grid w-full max-w-3xl gap-5">
          <Link
            href={`/w/${view.workspaceId}/angebote`}
            className="inline-flex min-h-11 w-fit items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            ← Zur Angebotsübersicht
          </Link>
          <DetailStatus view={view} />
        </div>
      </main>
    );
  }

  const snapshot = view.activeVariant.snapshot;
  const pdfDraftPanel = (
    <OfferPdfDraftPanel
      workspaceId={view.workspaceId}
      offerId={view.offer.id}
      variantId={snapshot.variantId}
      variantRevision={snapshot.revision}
      canGenerate={view.permissions?.canGeneratePdf === true}
      drafts={view.pdfDrafts ?? []}
    />
  );
  const offerReleasePanel = view.offerRelease ? (
    <OfferReleaseCandidatePanel
      workspaceId={view.workspaceId}
      offerId={view.offer.id}
      variantId={snapshot.variantId}
      variantRevision={snapshot.revision}
      contactDisplayName={view.permissions?.canPrepareRelease === true
        ? snapshot.contactContext.displayName
        : null}
      profile={view.offerRelease.profile}
      recipient={view.offerRelease.recipient}
      recipientPresence={view.offerRelease.recipientPresence}
      sourcePdfDraftId={view.offerRelease.sourcePdfDraftId}
      validityWindow={view.offerRelease.validityWindow}
      canPrepare={view.permissions?.canPrepareRelease === true}
      canApprove={view.permissions?.canApproveRelease === true}
      candidates={view.offerRelease.candidates}
    />
  ) : null;

  if (canEdit && view.permissions?.canEdit && view.recoveryScope) {
    return (
      <OfferVariantEditor
        key={`${snapshot.variantId}:${snapshot.revision}`}
        view={{
          ...view,
          recoveryScope: view.recoveryScope,
          offer: view.offer,
          activeVariant: view.activeVariant,
          permissions: { ...view.permissions, canEdit: true },
        }}
        showReleaseSkipLink={offerReleasePanel !== null}
        afterEditor={<div
          key="offer-release-workflow"
          data-wmee-scope="offer"
          className={`${offerThemeStyles.offerTheme} bg-slate-50 px-4 pb-8 sm:px-6`}
        >
          <div className="mx-auto grid w-full max-w-[1480px] gap-5">
            {pdfDraftPanel}
            {offerReleasePanel}
          </div>
        </div>}
      />
    );
  }

  return (
    <main
      data-offer-detail-state={view.state}
      data-wmee-scope="offer"
      className={`${offerThemeStyles.offerTheme} min-h-screen bg-slate-50 text-slate-950`}
    >
      <a href="#offer-readonly-main" className="sr-only rounded bg-white px-3 py-2 font-semibold focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:ring-2 focus:ring-emerald-700">
        Zum Angebotsinhalt springen
      </a>
      <div id="offer-readonly-main" className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <nav aria-label="Brotkrumen" className="mb-5">
          <Link
            href={`/w/${view.workspaceId}/angebote`}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            <span aria-hidden="true" className="mr-2">←</span>
            Zur Angebotsübersicht
          </Link>
        </nav>

        <header className="mb-6 border-b border-slate-200 pb-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                {view.offer.offerNumber}
              </p>
              <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight sm:text-3xl">
                {snapshot.contactContext.displayName}
              </h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {snapshot.installationSiteContext.formattedAddress}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                Revision {snapshot.revision}
              </span>
              {canEdit ? (
                <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-800">
                  Editoransicht
                </span>
              ) : (
                <span className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600">
                  Nur Lesezugriff
                </span>
              )}
            </div>
          </div>
        </header>

        <div className="grid gap-5">
          <DetailStatus view={view} />
          {pdfDraftPanel}
          <SalesForecast value={view.offer.forecastValueNetCents} />
          <VariantNavigation variants={view.variants ?? []} />
        </div>

        <fieldset disabled={pending} className="mt-6 min-w-0 border-0 p-0">
          <legend className="sr-only">Angebotsentwurf {snapshot.variantName}</legend>
          {pending ? (
            <span className="sr-only" aria-live="polite">Angebotsentwurf wird gespeichert</span>
          ) : null}
          <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
            <div className="grid min-w-0 gap-5">
              <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
                  Aktive Variante
                </p>
                <h2 className="mt-1 text-xl font-semibold text-slate-950">{snapshot.variantName}</h2>
                {snapshot.description ? (
                  <p className="mt-2 text-sm leading-6 text-slate-600">{snapshot.description}</p>
                ) : null}
                <dl className="mt-4 grid gap-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2">
                  <div><dt className="text-slate-600">Globaler Rabatt</dt><dd className="mt-1 font-semibold">{formatBasisPoints(snapshot.globalDiscountBps)}</dd></div>
                  <div><dt className="text-slate-600">Custom Deal netto</dt><dd className="mt-1 font-semibold tabular-nums">{snapshot.customDealNetCents === null ? "Kein Custom Deal" : formatOfferCents(snapshot.customDealNetCents)}</dd></div>
                </dl>
              </section>
              {snapshot.sections.map((section) => (
                <OfferSectionCard
                  key={section.sectionDomainId}
                  section={section}
                  canReadPurchasePrice={canReadPurchasePrice}
                />
              ))}
            </div>
            <TotalsCard
              snapshot={snapshot}
              canReadPurchasePrice={canReadPurchasePrice}
            />
          </div>
        </fieldset>
        {offerReleasePanel ? <div className="mt-6">{offerReleasePanel}</div> : null}
      </div>
    </main>
  );
}
