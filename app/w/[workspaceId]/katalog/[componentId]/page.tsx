import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { DeniedState, DetailItem, Section } from "../../_ui";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type {
  CatalogComponentViewV1,
  CatalogProvenanceV1,
} from "@/lib/integrations/catalog/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import { getCatalogComponent, type CatalogComponentReadModel } from "@/modules/catalog";
import { ProductForm } from "../product-form";
import { LifecycleForm } from "./lifecycle-form";
import { PricingForm } from "./pricing-form";

export const metadata: Metadata = { title: "Produktdetail | Energie-SaaS" };

const routeParamsSchema = z.object({ workspaceId: z.uuid(), componentId: z.uuid() });
const typeLabels: Record<string, string> = {
  module: "PV-Modul", inverter: "Wechselrichter", battery: "Speicher",
  wallbox: "Wallbox", heat_pump: "Wärmepumpe", mounting: "Montagesystem", other: "Sonstiges",
};
const statusLabels = { draft: "Entwurf", active: "Aktiv", archived: "Archiviert" } as const;
const sourceLabels: Record<CatalogProvenanceV1["sourceKind"], string> = {
  manufacturer_datasheet: "Herstellerdatenblatt",
  supplier_price_list: "Lieferantenpreisliste",
  supplier_quote: "Lieferantenangebot",
  workspace_pricing: "Eigene Preisermittlung",
  workspace_manual: "Eigene manuelle Quelle",
  csv_import: "CSV-Import",
  customer_provided: "Vom Kunden bereitgestellt",
};
const rightsLabels: Record<CatalogProvenanceV1["rightsBasis"], string> = {
  manufacturer_published: "Vom Hersteller veröffentlicht",
  supplier_authorized: "Vom Lieferanten autorisiert",
  workspace_owned: "Workspace-eigene Daten",
  customer_provided: "Vom Kunden bereitgestellt",
};

type LoadResult =
  | { kind: "loaded"; component: CatalogComponentReadModel | null }
  | { kind: "unauthenticated" }
  | { kind: "denied" };

async function loadComponent(workspaceId: string, componentId: string): Promise<LoadResult> {
  try {
    const component = await authorizedQuery(
      workspaceId,
      "catalog.read",
      "catalog_component",
      (tx, ctx) => getCatalogComponent(tx, ctx, componentId),
    );
    return { kind: "loaded", component };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(cents / 100);
}

function capability(value: string): string {
  if (value === "known_supported") return "Nachweislich unterstützt";
  if (value === "known_unsupported") return "Nachweislich nicht unterstützt";
  return "Unbekannt";
}

function TechnicalDetails({ value }: { value: CatalogComponentViewV1["technicalData"] }) {
  if (value.schemaVersion === "module.v1") return <dl><DetailItem term="Nennleistung" numeric>{value.nominalPowerWatts.toLocaleString("de-DE")} W</DetailItem></dl>;
  if (value.schemaVersion === "inverter.v1") return <dl><DetailItem term="AC-Nennleistung" numeric>{value.nominalAcPowerWatts.toLocaleString("de-DE")} W</DetailItem><DetailItem term="Phasen" numeric>{value.phaseCount}</DetailItem><DetailItem term="MPPT-Tracker" numeric>{value.mpptTrackerCount}</DetailItem></dl>;
  if (value.schemaVersion === "battery.v1") return <dl><DetailItem term="Nominale Kapazität" numeric>{value.nominalCapacityWh.toLocaleString("de-DE")} Wh</DetailItem><DetailItem term="Nutzbare Kapazität" numeric>{value.usableCapacityWh.toLocaleString("de-DE")} Wh</DetailItem><DetailItem term="Dauerleistung" numeric>{value.maxContinuousPowerWatts.toLocaleString("de-DE")} W</DetailItem><DetailItem term="Roundtrip-Wirkungsgrad" numeric>{(value.roundTripEfficiencyBasisPoints / 100).toLocaleString("de-DE")} %</DetailItem><DetailItem term="Ersatzstrom">{capability(value.backupCapability)}</DetailItem></dl>;
  if (value.schemaVersion === "wallbox.v1") return <dl><DetailItem term="Maximale Ladeleistung" numeric>{value.maxChargingPowerWatts.toLocaleString("de-DE")} W</DetailItem><DetailItem term="Phasen" numeric>{value.phaseCount}</DetailItem><DetailItem term="Anschluss">{value.connector === "type2_cable" ? "Typ-2-Kabel" : value.connector === "type2_socket" ? "Typ-2-Dose" : "Sonstiger Anschluss"}</DetailItem><DetailItem term="Bidirektional">{capability(value.bidirectionalCapability)}</DetailItem></dl>;
  if (value.schemaVersion === "heat_pump.v1") return <dl><DetailItem term="Heiz-Nennleistung" numeric>{value.nominalHeatingPowerWatts.toLocaleString("de-DE")} W</DetailItem><DetailItem term="SCOP" numeric>{(value.scopHundredths / 100).toLocaleString("de-DE")}</DetailItem></dl>;
  if (value.schemaVersion === "mounting.v1") return <dl><DetailItem term="Systemname">{value.systemName}</DetailItem><DetailItem term="Dacharten">{value.roofTypes.join(", ")}</DetailItem></dl>;
  return <dl>{value.attributes.length > 0 ? value.attributes.map((entry) => <DetailItem key={`${entry.name}:${entry.value}`} term={entry.name}>{entry.value}</DetailItem>) : <DetailItem term="Attribute">Keine strukturierten Attribute</DetailItem>}</dl>;
}

function ProvenanceDetails({ value }: { value: CatalogProvenanceV1 }) {
  return (
    <dl>
      <DetailItem term="Quellenart">{sourceLabels[value.sourceKind]}</DetailItem>
      <DetailItem term="Referenz">{value.reference}</DetailItem>
      <DetailItem term="Beobachtet am">{new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "Europe/Berlin" }).format(new Date(`${value.observedOn}T12:00:00Z`))}</DetailItem>
      <DetailItem term="Rechtebasis">{rightsLabels[value.rightsBasis]}</DetailItem>
      <DetailItem term="Dokument-Hash"><span className="break-all font-mono text-xs">{value.sourceDocumentSha256 ?? "Nicht hinterlegt"}</span></DetailItem>
    </dl>
  );
}

