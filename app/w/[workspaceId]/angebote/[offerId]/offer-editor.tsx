"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { authClient } from "@/lib/auth-browser";
import {
  createVariantFromCurrentResolutionEditorAction,
  duplicateOfferVariantEditorAction,
  saveOfferVariantDraftAction,
  type OfferEditorActionState,
} from "../actions";
import {
  buildOfferRevisionOperations,
  canRemoveOfferDraftSection,
  calculateOfferEditorPreview,
  createOfferEditorDraft,
  createOfferEditorRecoveryEnvelope,
  isOfferEditorDraftDirty,
  isOfferEditorPriceInputChanged,
  addCustomOfferDraftLine,
  addCustomOfferDraftSection,
  moveOfferDraftLine,
  moveOfferDraftLineToSection,
  moveOfferDraftSection,
  removeCustomOfferDraftLine,
  removeCustomOfferDraftSection,
  rebaseOfferEditorDraft,
  prepareOfferEditorRecoveryDrafts,
  type OfferComponentCategory,
  type OfferEditorDraft,
  type OfferEditorError,
  type OfferEditorSourceSnapshot,
  type OfferPositionType,
  type OfferPriceReason,
  type OfferTaxTreatment,
  type OfferUnit,
} from "./offer-editor-model";
import {
  DirtyNavigationDialog,
  DirtyNavigationGuard,
  GuardedSignOutButton,
} from "./dirty-navigation-guard";
import type {
  OfferDetailSurfaceView,
  OfferLineView,
  OfferVariantSnapshotView,
} from "./offer-detail-view";
import offerThemeStyles from "../offer-theme.module.css";
import { formatOfferCents, formatOfferCentsTotal, formatOfferRetryDate } from "./offer-format";

type EditableOfferView = OfferDetailSurfaceView & {
  recoveryScope: string;
  offer: NonNullable<OfferDetailSurfaceView["offer"]>;
  activeVariant: NonNullable<OfferDetailSurfaceView["activeVariant"]>;
  permissions: NonNullable<OfferDetailSurfaceView["permissions"]> & {
    canEdit: true;
  };
};

type Feedback =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "validation"; errors: readonly OfferEditorError[] }
  | { status: "conflict"; currentRevision?: number }
  | { status: "unavailable"; retryAfter: string }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "blocked"; code: string }
  | { status: "success"; revision: number }
  | { status: "noop" }
  | { status: "unexpected" };

type PendingIntent = {
  label: string;
  execute: () => void | Promise<void>;
};

function formatCents(value: number): string {
  return formatOfferCents(value);
}

function sourceFromSnapshot(snapshot: OfferVariantSnapshotView): OfferEditorSourceSnapshot {
  return {
    revision: snapshot.revision,
    variantName: snapshot.variantName,
    description: snapshot.description,
    globalDiscountBps: snapshot.globalDiscountBps,
    customDealNetCents: snapshot.customDealNetCents,
    sections: snapshot.sections.map((section) => ({
      sectionDomainId: section.sectionDomainId,
      position: section.position,
      title: section.title,
      category: section.category,
      discountBps: section.discountBps,
      lines: section.lines.map((line) => ({
        lineDomainId: line.lineDomainId,
        position: line.position,
        positionType: line.positionType as OfferPositionType,
        isHidden: line.isHidden,
        quantityMilli: line.quantityMilli,
        sourceKind: line.source.kind,
        componentCategory: line.componentCategory,
        displayName: line.product.displayName,
        description: line.product.description,
        salesUnitNetCents: line.salesPricing.effectiveUnitNetCents,
        purchaseUnitNetCents: line.purchasePricing?.effectiveUnitNetCents,
        lineDiscountBps: line.lineDiscountBps,
        unit: line.product.unit,
        taxTreatment: line.taxTreatment as OfferTaxTreatment,
      })),
    })),
  };
}

function initialFeedback(view: EditableOfferView): Feedback {
  if (view.state === "pending") return { status: "pending" };
  if (view.state === "conflict") {
    return { status: "conflict", currentRevision: view.actionState?.currentRevision };
  }
  if (view.state === "validation") {
    return {
      status: "validation",
      errors: (view.actionState?.errors ?? ["Der gespeicherte Entwurf ist ungültig."]).map(
        (message, index) => ({ field: `server-${index}`, message }),
      ),
    };
  }
  if (view.state === "unavailable" && view.actionState?.retryAfter) {
    return { status: "unavailable", retryAfter: view.actionState.retryAfter };
  }
  if (view.state === "unauthenticated") return { status: "unauthenticated" };
  if (view.state === "blocked") {
    return { status: "blocked", code: view.actionState?.code ?? "requirements_changed" };
  }
  if (view.state === "success") {
    return { status: "success", revision: view.activeVariant.snapshot.revision };
  }
  return { status: "idle" };
}

function feedbackFromAction(result: OfferEditorActionState): Feedback {
  if (result.status === "invalid") {
    return {
      status: "validation",
      errors: [{
        field: "editor-server",
        message: "Der Server hat den gebündelten Änderungsbefehl abgewiesen.",
      }],
    };
  }
  if (result.status === "conflict") {
    return { status: "conflict", currentRevision: result.currentRevision };
  }
  if (result.status === "unavailable") return result;
  if (result.status === "unauthenticated") return result;
  if (result.status === "denied") return result;
  if (result.status === "blocked") return result;
  if (result.status === "success") {
    return { status: "success", revision: result.revision };
  }
  return { status: "unexpected" };
}

function offerErrorTarget(field: string): string {
  return field.startsWith("editor-") || field.startsWith("server-")
    ? "offer-editor-error-summary"
    : field;
}