export default async function CatalogComponentPage({
  params,
}: PageProps<"/w/[workspaceId]/katalog/[componentId]">) {
  const parsed = routeParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { workspaceId, componentId } = parsed.data;
  const detailPath = `/w/${workspaceId}/katalog/${componentId}`;
  const result = await loadComponent(workspaceId, componentId);
  if (result.kind === "unauthenticated") redirect(`/login?next=${encodeURIComponent(detailPath)}`);
  if (result.kind === "denied") return <DeniedState title="Dieses Produkt ist für dich nicht freigegeben." />;
  if (!result.component) notFound();
  const component = result.component;
  const current = component.current;
  const commercial = current.commercial;
  const purchasePrice = commercial && "purchasePriceNetCents" in commercial
    ? commercial.purchasePriceNetCents
    : undefined;
  const purchaseProvenance = commercial && "purchaseProvenance" in commercial
    ? commercial.purchaseProvenance
    : undefined;
  const componentState = !component.permissions.canManage
    ? "read_only"
    : component.status === "draft" && !commercial
      ? "draft_incomplete"
      : component.status === "draft" ? "draft_priced" : component.status;

  return (
    <main className="min-h-screen bg-slate-50" data-catalog-component-state={componentState}>
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <nav aria-label="Brotkrumen" className="mb-6 flex items-start justify-between gap-4">
          <Link href={`/w/${workspaceId}/katalog`} className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"><span aria-hidden="true" className="mr-2">←</span>Zurück zum Katalog</Link>
          <SignOutButton />
        </nav>

        <header className="mb-8 border-b border-slate-200 pb-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-xs font-semibold text-blue-700">{current.identity.internalSku}</p>
              <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{current.presentation.displayName}</h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">{current.presentation.manufacturer} · {current.presentation.model}</p>
            </div>
            <span className={component.status === "active" ? "rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800" : component.status === "draft" ? "rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800" : "rounded-full bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700"}>{statusLabels[component.status]}</span>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
          <div className="grid min-w-0 gap-6">
            <Section title="Identität" intro="SKU und Typ bleiben über alle Revisionen unverändert.">
              <dl>
                <DetailItem term="Interne SKU"><span className="font-mono text-xs">{current.identity.internalSku}</span></DetailItem>
                <DetailItem term="Produkttyp">{typeLabels[current.identity.componentType]}</DetailItem>
                <DetailItem term="Einheit">{current.presentation.unit === "piece" ? "Stück" : current.presentation.unit === "set" ? "Set" : "Meter"}</DetailItem>
                <DetailItem term="Produkt-ID"><span className="break-all font-mono text-xs">{current.identity.componentId}</span></DetailItem>
                <DetailItem term="Revision" numeric>{current.identity.revision}</DetailItem>
                {current.sourceSnapshotSha256 !== undefined ? (
                  <DetailItem term="Snapshot-Hash"><span className="break-all font-mono text-xs">{current.sourceSnapshotSha256}</span></DetailItem>
                ) : null}
              </dl>
            </Section>

            <Section title="Technische Daten" intro="Der aktuelle, unveränderlich versiegelte Produktstand.">
              <TechnicalDetails value={current.technicalData} />
              {current.presentation.keyPoints.length > 0 ? <ul className="mt-5 list-disc space-y-2 border-t border-slate-200 pt-5 pl-5 text-sm leading-6 text-slate-700">{current.presentation.keyPoints.map((point) => <li key={point}>{point}</li>)}</ul> : null}
            </Section>

            <Section title="Technische Provenienz"><ProvenanceDetails value={current.technicalProvenance} /></Section>

            <Section title="Assets" intro="Bilder und Datenblätter werden erst mit einer revisionssicheren Objektablage freigeschaltet.">
              <p className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">Noch keine Assetablage angebunden. Es wird deshalb kein funktionsloser Upload angeboten.</p>
            </Section>

            <Section title="Preisstand" intro="EUR netto; Umsatzsteuer wird erst am Kunden- und Angebotskontext aufgelöst.">
              {commercial ? (
                <>
                  <dl>
                    <DetailItem term="VK netto" numeric>{formatCents(commercial.salesPriceNetCents)}</DetailItem>
                    {purchasePrice !== undefined ? <DetailItem term="EK netto" numeric>{formatCents(purchasePrice)}</DetailItem> : <DetailItem term="EK netto">Für deine Rolle ausgeblendet</DetailItem>}
                    {purchasePrice !== undefined ? <DetailItem term="Marge vor weiteren Kosten" numeric>{formatCents(commercial.salesPriceNetCents - purchasePrice)}</DetailItem> : null}
                  </dl>
                  <div className="mt-5 grid gap-5 border-t border-slate-200 pt-5 lg:grid-cols-2">
                    {purchaseProvenance ? <div><h3 className="mb-2 text-sm font-semibold text-slate-950">Einkaufsquelle</h3><ProvenanceDetails value={purchaseProvenance} /></div> : null}
                    <div><h3 className="mb-2 text-sm font-semibold text-slate-950">Verkaufsquelle</h3><ProvenanceDetails value={commercial.salesProvenance} /></div>
                  </div>
                </>
              ) : <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">Noch kein vollständiger Preisstand. Das Produkt kann deshalb nicht aktiviert werden.</p>}
            </Section>

            {component.permissions.canManage && component.status !== "archived" ? (
              <Section title="Darstellung und Technik revidieren" intro="Speichern erzeugt eine neue Revision; bestehende Snapshots bleiben unangetastet."><ProductForm workspaceId={workspaceId} value={current} /></Section>
            ) : null}

            {component.permissions.canEditPrices && component.status !== "archived" ? (
              <Section title="Preisrevision erfassen"><PricingForm workspaceId={workspaceId} component={current} /></Section>
            ) : null}
          </div>

          <aside className="grid content-start gap-6 lg:sticky lg:top-6">
            <Section title="Lifecycle">
              <p className="mb-4 text-sm leading-6 text-slate-600">Aktiv ist ein Produkt nur mit vollständig belegtem Preisstand. Archivierte Produkte bleiben historisch lesbar.</p>
              <div role="note" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm leading-6 text-amber-950">Daten- oder Preisrevisionen setzen ein aktives Produkt auf Entwurf und markieren gebundene Projekte als veraltet.</div>
              {component.permissions.canManage ? <LifecycleForm workspaceId={workspaceId} componentId={component.id} revision={component.currentRevision} status={component.status} hasPricing={commercial !== null} /> : <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">Nur Lesezugriff: Status und Revisionen können nicht verändert werden.</p>}
            </Section>
          </aside>
        </div>
      </div>
    </main>
  );
}