function FeedbackBanner({
  feedback,
  dirty,
  summaryRef,
  onReloadServer,
  onLogin,
}: {
  feedback: Feedback;
  dirty: boolean;
  summaryRef: React.RefObject<HTMLDivElement | null>;
  onReloadServer: () => void;
  onLogin: () => void;
}) {
  if (feedback.status === "validation") {
    return (
      <div
        id="offer-editor-error-summary"
        ref={summaryRef}
        role="alert"
        tabIndex={-1}
        className="rounded-md border border-rose-300 bg-rose-50 px-4 py-3 text-base leading-6 text-rose-950 outline-none focus-visible:ring-2 focus-visible:ring-rose-600"
      >
        <p className="font-semibold">Bitte prüfe den lokalen Entwurf.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {feedback.errors.map((error) => (
            <li key={`${error.field}:${error.message}`}>
              <a className="font-semibold underline underline-offset-2" href={`#${offerErrorTarget(error.field)}`}>
                {error.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (feedback.status === "conflict") {
    return (
      <div
        ref={summaryRef}
        role="alert"
        tabIndex={-1}
        className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-base leading-6 text-amber-950 outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
      >
        <p className="font-semibold">Der Serverstand wurde zwischenzeitlich geändert.</p>
        <p className="mt-1">
          {feedback.currentRevision
            ? `Aktuell ist Revision ${feedback.currentRevision}. `
            : ""}
          Deine Eingaben bleiben erhalten. Der veraltete Patch wird nicht blind erneut gesendet.
          Lade den aktuellen Snapshot bewusst neu und gleiche deine Eingaben danach fachlich ab.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onReloadServer}
            className="min-h-11 rounded-md border border-amber-800 px-4 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-amber-800 focus-visible:ring-offset-2"
          >
            Serverstand bewusst neu laden
          </button>
        </div>
      </div>
    );
  }
  if (feedback.status === "unavailable") {
    return (
      <div
        ref={summaryRef}
        role="alert"
        tabIndex={-1}
        className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-base leading-6 text-amber-950 outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
      >
        <p className="font-semibold">Speichern ist vorübergehend nicht verfügbar.</p>
        <p className="mt-1">Der lokale Draft bleibt erhalten. Keine Aktion wird automatisch wiederholt.</p>
        <p className="mt-2">Neuer Versuch nach <time dateTime={feedback.retryAfter}>{formatOfferRetryDate(feedback.retryAfter)}</time>.</p>
      </div>
    );
  }
  if (feedback.status === "unauthenticated") {
    return (
      <div
        ref={summaryRef}
        role="alert"
        tabIndex={-1}
        className="rounded-md border border-rose-300 bg-rose-50 px-4 py-3 text-base leading-6 text-rose-950 outline-none focus-visible:ring-2 focus-visible:ring-rose-600"
      >
        <p className="font-semibold">Deine Sitzung ist abgelaufen.</p>
        <p className="mt-1">Der lokale Draft bleibt erhalten. Erst deine bewusste Anmeldung verlässt diese Seite.</p>
        <button type="button" onClick={onLogin} className="mt-3 inline-flex min-h-11 items-center font-semibold underline">
          Zur Anmeldung
        </button>
      </div>
    );
  }
  if (feedback.status === "denied") {
    return (
      <div ref={summaryRef} role="alert" tabIndex={-1} className="rounded-md border border-rose-300 bg-rose-50 px-4 py-3 text-base leading-6 text-rose-950 outline-none focus-visible:ring-2 focus-visible:ring-rose-600">
        <p className="font-semibold">Diese Änderung ist nicht freigegeben.</p>
        <p className="mt-1">Der lokale Draft bleibt geöffnet; es werden keine Objektdetails ergänzt.</p>
      </div>
    );
  }
  if (feedback.status === "blocked") {
    const messages: Record<string, string> = {
      catalog_pricing_missing: "Produktpreise fehlen in der aktuellen Grundlage.",
      calculation_not_current: "Die Projektberechnung ist nicht mehr aktuell.",
      resolution_not_current: "Die Produktauswahl ist nicht mehr aktuell.",
      installation_site_changed: "Der Anlagenstandort wurde geändert.",
      variant_limit: "Die zulässige Anzahl an Varianten ist erreicht.",
    };
    return (
      <div ref={summaryRef} role="alert" tabIndex={-1} className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-base leading-6 text-amber-950 outline-none focus-visible:ring-2 focus-visible:ring-amber-700">
        <p className="font-semibold">Diese Angebotsaktion ist serverseitig blockiert.</p>
        <p className="mt-1">{messages[feedback.code] ?? "Die Angebotsgrundlage muss erneut geprüft werden."} Dein lokaler Draft bleibt erhalten.</p>
        <button type="button" onClick={onReloadServer} className="mt-3 min-h-11 rounded-md border border-amber-800 px-4 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-amber-800 focus-visible:ring-offset-2">
          Serverstand bewusst neu laden
        </button>
      </div>
    );
  }
  if (feedback.status === "unexpected") {
    return (
      <div ref={summaryRef} role="alert" tabIndex={-1} className="rounded-md border border-rose-300 bg-rose-50 px-4 py-3 text-base leading-6 text-rose-950 outline-none focus-visible:ring-2 focus-visible:ring-rose-600">
        <p className="font-semibold">Speichern ist unerwartet fehlgeschlagen.</p>
        <p className="mt-1">Der lokale Draft bleibt unverändert.</p>
      </div>
    );
  }
  if (feedback.status === "pending") {
    return (
      <div aria-live="polite" className="rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-base leading-6 text-blue-950">
        <p className="font-semibold">Genau eine Änderung wird serverseitig geprüft …</p>
      </div>
    );
  }
  if (feedback.status === "success") {
    return (
      <div aria-live="polite" className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-base leading-6 text-emerald-950">
        <p className="font-semibold">Revision {feedback.revision} wurde gespeichert.</p>
        <p className="mt-1">Die serverberechneten Werte werden aus dem gespeicherten Readmodel aktualisiert.</p>
      </div>
    );
  }
  if (feedback.status === "noop") {
    return (
      <div role="status" className="rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-base leading-6 text-blue-950">
        <p className="font-semibold">Keine fachliche Änderung zu speichern.</p>
        <p className="mt-1">Die Eingaben wurden auf den kanonischen gespeicherten Stand zurückgesetzt; es wurde keine neue Serverrevision erzeugt.</p>
      </div>
    );
  }
  if (dirty) {
    return (
      <div role="status" className="rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-base leading-6 text-blue-950">
        <p className="font-semibold">Ungespeichert</p>
        <p className="mt-1">Nur der lokale Draft wurde verändert.</p>
      </div>
    );
  }
  return null;
}

function PersistentOutdatedWarning() {
  return (
    <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-base leading-6 text-amber-950">
      <p className="font-semibold">Die Projektgrundlage ist nicht mehr aktuell.</p>
      <p className="mt-1">Der gespeicherte Snapshot bleibt unverändert. Eine neue Basis ist eine eigene Variante.</p>
    </div>
  );
}

function GuardedLink({
  href,
  label,
  dirty,
  pending,
  requestIntent,
  navigate,
  className,
  children,
  current,
}: {
  href: string;
  label: string;
  dirty: boolean;
  pending: boolean;
  requestIntent: (intent: PendingIntent) => void;
  navigate: (href: string) => void;
  className: string;
  children: ReactNode;
  current?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      aria-disabled={pending || undefined}
      onNavigate={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        if (!dirty) return;
        event.preventDefault();
        requestIntent({ label, execute: () => navigate(href) });
      }}
      className={className}
    >
      {children}
    </Link>
  );
}

function ServerTotals({
  snapshot,
  preview,
  canReadPurchasePrice,
}: {
  snapshot: OfferVariantSnapshotView;
  preview: ReturnType<typeof calculateOfferEditorPreview>;
  canReadPurchasePrice: boolean;
}) {
  const snapshotLines = snapshot.sections.flatMap((section) => section.lines);
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">
        Gespeicherter Serverstand · Revision {snapshot.revision}
      </p>
      <dl className="mt-4 grid gap-3 text-sm">
        <div className="flex justify-between gap-4"><dt>Netto</dt><dd className="font-semibold tabular-nums">{formatCents(snapshot.totals.basisNetCents)}</dd></div>
        <div className="flex justify-between gap-4"><dt>Umsatzsteuer</dt><dd className="font-semibold tabular-nums">{formatCents(snapshot.totals.basisTaxCents)}</dd></div>
        <div className="flex justify-between gap-4 border-t border-slate-200 pt-3 text-base"><dt className="font-semibold">Brutto</dt><dd className="font-bold tabular-nums">{formatCents(snapshot.totals.basisGrossCents)}</dd></div>
        {snapshot.totals.optionalGrossCents > 0 ? (
          <div className="flex justify-between gap-4 rounded-md bg-slate-50 px-3 py-2"><dt>Optionen brutto</dt><dd className="font-semibold tabular-nums">{formatCents(snapshot.totals.optionalGrossCents)}</dd></div>
        ) : null}
      </dl>
      {canReadPurchasePrice ? (
        <dl className="mt-4 grid gap-2 border-t border-slate-200 pt-4 text-sm">
          <div className="flex justify-between gap-4"><dt>Gespeicherter EK gesamt</dt><dd className="font-semibold tabular-nums">{formatOfferCentsTotal(snapshotLines.map((line) => line.computed.purchaseNetCents))}</dd></div>
          <div className="flex justify-between gap-4"><dt>Gespeicherte Marge</dt><dd className="font-semibold tabular-nums">{formatOfferCentsTotal(snapshotLines.map((line) => line.computed.marginNetCents))}</dd></div>
        </dl>
      ) : null}
      <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
        <p className="font-semibold">Lokale Preisvorschau · noch nicht gespeichert</p>
        {preview ? (
          <dl className="mt-2 grid gap-2">
            <div className="flex justify-between gap-4"><dt>Netto</dt><dd className="font-semibold tabular-nums">{formatOfferCents(preview.totals.basisNetCents)}</dd></div>
            <div className="flex justify-between gap-4"><dt>Steuer</dt><dd className="font-semibold tabular-nums">{formatOfferCents(preview.totals.basisTaxCents)}</dd></div>
            <div className="flex justify-between gap-4"><dt>Brutto</dt><dd className="font-semibold tabular-nums">{formatOfferCents(preview.totals.basisGrossCents)}</dd></div>
          </dl>
        ) : <p className="mt-1 text-base leading-6">Vorschau erst nach gültigen Mengen-, Preis- und Rabattangaben.</p>}
      </div>
      <p className="mt-4 text-base leading-6 text-slate-600">
        Die Vorschau nutzt denselben ganzzahligen Money-Code. Preiswahrheit bleibt ausschließlich die erfolgreiche Serverrevision.
      </p>
    </div>
  );
}

function productSubtitle(line: OfferLineView): string {
  return [line.product.manufacturer, line.product.model].filter(Boolean).join(" · ");
}

function positionLabel(positionType: string): string {
  if (positionType === "required") return "Erforderlich";
  if (positionType === "additional") return "Zusatzleistung";
  return "Optional";
}

const CATEGORY_OPTIONS: readonly { value: OfferComponentCategory; label: string }[] = [
  { value: "module", label: "PV-Module" },
  { value: "inverter", label: "Wechselrichter" },
  { value: "battery", label: "Speicher" },
  { value: "wallbox", label: "Wallbox" },
  { value: "heat_pump", label: "Wärmepumpe" },
  { value: "mounting", label: "Montage" },
  { value: "other", label: "Sonstiges" },
];

function pricingProvenanceLabel(provenance: { kind: string; reasonCode?: string } | undefined): string {
  if (provenance?.kind === "catalog_seed") return "Katalog";
  if (provenance?.kind === "manual_override") {
    const reasons: Record<string, string> = {
      customer_specific_pricing: "Kundenspezifisch",
      negotiated: "Verhandelt",
      correction: "Korrektur",
      other: "Sonstiges",
    };
    return `Manueller Override · ${reasons[provenance.reasonCode ?? ""] ?? "dokumentiert"}`;
  }
  if (provenance?.kind === "custom") return "Freie Position";
  return "Nicht verfügbar";
}

export function OfferVariantEditor({ view }: { view: EditableOfferView }) {
  const router = useRouter();
  const snapshot = view.activeVariant.snapshot;
  const incomingSource = useMemo(() => sourceFromSnapshot(snapshot), [snapshot]);
  const [source] = useState(incomingSource);
  const [draft, setDraft] = useState<OfferEditorDraft>(() => createOfferEditorDraft(incomingSource));
  const [savedDraft, setSavedDraft] = useState<OfferEditorDraft>(() => createOfferEditorDraft(incomingSource));
  const [feedback, setFeedback] = useState<Feedback>(() => initialFeedback(view));
  const [mutationPending, setMutationPending] = useState(view.state === "pending");
  const [awaitingServerReadmodel, setAwaitingServerReadmodel] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState(snapshot.variantId);
  const [duplicateName, setDuplicateName] = useState(`${snapshot.variantName} Kopie`);
  const [basisName, setBasisName] = useState("Aktuelle Basis");
  const [basisTaxTreatment, setBasisTaxTreatment] = useState<"" | "standard_19" | "zero_operator_confirmed">("");
  const [zeroTaxConfirmed, setZeroTaxConfirmed] = useState(false);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const reorderFocusLineIdRef = useRef<string | null>(null);
  const [rebaseNotices, setRebaseNotices] = useState<readonly string[]>([]);
  const [rebaseRecovered, setRebaseRecovered] = useState(false);
  const [purchaseDraftOmitted, setPurchaseDraftOmitted] = useState(false);
  const [recoveryHydrating, setRecoveryHydrating] = useState(true);
  const [unappliedRebaseLines, setUnappliedRebaseLines] = useState<readonly OfferEditorDraft["sections"][number]["lines"][number][]>([]);
  const [unappliedRebaseSections, setUnappliedRebaseSections] = useState<readonly OfferEditorDraft["sections"][number][]>([]);
  const [clock, setClock] = useState(() => Date.now());
  const [expectedRevision, setExpectedRevision] = useState(snapshot.revision);
  const mutationLockRef = useRef(false);
  const expectedRevisionRef = useRef(snapshot.revision);
  const summaryRef = useRef<HTMLDivElement>(null);
  const dirty = !awaitingServerReadmodel && isOfferEditorDraftDirty(source, draft);
  const preview = useMemo(() => calculateOfferEditorPreview(draft), [draft]);
  const recoveryKey = `wmee:offer-draft:${view.offer.id}:${snapshot.variantId}`;
  const retryAt = feedback.status === "unavailable"
    ? Date.parse(feedback.retryAfter)
    : Number.NaN;
  const retryBlocked = Number.isFinite(retryAt) && clock < retryAt;
  const pending = mutationPending || view.state === "pending";
  const navigationPending = pending || awaitingServerReadmodel
    || recoveryHydrating;
  const hardBlocked = feedback.status === "blocked"
    || feedback.status === "conflict"
    || feedback.status === "denied"
    || feedback.status === "unauthenticated";
  const mutationDisabled = navigationPending || retryBlocked || hardBlocked;

  useEffect(() => {
    if (feedback.status !== "unavailable") return;
    const milliseconds = Date.parse(feedback.retryAfter) - Date.now();
    if (milliseconds <= 0) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(milliseconds + 25, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    const raw = window.sessionStorage.getItem(recoveryKey);
    let rebased: ReturnType<typeof rebaseOfferEditorDraft> | null = null;
    let omittedPurchaseDraft = false;
    if (raw) {
      try {
        const envelope = JSON.parse(raw) as {
          schemaVersion?: unknown;
          offerId?: unknown;
          variantId?: unknown;
          recoveryScope?: unknown;
          purchaseDraftOmitted?: unknown;
          previousBase?: unknown;
          localDraft?: unknown;
        };
        const envelopeMatches = envelope.schemaVersion === "offer-editor-rebase.v1"
          && envelope.offerId === view.offer.id
          && envelope.variantId === snapshot.variantId
          && envelope.recoveryScope === view.recoveryScope
          && envelope.previousBase !== null && typeof envelope.previousBase === "object"
          && envelope.localDraft !== null && typeof envelope.localDraft === "object";
        if (envelopeMatches) {
          const prepared = prepareOfferEditorRecoveryDrafts({
            recoveryScope: envelope.recoveryScope as string,
            previousBase: envelope.previousBase as OfferEditorDraft,
            localDraft: envelope.localDraft as OfferEditorDraft,
          }, view.recoveryScope);
          if (prepared) {
            omittedPurchaseDraft = envelope.purchaseDraftOmitted === true
              && view.permissions.canEditPurchasePrice;
            rebased = rebaseOfferEditorDraft(
              prepared.previousBase,
              prepared.localDraft,
              createOfferEditorDraft(incomingSource),
            );
          }
        }
      } catch {
        // Fail closed: fremde oder beschädigte Session-Daten werden nie als
        // Angebotscommand interpretiert. Die Hydration wird trotzdem sauber
        // abgeschlossen, damit ein alter History-Sentinel nicht hängenbleibt.
      }
    }
    const recovered = rebased;
    let recoveryCleanupFrame: number | null = null;
    const timer = window.setTimeout(() => {
      if (recovered) {
        setDraft(recovered.draft);
        setRebaseNotices(recovered.notices);
        setUnappliedRebaseLines(recovered.unappliedLines);
        setUnappliedRebaseSections(recovered.unappliedSections);
        setPurchaseDraftOmitted(omittedPurchaseDraft);
        setRebaseRecovered(true);
        setFeedback({ status: "idle" });
      }
      setRecoveryHydrating(false);
      if (raw) {
        // Keep the already-redacted envelope recoverable until React has
        // committed the in-memory draft. If an accepted native navigation
        // tears down this mount beforehand, cleanup is cancelled and the next
        // mount can still recover it.
        recoveryCleanupFrame = window.requestAnimationFrame(() => {
          window.sessionStorage.removeItem(recoveryKey);
        });
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (recoveryCleanupFrame !== null) {
        window.cancelAnimationFrame(recoveryCleanupFrame);
      }
    };
  }, [
    incomingSource,
    recoveryKey,
    snapshot.variantId,
    view.offer.id,
    view.permissions.canEditPurchasePrice,
    view.recoveryScope,
  ]);

  useEffect(() => {
    const lineId = reorderFocusLineIdRef.current;
    if (!lineId) return;
    reorderFocusLineIdRef.current = null;
    window.requestAnimationFrame(() => {
      const selector = document.getElementById(`line-${lineId}-target-section`);
      if (selector instanceof HTMLSelectElement && !selector.disabled) {
        selector.focus();
        return;
      }
      document.getElementById(`line-${lineId}-editor`)?.focus();
    });
  }, [draft.sections]);

  useEffect(() => {
    if (!["validation", "conflict", "unavailable", "unauthenticated", "denied", "blocked", "unexpected"].includes(feedback.status)) return;
    window.requestAnimationFrame(() => {
      if (feedback.status === "validation") {
        const firstField = feedback.errors[0]?.field;
        const target = firstField ? document.getElementById(offerErrorTarget(firstField)) : null;
        if (target instanceof HTMLElement) {
          target.focus();
          return;
        }
      }
      summaryRef.current?.focus();
    });
  }, [feedback]);

  function requestIntent(intent: PendingIntent) {
    if (navigationPending) return;
    if (!dirty) {
      void intent.execute();
      return;
    }
    setPendingIntent(() => intent);
  }

  function updateDraftLine(
    sectionDomainId: string,
    lineDomainId: string,
    values: Partial<OfferEditorDraft["sections"][number]["lines"][number]>,
  ) {
    setDraft((current) => ({
      ...current,
      sections: current.sections.map((section) => section.sectionDomainId === sectionDomainId
        ? {
            ...section,
            lines: section.lines.map((line) => line.lineDomainId === lineDomainId
              ? { ...line, ...values }
              : line),
          }
        : section),
    }));
    if (feedback.status === "success") setFeedback({ status: "idle" });
  }

  function updateSectionDiscount(sectionDomainId: string, value: string) {
    setDraft((current) => ({
      ...current,
      sections: current.sections.map((section) => section.sectionDomainId === sectionDomainId
        ? { ...section, discountPercent: value }
        : section),
    }));
  }

  function updateDraftSection(
    sectionDomainId: string,
    values: Partial<OfferEditorDraft["sections"][number]>,
  ) {
    setDraft((current) => ({
      ...current,
      sections: current.sections.map((section) => section.sectionDomainId === sectionDomainId
        ? { ...section, ...values }
        : section),
    }));
  }

  async function runExclusive(
    action: () => Promise<OfferEditorActionState>,
  ): Promise<OfferEditorActionState | null> {
    if (mutationLockRef.current || retryBlocked || hardBlocked) return null;
    mutationLockRef.current = true;
    setMutationPending(true);
    setFeedback({ status: "pending" });
    try {
      return await action();
    } catch {
      setFeedback({ status: "unexpected" });
      return null;
    } finally {
      mutationLockRef.current = false;
      setMutationPending(false);
    }
  }

  async function saveDraft(): Promise<boolean> {
    const built = buildOfferRevisionOperations(source, draft, {
      canEditPrice: view.permissions.canEditPrice,
      canApplyDiscount: view.permissions.canApplyDiscount,
      canEditPurchasePrice: view.permissions.canEditPurchasePrice,
    });
    if (!built.ok) {
      setFeedback({ status: "validation", errors: built.errors });
      return false;
    }
    if (built.operations.length === 0) {
      setDraft(createOfferEditorDraft(source));
      setFeedback({ status: "noop" });
      return true;
    }
    const formData = new FormData();
    formData.set("workspaceId", view.workspaceId);
    formData.set("offerId", view.offer.id);
    formData.set("variantId", snapshot.variantId);
    formData.set("expectedRevision", String(expectedRevisionRef.current));
    formData.set("operations", JSON.stringify(built.operations));
    const result = await runExclusive(() => saveOfferVariantDraftAction(formData));
    if (!result) return false;
    if (result.status !== "success") {
      setFeedback(feedbackFromAction(result));
      return false;
    }
    expectedRevisionRef.current = result.revision;
    setExpectedRevision(result.revision);
    setSavedDraft(draft);
    setFeedback({ status: "success", revision: result.revision });
    setAwaitingServerReadmodel(true);
    router.refresh();
    return true;
  }

  async function duplicateVariant() {
    const name = duplicateName.normalize("NFC").trim();
    if (name.length === 0 || name.length > 120) {
      setFeedback({
        status: "validation",
        errors: [{ field: "duplicate-name", message: "Der Kopiename muss 1 bis 120 Zeichen enthalten." }],
      });
      return;
    }
    const formData = new FormData();
    formData.set("workspaceId", view.workspaceId);
    formData.set("offerId", view.offer.id);
    formData.set("sourceVariantId", snapshot.variantId);
    formData.set("expectedSourceRevision", String(expectedRevisionRef.current));
    formData.set("name", name);
    const result = await runExclusive(() => duplicateOfferVariantEditorAction(formData));
    if (!result) return;
    if (result.status !== "success") {
      setFeedback(feedbackFromAction(result));
      return;
    }
    router.push(`/w/${view.workspaceId}/angebote/${result.offerId}?variante=${result.variantId}`);
  }

  async function createNewBasis() {
    const basisInput = view.basisInput;
    const name = basisName.normalize("NFC").trim();
    if (!basisInput || name.length === 0 || name.length > 120) {
      setFeedback({
        status: "validation",
        errors: [{ field: "basis-name", message: "Die neue Basis braucht einen gültigen Namen und Revisionsstand." }],
      });
      return;
    }
    if (basisTaxTreatment === "") {
      setFeedback({
        status: "validation",
        errors: [{ field: "basis-tax", message: "Wähle die Steuerbehandlung für die neue Basis ausdrücklich aus." }],
      });
      return;
    }
    if (basisTaxTreatment === "zero_operator_confirmed" && !zeroTaxConfirmed) {
      setFeedback({
        status: "validation",
        errors: [{ field: "basis-zero-confirmation", message: "0 % USt. muss für diese neue Basis bewusst bestätigt werden." }],
      });
      return;
    }
    const formData = new FormData();
    formData.set("workspaceId", view.workspaceId);
    formData.set("offerId", view.offer.id);
    formData.set("expectedRequirementRevision", String(basisInput.expectedRequirementRevision));
    formData.set("expectedCalculationRevision", String(basisInput.expectedCalculationRevision));
    formData.set("expectedResolutionRevision", String(basisInput.expectedResolutionRevision));
    formData.set("name", name);
    formData.set("taxTreatment", basisTaxTreatment);
    if (basisTaxTreatment === "zero_operator_confirmed") {
      formData.set("zeroConfirmation.code", "zero_tax_draft_operator_confirmed");
      formData.set("zeroConfirmation.confirmed", "true");
    }
    const result = await runExclusive(() => createVariantFromCurrentResolutionEditorAction(formData));
    if (!result) return;
    if (result.status !== "success") {
      setFeedback(feedbackFromAction(result));
      return;
    }
    router.push(`/w/${view.workspaceId}/angebote/${result.offerId}?variante=${result.variantId}`);
  }

  async function signOutAfterDiscard() {
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setFeedback({ status: "unexpected" });
        return;
      }
      window.location.replace("/login");
    } catch {
      setFeedback({ status: "unexpected" });
    }
  }

  function preserveDraftAndReload() {
    window.sessionStorage.setItem(recoveryKey, JSON.stringify(
      createOfferEditorRecoveryEnvelope({
        offerId: view.offer.id,
        variantId: snapshot.variantId,
        recoveryScope: view.recoveryScope,
        expectedRevision: expectedRevisionRef.current,
        previousBase: savedDraft,
        localDraft: draft,
      }),
    ));
    window.location.reload();
  }

  const errors = feedback.status === "validation" ? feedback.errors : [];
  const invalidFields = new Set(errors.map((error) => error.field));
  const errorByField = new Map(errors.map((error) => [error.field, error.message]));
  const errorDescription = (field: string) => invalidFields.has(field) ? `${field}-error` : undefined;
  const fieldError = (field: string) => {
    const message = errorByField.get(field);
    return message ? <p id={`${field}-error`} className="mt-1 text-xs font-semibold text-rose-800">{message}</p> : null;
  };

  return (
    <DirtyNavigationGuard
      dirty={dirty}
      hydrating={recoveryHydrating}
      pending={navigationPending}
      save={saveDraft}
      themeClassName={offerThemeStyles.offerTheme}
    >
      <main data-wmee-scope="offer" data-offer-detail-state={feedback.status === "idle" ? view.state : feedback.status} className={`${offerThemeStyles.offerTheme} min-h-screen bg-slate-50 text-slate-950`}>
        <div className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <a href="#offer-editor-main" className="sr-only rounded bg-white px-3 py-2 font-semibold focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:ring-2 focus:ring-emerald-700">
            Zum Angebotseditor springen
          </a>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <nav aria-label="Brotkrumen">
              <GuardedLink
                href={`/w/${view.workspaceId}/angebote`}
                label="Angebotsübersicht"
                dirty={dirty}
                pending={navigationPending}
                requestIntent={requestIntent}
                navigate={(href) => router.push(href)}
                className="inline-flex min-h-11 items-center text-sm font-semibold text-emerald-800 outline-none hover:text-emerald-950 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2"
              >
                <span aria-hidden="true" className="mr-2">←</span> Zur Angebotsübersicht
              </GuardedLink>
            </nav>
            <GuardedSignOutButton
              dirty={dirty}
              pending={navigationPending}
              onBlockedSignOut={() => requestIntent({ label: "Anmeldung", execute: signOutAfterDiscard })}
            />
          </div>

          <header className="mb-6 border-b border-slate-200 pb-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-800">{view.offer.offerNumber}</p>
                <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight sm:text-3xl">{snapshot.contactContext.displayName}</h1>
                <p className="mt-2 text-sm leading-6 text-slate-600">{snapshot.installationSiteContext.formattedAddress}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold">Revision {expectedRevision}</span>
                <span className={dirty ? "rounded-full bg-blue-100 px-3 py-1.5 text-xs font-semibold text-blue-900" : "rounded-full bg-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-900"}>
                  {dirty ? "Ungespeichert" : "Gespeichert"}
                </span>
              </div>
            </div>
          </header>

          <div className="grid gap-4">
            {view.offer.outdated ? <PersistentOutdatedWarning /> : null}
            {rebaseRecovered ? (
              <div role="status" className="rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-base leading-6 text-blue-950">
                <p className="font-semibold">Lokaler Draft wurde auf den aktuellen Serverstand rebasiert.</p>
                <p className="mt-1">Deine Eingaben bleiben sichtbar. Prüfe parallele Änderungen vor dem erneuten Speichern.</p>
                {purchaseDraftOmitted ? (
                  <p data-offer-recovery-purchase-omitted="true" className="mt-2 font-semibold">
                    Ein lokaler EK-Entwurf wurde aus Sicherheitsgründen nicht im Browser gespeichert und konnte nicht wiederhergestellt werden. Prüfe den aktuellen Server-EK und trage deine Änderung bei Bedarf erneut ein.
                  </p>
                ) : null}
                {rebaseNotices.length > 0 ? <ul className="mt-2 list-disc space-y-1 pl-5">{rebaseNotices.map((notice) => <li key={notice}>{notice}</li>)}</ul> : null}
                {unappliedRebaseLines.length > 0 || unappliedRebaseSections.length > 0 ? (
                  <details className="mt-3 rounded-md border border-blue-300 bg-white p-3">
                    <summary className="min-h-11 cursor-pointer py-2 font-semibold">Erhaltene, nicht automatisch anwendbare Zeilenwerte</summary>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ sections: unappliedRebaseSections, lines: unappliedRebaseLines }, null, 2)}</pre>
                  </details>
                ) : null}
              </div>
            ) : null}
            <FeedbackBanner
              feedback={feedback}
              dirty={dirty}
              summaryRef={summaryRef}
              onReloadServer={preserveDraftAndReload}
              onLogin={() => requestIntent({
                label: "Anmeldung",
                execute: () => window.location.replace("/login"),
              })}
            />
            <div className="sm:hidden">
              <label htmlFor="mobile-variant" className="text-sm font-semibold text-slate-800">Angebotsvariante</label>
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <select
                  id="mobile-variant"
                  name="mobile-variant"
                  value={selectedVariantId}
                  disabled={navigationPending}
                  onChange={(event) => setSelectedVariantId(event.target.value)}
                  className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
                >
                  {(view.variants ?? []).map((variant) => <option key={variant.id} value={variant.id}>{variant.name} · Rev. {variant.revision}</option>)}
                </select>
                <button
                  type="button"
                  disabled={navigationPending || selectedVariantId === snapshot.variantId}
                  onClick={() => {
                    const selected = view.variants?.find((variant) => variant.id === selectedVariantId);
                    if (selected) requestIntent({ label: selected.name, execute: () => router.push(selected.href) });
                  }}
                  className="min-h-11 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2"
                >
                  Variante öffnen
                </button>
              </div>
            </div>
            <nav aria-label="Angebotsvarianten" className="hidden overflow-x-auto sm:block">
              <ul className="flex min-w-max list-none gap-2 pb-1">
                {(view.variants ?? []).map((variant) => (
                  <li key={variant.id}>
                    <GuardedLink
                      href={variant.href}
                      label={variant.name}
                      dirty={dirty}
                      pending={navigationPending}
                      requestIntent={requestIntent}
                      navigate={(href) => router.push(href)}
                      current={variant.active}
                      className={variant.active
                        ? "inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2"
                        : "inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2"}
                    >
                      {variant.name}<span className={variant.active ? "ml-2 text-xs text-white" : "ml-2 text-xs text-slate-700"}>Rev. {variant.revision}</span>
                    </GuardedLink>
                  </li>
                ))}
              </ul>
            </nav>
          </div>

          <fieldset id="offer-editor-main" tabIndex={-1} disabled={navigationPending || hardBlocked} className="mt-6 min-w-0 border-0 p-0">
            <legend className="sr-only">Angebotsentwurf {snapshot.variantName} bearbeiten</legend>
            <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
              <div className="grid min-w-0 gap-5">
                <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                  <h2 className="text-lg font-semibold">Aktive Variante</h2>
                  <div className="mt-4 grid gap-4">
                    <div>
                      <label htmlFor="variant-name" className="text-sm font-semibold">Variantenname</label>
                      <input id="variant-name" value={draft.variantName} aria-invalid={invalidFields.has("variant-name") || undefined} aria-describedby={errorDescription("variant-name")} onChange={(event) => setDraft((current) => ({ ...current, variantName: event.target.value }))} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />
                      {fieldError("variant-name")}
                    </div>
                    <div>
                      <label htmlFor="variant-description" className="text-sm font-semibold">Beschreibung</label>
                      <textarea id="variant-description" rows={3} value={draft.description} aria-invalid={invalidFields.has("variant-description") || undefined} aria-describedby={errorDescription("variant-description")} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />
                      {fieldError("variant-description")}
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {view.permissions.canApplyDiscount ? (
                        <>
                          <div>
                            <label htmlFor="global-discount" className="text-sm font-semibold">Globaler Rabatt %</label>
                            <input id="global-discount" inputMode="decimal" value={draft.globalDiscountPercent} aria-invalid={invalidFields.has("global-discount") || undefined} aria-describedby={errorDescription("global-discount")} onChange={(event) => setDraft((current) => ({ ...current, globalDiscountPercent: event.target.value }))} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />
                            {fieldError("global-discount")}
                          </div>
                          <div>
                            <label htmlFor="custom-deal" className="text-sm font-semibold">Custom Deal netto €</label>
                            <input id="custom-deal" inputMode="decimal" value={draft.customDealNetEuros} aria-invalid={invalidFields.has("custom-deal") || undefined} aria-describedby={errorDescription("custom-deal")} onChange={(event) => setDraft((current) => ({ ...current, customDealNetEuros: event.target.value }))} placeholder="Kein fester Zielpreis" className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />
                            {fieldError("custom-deal")}
                          </div>
                        </>
                      ) : (
                        <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-slate-600">Globaler Rabatt</dt><dd className="font-semibold">{(snapshot.globalDiscountBps / 100).toLocaleString("de-DE")} %</dd></div><div><dt className="text-slate-600">Custom Deal netto</dt><dd className="font-semibold tabular-nums">{snapshot.customDealNetCents === null ? "Kein Custom Deal" : formatOfferCents(snapshot.customDealNetCents)}</dd></div></dl>
                      )}
                    </div>
                  </div>
                </section>

                <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">Vertriebsprognose</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{view.offer.forecastValueNetCents === null ? "Nicht hinterlegt" : `${formatCents(view.offer.forecastValueNetCents)} netto`}</p>
                  <p className="mt-1 text-base leading-6 text-slate-600">Separater gespeicherter Vertriebswert. Er beeinflusst weder lokale Positionen noch serverberechnete Kundensummen.</p>
                </section>

                {draft.sections.map((draftSection, sectionIndex) => {
                  const section = snapshot.sections.find((entry) => entry.sectionDomainId === draftSection.sectionDomainId);
                  const sectionTitle = draftSection.title;
                  const removableSection = canRemoveOfferDraftSection(
                    source,
                    draft,
                    draftSection.sectionDomainId,
                  );
                  return (
                    <section key={draftSection.sectionDomainId} className="min-w-0 rounded-lg border border-slate-200 bg-slate-100/70 p-4 sm:p-5">
                      <header className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">Sektion {sectionIndex + 1} · {draftSection.isNew ? "frei" : CATEGORY_OPTIONS.find((entry) => entry.value === draftSection.category)?.label}</p>
                          {draftSection.isNew ? (
                            <div className="mt-2 grid gap-3 sm:grid-cols-2">
                              <div><label htmlFor={`section-${draftSection.sectionDomainId}-title`} className="text-xs font-semibold">Sektionsname</label><input id={`section-${draftSection.sectionDomainId}-title`} value={draftSection.title} aria-invalid={invalidFields.has(`section-${draftSection.sectionDomainId}-title`) || undefined} aria-describedby={errorDescription(`section-${draftSection.sectionDomainId}-title`)} onChange={(event) => updateDraftSection(draftSection.sectionDomainId, { title: event.target.value })} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />{fieldError(`section-${draftSection.sectionDomainId}-title`)}</div>
                              <div><label htmlFor={`section-${draftSection.sectionDomainId}-category`} className="text-xs font-semibold">Kategorie</label><select id={`section-${draftSection.sectionDomainId}-category`} value={draftSection.category} onChange={(event) => updateDraftSection(draftSection.sectionDomainId, { category: event.target.value as OfferComponentCategory })} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">{CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
                            </div>
                          ) : <h2 className="mt-1 text-lg font-semibold">{sectionTitle}</h2>}
                        </div>
                        <div className="flex flex-wrap gap-2" aria-label={`Reihenfolge der Sektion ${sectionTitle}`}>
                          <button type="button" aria-label={`Sektion ${sectionTitle} nach oben verschieben`} disabled={sectionIndex === 0 || navigationPending} onClick={(event) => { setDraft((current) => moveOfferDraftSection(current, draftSection.sectionDomainId, "up")); setReorderAnnouncement(`Sektion ${sectionTitle} ist jetzt Position ${sectionIndex}.`); event.currentTarget.focus(); }} className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">Hoch</button>
                          <button type="button" aria-label={`Sektion ${sectionTitle} nach unten verschieben`} disabled={sectionIndex === draft.sections.length - 1 || navigationPending} onClick={(event) => { setDraft((current) => moveOfferDraftSection(current, draftSection.sectionDomainId, "down")); setReorderAnnouncement(`Sektion ${sectionTitle} ist jetzt Position ${sectionIndex + 2}.`); event.currentTarget.focus(); }} className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">Runter</button>
                          {removableSection ? <button type="button" onClick={() => setDraft((current) => removeCustomOfferDraftSection(current, draftSection.sectionDomainId))} className="min-h-11 rounded-md border border-rose-300 bg-white px-3 text-xs font-semibold text-rose-800 outline-none focus-visible:ring-2 focus-visible:ring-rose-700">Freie Sektion entfernen</button> : null}
                        </div>
                      </header>
                      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
                        {view.permissions.canApplyDiscount ? (
                          <div className="w-36">
                            <label htmlFor={`section-${draftSection.sectionDomainId}-discount`} className="text-xs font-semibold">Sektionsrabatt %</label>
                            <input id={`section-${draftSection.sectionDomainId}-discount`} inputMode="decimal" value={draftSection.discountPercent} aria-invalid={invalidFields.has(`section-${draftSection.sectionDomainId}-discount`) || undefined} aria-describedby={errorDescription(`section-${draftSection.sectionDomainId}-discount`)} onChange={(event) => updateSectionDiscount(draftSection.sectionDomainId, event.target.value)} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />
                            {fieldError(`section-${draftSection.sectionDomainId}-discount`)}
                          </div>
                        ) : (
                          <p className="text-xs text-slate-600">Sektionsrabatt: {((section?.discountBps ?? 0) / 100).toLocaleString("de-DE")} %</p>
                        )}
                        {view.permissions.canEditPurchasePrice ? <button type="button" onClick={() => setDraft((current) => addCustomOfferDraftLine(current, draftSection.sectionDomainId, { lineDomainId: crypto.randomUUID() }))} className="min-h-11 rounded-md border border-emerald-800 bg-white px-3 text-sm font-semibold text-emerald-900 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">Freie Position hinzufügen</button> : null}
                      </div>
                      <ul className="mt-4 grid list-none gap-3">
                        {draftSection.lines.map((draftLine, lineIndex) => {
                          const line = snapshot.sections.flatMap((entry) => entry.lines).find((entry) => entry.lineDomainId === draftLine.lineDomainId);
                          const prefix = `line-${draftLine.lineDomainId}`;
                          const displayName = line?.product.displayName ?? draftLine.displayName;
                          const salesPriceChanged = line
                            ? isOfferEditorPriceInputChanged(draftLine.salesUnitNetEuros, line.salesPricing.effectiveUnitNetCents)
                            : false;
                          const savedPurchaseUnitNetCents = line?.purchasePricing?.effectiveUnitNetCents;
                          const purchasePriceChanged = savedPurchaseUnitNetCents !== undefined
                            ? isOfferEditorPriceInputChanged(draftLine.purchaseUnitNetEuros, savedPurchaseUnitNetCents)
                            : false;
                          const needsZeroConfirmation = draftLine.taxTreatment === "zero_operator_confirmed"
                            && (draftLine.isNew || line?.taxTreatment !== "zero_operator_confirmed");
                          return (
                            <li id={`${prefix}-editor`} key={draftLine.lineDomainId} tabIndex={-1} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0"><p className="break-words font-semibold">{displayName}</p>{line && productSubtitle(line) ? <p className="mt-1 text-xs text-slate-500">{productSubtitle(line)}</p> : null}<p className="mt-1 text-xs text-slate-500">Quelle: {draftLine.sourceKind === "catalog" ? "Katalog-Snapshot" : "freie Position"}</p>{line ? <><p className="mt-1 text-xs text-slate-500">VK-Preisprovenienz: {pricingProvenanceLabel(line.salesPricing.provenance)}</p><p className="mt-1 text-xs text-slate-500">Gespeicherte Zeilensumme netto: {formatCents(line.computed.finalSalesNetCents)}</p></> : <p className="mt-1 text-xs text-slate-500">Noch nicht serverseitig berechnet</p>}</div>
                                <div className="flex flex-wrap gap-2" aria-label={`Position von ${displayName}`}>
                                  <button type="button" aria-label={`${displayName} in ${sectionTitle} nach oben verschieben`} disabled={lineIndex === 0 || navigationPending} onClick={(event) => { setDraft((current) => moveOfferDraftLine(current, draftSection.sectionDomainId, draftLine.lineDomainId, "up")); setReorderAnnouncement(`${displayName} in ${sectionTitle} ist jetzt Position ${lineIndex}.`); event.currentTarget.focus(); }} className="min-h-11 min-w-11 rounded-md border border-slate-300 px-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">Hoch</button>
                                  <button type="button" aria-label={`${displayName} in ${sectionTitle} nach unten verschieben`} disabled={lineIndex === draftSection.lines.length - 1 || navigationPending} onClick={(event) => { setDraft((current) => moveOfferDraftLine(current, draftSection.sectionDomainId, draftLine.lineDomainId, "down")); setReorderAnnouncement(`${displayName} in ${sectionTitle} ist jetzt Position ${lineIndex + 2}.`); event.currentTarget.focus(); }} className="min-h-11 min-w-11 rounded-md border border-slate-300 px-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">Runter</button>
                                  {draftLine.sourceKind === "custom" ? <button type="button" onClick={() => setDraft((current) => removeCustomOfferDraftLine(current, draftLine.lineDomainId))} className="min-h-11 rounded-md border border-rose-300 px-3 text-xs font-semibold text-rose-800 outline-none focus-visible:ring-2 focus-visible:ring-rose-700">Freie Position entfernen</button> : null}
                                </div>
                              </div>
                              {draftLine.sourceKind === "custom" ? <div className="mt-4 grid gap-4 sm:grid-cols-2"><div><label htmlFor={`${prefix}-name`} className="text-xs font-semibold">Positionsname</label><input id={`${prefix}-name`} value={draftLine.displayName} aria-invalid={invalidFields.has(`${prefix}-name`) || undefined} aria-describedby={errorDescription(`${prefix}-name`)} onChange={(event) => updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { displayName: event.target.value })} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />{fieldError(`${prefix}-name`)}</div><div><label htmlFor={`${prefix}-description`} className="text-xs font-semibold">Positionsbeschreibung</label><input id={`${prefix}-description`} value={draftLine.description} aria-invalid={invalidFields.has(`${prefix}-description`) || undefined} aria-describedby={errorDescription(`${prefix}-description`)} onChange={(event) => updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { description: event.target.value })} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />{fieldError(`${prefix}-description`)}</div></div> : line?.product.description ? <p className="mt-3 text-sm text-slate-600">{line.product.description}</p> : null}
                              <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                                {draftLine.sourceKind === "custom" ? <div><label htmlFor={`${prefix}-unit`} className="text-xs font-semibold">Einheit</label><select id={`${prefix}-unit`} value={draftLine.unit} aria-invalid={invalidFields.has(`${prefix}-unit`) || undefined} aria-describedby={errorDescription(`${prefix}-unit`)} onChange={(event) => updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { unit: event.target.value as OfferUnit })} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"><option value="piece">Stück</option><option value="set">Set</option><option value="meter">Meter</option></select>{fieldError(`${prefix}-unit`)}</div> : null}
                                <div><label htmlFor={`${prefix}-quantity`} className="text-xs font-semibold">Menge</label><input id={`${prefix}-quantity`} inputMode="decimal" value={draftLine.quantity} aria-invalid={invalidFields.has(`${prefix}-quantity`) || undefined} aria-describedby={errorDescription(`${prefix}-quantity`)} onChange={(event) => updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { quantity: event.target.value })} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />{fieldError(`${prefix}-quantity`)}</div>
                                {view.permissions.canEditPrice ? (
                                  <>
                                    <div><label htmlFor={`${prefix}-sales-price`} className="text-xs font-semibold">VK je Einheit €</label><input id={`${prefix}-sales-price`} inputMode="decimal" value={draftLine.salesUnitNetEuros} aria-invalid={invalidFields.has(`${prefix}-sales-price`) || undefined} aria-describedby={errorDescription(`${prefix}-sales-price`)} onChange={(event) => { const value = event.target.value; updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { salesUnitNetEuros: value, ...(line && !isOfferEditorPriceInputChanged(value, line.salesPricing.effectiveUnitNetCents) ? { salesPriceReason: "correction" as const } : {}) }); }} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />{fieldError(`${prefix}-sales-price`)}</div>
                                    {line ? <div><label htmlFor={`${prefix}-sales-reason`} className="text-xs font-semibold">Grund für VK-Änderung</label><select id={`${prefix}-sales-reason`} value={draftLine.salesPriceReason} disabled={!salesPriceChanged} onChange={(event: ChangeEvent<HTMLSelectElement>) => updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { salesPriceReason: event.target.value as OfferPriceReason })} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"><option value="correction">Korrektur</option><option value="negotiated">Verhandelt</option><option value="customer_specific_pricing">Kundenspezifisch</option><option value="other">Sonstiges</option></select>{!salesPriceChanged ? <p className="mt-1 text-base leading-6 text-slate-600">Wird erst bei einer echten VK-Änderung aktiv.</p> : null}</div> : null}
                                  </>
                                ) : <div><p className="text-xs font-semibold">VK je Einheit</p><p className="mt-2 text-sm font-semibold tabular-nums">{line ? formatCents(line.salesPricing.effectiveUnitNetCents) : "–"}</p></div>}
                                {view.permissions.canEditPurchasePrice && draftLine.sourceKind === "custom" ? <><div><label htmlFor={`${prefix}-purchase-price`} className="text-xs font-semibold">EK je Einheit €</label><input id={`${prefix}-purchase-price`} inputMode="decimal" value={draftLine.purchaseUnitNetEuros} aria-invalid={invalidFields.has(`${prefix}-purchase-price`) || undefined} aria-describedby={errorDescription(`${prefix}-purchase-price`)} onChange={(event) => { const value = event.target.value; updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { purchaseUnitNetEuros: value, ...(savedPurchaseUnitNetCents !== undefined && !isOfferEditorPriceInputChanged(value, savedPurchaseUnitNetCents) ? { purchasePriceReason: "correction" as const } : {}) }); }} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />{fieldError(`${prefix}-purchase-price`)}</div>{!draftLine.isNew ? <div><label htmlFor={`${prefix}-purchase-reason`} className="text-xs font-semibold">Grund für EK-Änderung</label><select id={`${prefix}-purchase-reason`} value={draftLine.purchasePriceReason} disabled={!purchasePriceChanged} onChange={(event) => updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { purchasePriceReason: event.target.value as OfferPriceReason })} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"><option value="correction">Korrektur</option><option value="negotiated">Verhandelt</option><option value="customer_specific_pricing">Kundenspezifisch</option><option value="other">Sonstiges</option></select>{!purchasePriceChanged ? <p className="mt-1 text-base leading-6 text-slate-600">Wird erst bei einer echten EK-Änderung aktiv.</p> : null}</div> : null}</> : null}
                                {view.permissions.canApplyDiscount ? <div><label htmlFor={`${prefix}-discount`} className="text-xs font-semibold">Zeilenrabatt %</label><input id={`${prefix}-discount`} inputMode="decimal" value={draftLine.lineDiscountPercent} aria-invalid={invalidFields.has(`${prefix}-discount`) || undefined} aria-describedby={errorDescription(`${prefix}-discount`)} onChange={(event) => updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { lineDiscountPercent: event.target.value })} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />{fieldError(`${prefix}-discount`)}</div> : <div><p className="text-xs font-semibold">Zeilenrabatt</p><p className="mt-2 text-sm">{((line?.lineDiscountBps ?? 0) / 100).toLocaleString("de-DE")} %</p></div>}
                                <div><label htmlFor={`${prefix}-position-type`} className="text-xs font-semibold">Positionsart</label><select id={`${prefix}-position-type`} value={draftLine.positionType} onChange={(event) => updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { positionType: event.target.value as OfferPositionType })} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"><option value="required">Erforderlich</option><option value="additional">Zusatzleistung</option><option value="optional">Optional</option></select></div>
                                {view.permissions.canEditPrice ? <div><label htmlFor={`${prefix}-tax`} className="text-xs font-semibold">Steuer je Position</label><select id={`${prefix}-tax`} value={draftLine.taxTreatment} aria-invalid={invalidFields.has(`${prefix}-tax`) || undefined} aria-describedby={errorDescription(`${prefix}-tax`)} onChange={(event) => updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { taxTreatment: event.target.value as OfferTaxTreatment, zeroTaxConfirmed: false })} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"><option value="standard_19">19 % USt.</option><option value="zero_operator_confirmed">0 % USt. nach Prüfung</option></select>{fieldError(`${prefix}-tax`)}</div> : <div><p className="text-xs font-semibold">Steuer je Position</p><p className="mt-2 text-sm">{draftLine.taxTreatment === "standard_19" ? "19 % USt." : "0 % USt. · bestätigt"}</p></div>}
                                <div><label htmlFor={`${prefix}-target-section`} className="text-xs font-semibold">In Sektion verschieben</label><select id={`${prefix}-target-section`} value={draftSection.sectionDomainId} disabled={draftSection.lines.length <= 1 || navigationPending} aria-describedby={draftSection.lines.length <= 1 ? `${prefix}-target-section-hint` : undefined} onChange={(event) => { const target = draft.sections.find((entry) => entry.sectionDomainId === event.target.value); if (!target) return; reorderFocusLineIdRef.current = draftLine.lineDomainId; setDraft((current) => moveOfferDraftLineToSection(current, draftLine.lineDomainId, target.sectionDomainId, target.lines.length + 1)); setReorderAnnouncement(`${displayName} wurde in ${target.title} verschoben.`); }} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">{draft.sections.map((entry) => <option key={entry.sectionDomainId} value={entry.sectionDomainId}>{entry.title}</option>)}</select>{draftSection.lines.length <= 1 ? <p id={`${prefix}-target-section-hint`} className="mt-1 text-base leading-6 text-slate-600">Mindestens eine Position muss in dieser Sektion verbleiben.</p> : null}</div>
                                <label className="flex min-h-11 items-center gap-3 rounded-md border border-slate-200 px-3 text-sm font-medium"><input type="checkbox" checked={draftLine.isHidden} onChange={(event) => updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { isHidden: event.target.checked })} className="size-5 accent-emerald-700" /> Im Kundenangebot ausblenden</label>
                              </div>
                              {view.permissions.canEditPrice && needsZeroConfirmation ? <label className="mt-3 flex min-h-11 items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-base leading-6"><input id={`${prefix}-zero-confirmation`} type="checkbox" checked={draftLine.zeroTaxConfirmed} aria-invalid={invalidFields.has(`${prefix}-zero-confirmation`) || undefined} aria-describedby={errorDescription(`${prefix}-zero-confirmation`)} onChange={(event) => updateDraftLine(draftSection.sectionDomainId, draftLine.lineDomainId, { zeroTaxConfirmed: event.target.checked })} className="mt-1 size-5 accent-emerald-700" /> 0-%-Steuerentwurf für diese Position frisch bestätigen</label> : null}{fieldError(`${prefix}-zero-confirmation`)}
                              {view.permissions.canReadPurchasePrice && line ? <dl className="mt-3 grid gap-2 border-t border-slate-200 pt-3 text-xs sm:grid-cols-3"><div><dt className="text-slate-500">Einkaufspreis</dt><dd className="font-semibold tabular-nums">{formatOfferCents(line.purchasePricing?.effectiveUnitNetCents)}</dd></div><div><dt className="text-slate-500">Marge</dt><dd className="font-semibold tabular-nums">{formatOfferCents(line.computed.marginNetCents)}</dd></div><div><dt className="text-slate-500">Preisprovenienz</dt><dd className="font-semibold">VK {pricingProvenanceLabel(line.salesPricing.provenance)} · EK {pricingProvenanceLabel(line.purchasePricing?.provenance)}</dd></div></dl> : null}
                              <p className="mt-3 text-base leading-6 text-slate-600">{positionLabel(draftLine.positionType)} · Lokale Eingabe; Summen werden erst vom Server autoritativ berechnet.</p>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}

                {view.permissions.canEdit && draft.sections.length < 25 ? (
                  <button type="button" onClick={() => setDraft((current) => {
                    const sectionDomainId = crypto.randomUUID();
                    return addCustomOfferDraftSection(current, { sectionDomainId });
                  })} className="min-h-11 rounded-lg border border-dashed border-emerald-800 bg-white px-4 py-3 text-sm font-semibold text-emerald-900 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">
                    Freie Sektion hinzufügen
                  </button>
                ) : null}
              </div>

              <aside className={`${offerThemeStyles.priceSummary} hidden rounded-lg border border-slate-200 bg-white p-5 shadow-sm lg:sticky lg:top-6 lg:block`}><ServerTotals snapshot={snapshot} preview={preview} canReadPurchasePrice={view.permissions.canReadPurchasePrice} /></aside>
            </div>

            <details className={`${offerThemeStyles.priceSummary} mt-5 rounded-lg border border-slate-200 bg-white p-4 shadow-sm lg:hidden`}>
              <summary className="min-h-11 cursor-pointer py-2 font-semibold">Gespeicherte Preiszusammenfassung</summary>
              <div className="mt-3 border-t border-slate-100 pt-4"><ServerTotals snapshot={snapshot} preview={preview} canReadPurchasePrice={view.permissions.canReadPurchasePrice} /></div>
            </details>

            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              {view.permissions.canDuplicate ? (
                <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"><h2 className="font-semibold">Variante duplizieren</h2><p className="mt-1 text-base leading-6 text-slate-600">Erzeugt eine unabhängige Revision-1-Kopie des gespeicherten Stands.</p><label htmlFor="duplicate-name" className="mt-3 block text-xs font-semibold">Name der Kopie</label><div className="mt-1 flex flex-col gap-2 sm:flex-row"><input id="duplicate-name" value={duplicateName} aria-invalid={invalidFields.has("duplicate-name") || undefined} aria-describedby={errorDescription("duplicate-name")} onChange={(event) => setDuplicateName(event.target.value)} className="min-h-11 min-w-0 flex-1 rounded-md border border-slate-300 px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" /><button type="button" disabled={mutationDisabled} onClick={() => requestIntent({ label: "Variante duplizieren", execute: duplicateVariant })} className="min-h-11 rounded-md border border-slate-950 px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">Duplizieren</button></div>{fieldError("duplicate-name")}</section>
              ) : null}
              {view.permissions.canCreateBasis && view.basisInput ? (
                <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"><h2 className="font-semibold">Neue Basis</h2><p className="mt-1 text-base leading-6 text-slate-600">Kopiert eine ausdrücklich geprüfte Projekt-/Kataloggrundlage in eine neue Variante. Es wird keine Steuerwahl aus der aktiven Variante übernommen.</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><div><label htmlFor="basis-name" className="text-xs font-semibold">Variantenname</label><input id="basis-name" value={basisName} aria-invalid={invalidFields.has("basis-name") || undefined} aria-describedby={errorDescription("basis-name")} onChange={(event) => setBasisName(event.target.value)} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />{fieldError("basis-name")}</div><div><label htmlFor="basis-tax" className="text-xs font-semibold">Steuerentwurf</label><select id="basis-tax" value={basisTaxTreatment} aria-invalid={invalidFields.has("basis-tax") || undefined} aria-describedby={errorDescription("basis-tax")} onChange={(event) => { setBasisTaxTreatment(event.target.value as "" | "standard_19" | "zero_operator_confirmed"); setZeroTaxConfirmed(false); }} className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"><option value="">Bitte ausdrücklich auswählen</option><option value="standard_19">19 % USt.</option><option value="zero_operator_confirmed">0 % USt. bewusst bestätigen</option></select>{fieldError("basis-tax")}</div></div><p className="mt-2 text-base leading-6 text-slate-600">Bei 0 % ist „0-%-Steuerentwurf für diese neue Basis bestätigen“ zusätzlich erforderlich.</p>{basisTaxTreatment === "zero_operator_confirmed" ? <label className="mt-3 flex min-h-11 items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 text-base leading-6"><input id="basis-zero-confirmation" type="checkbox" checked={zeroTaxConfirmed} aria-invalid={invalidFields.has("basis-zero-confirmation") || undefined} aria-describedby={errorDescription("basis-zero-confirmation")} onChange={(event) => setZeroTaxConfirmed(event.target.checked)} className="size-5 accent-emerald-700" /> 0-%-Steuerentwurf für diese neue Basis bestätigen</label> : null}{fieldError("basis-zero-confirmation")}<button type="button" disabled={mutationDisabled} onClick={() => requestIntent({ label: "Neue Basis", execute: createNewBasis })} className="mt-3 min-h-11 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2">Neue Basis anlegen</button></section>
              ) : null}
            </div>

            <div style={{ bottom: "max(0.5rem, env(safe-area-inset-bottom))", paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }} className="sticky z-20 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white/95 p-3 shadow-lg backdrop-blur motion-reduce:backdrop-blur-none">
              <p className="text-sm font-medium" aria-live="polite">{dirty ? "Lokaler Draft: ungespeichert" : `Gespeicherte Revision ${expectedRevision}`}</p>
              <div className="flex flex-wrap gap-2"><button type="button" disabled={!dirty || navigationPending} onClick={() => { setDraft(savedDraft); setFeedback({ status: "idle" }); }} className="min-h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">Änderungen verwerfen</button><button type="button" disabled={!dirty || mutationDisabled} onClick={() => void saveDraft()} className="min-h-11 rounded-md bg-emerald-800 px-5 text-sm font-semibold text-white outline-none hover:bg-emerald-900 focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2">{pending ? "Speichert …" : "Angebotsentwurf speichern"}</button></div>
            </div>
          </fieldset>
          <p role="status" aria-live="polite" className="sr-only">{reorderAnnouncement}</p>
        </div>

        <DirtyNavigationDialog
          open={pendingIntent !== null}
          destinationLabel={pendingIntent?.label ?? "andere Aktion"}
          pending={pending}
          onStay={() => setPendingIntent(null)}
          onDiscard={() => {
            const intent = pendingIntent;
            if (!intent) return;
            setDraft(savedDraft);
            setPendingIntent(null);
            window.setTimeout(() => { void intent.execute(); }, 0);
          }}
          onSaveAndContinue={() => {
            const intent = pendingIntent;
            if (!intent) return;
            void (async () => {
              const saved = await saveDraft();
              setPendingIntent(null);
              if (saved) window.setTimeout(() => { void intent.execute(); }, 0);
            })();
          }}
          themeClassName={offerThemeStyles.offerTheme}
        />
      </main>
    </DirtyNavigationGuard>
  );
}
